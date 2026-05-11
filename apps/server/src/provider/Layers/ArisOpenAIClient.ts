/**
 * ArisOpenAIClient — production-grade factory for the OpenAI SDK
 * client that talks to `aris_server`.
 *
 * Replaces the Slice 25 inline `arisInjectingFetch` in the spike.
 * Two responsibilities:
 *
 *   1. Resolve `project_id` for the active session by calling
 *      `POST /v1/projects/find-or-create` against `session.cwd`.
 *      Mirrors the existing ArisAdapter logic (around line 473) so
 *      Slice 30c can drop the inline call.
 *
 *   2. Build a fully-wired `OpenAI` client whose `fetch` is patched
 *      to:
 *        - Inject `project_id`, `thread_id`, `conversation_id` into
 *          chat-completion request bodies (aris_server requires these
 *          alongside the standard OpenAI fields).
 *        - Wrap chat-completion responses with the envelope
 *          interceptor from Slice 29 so `aris.*` control-plane SSE
 *          frames are pulled out before the SDK sees them.
 *
 * Conversation-id lifecycle:
 *   The first turn of a session sends `conversation_id: null`.
 *   `aris_server` responds with an envelope frame
 *   `data: {"aris": {"conversation_id": N}}`. The Slice 29 envelope
 *   handler (registered by ArisAgentRunner) writes that N into a
 *   `ConversationIdHolder` whose `current` field is shared with the
 *   fetch wrapper. Subsequent turns in the same session send N back
 *   so the server can resume turn state.
 *
 *   The holder pattern is chosen because the OpenAI client's `fetch`
 *   is set once at construction. We can't easily swap fetches
 *   per-turn, but we CAN have the fetch read from a mutable holder
 *   each call. The runner clears the envelope handler in its
 *   finally{}, so handler→holder writes don't leak across turns.
 *
 * @module ArisOpenAIClient
 */
import { Effect } from "effect";
import OpenAI from "openai";

import { ProviderAdapterRequestError } from "../Errors.ts";

import {
  getRequestThinkingMode,
  wrapResponseWithEnvelopeInterceptor,
} from "./ArisStreamInterceptor.ts";

const PROVIDER = "aris";

// ── Conversation-id holder ─────────────────────────────────────────

/**
 * Mutable holder for the per-session `conversation_id`. The fetch
 * wrapper reads `current` on each request; the envelope handler
 * (in ArisAgentRunner) writes it on the first frame of a new
 * conversation.
 */
export interface ConversationIdHolder {
  current: number | null;
}

/** Convenience constructor — starts at null (new conversation). */
export const makeConversationIdHolder = (): ConversationIdHolder => ({ current: null });

// ── Project-id resolution ──────────────────────────────────────────

export interface ResolveProjectIdOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly cwd: string;
}

/**
 * Resolve a session's `project_id` via `POST /v1/projects/find-or-create`.
 * Server creates a project row for an unknown `root_dir`, or returns
 * the existing one's id. Idempotent.
 *
 * Response shape from aris_server: `{ project: { id: number, ... } }`.
 */
export const resolveProjectIdEffect = (
  opts: ResolveProjectIdOptions,
): Effect.Effect<number, ProviderAdapterRequestError> =>
  Effect.tryPromise({
    try: async (signal: AbortSignal): Promise<number> => {
      const url = `${opts.baseUrl.replace(/\/+$/, "")}/v1/projects/find-or-create`;
      const resp = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Aris-Key": opts.apiKey,
        },
        body: JSON.stringify({ root_dir: opts.cwd }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => resp.statusText);
        throw new Error(`Aris project lookup ${resp.status}: ${detail.slice(0, 500)}`);
      }
      const data = (await resp.json()) as { project?: { id?: number } };
      const pid = data?.project?.id;
      if (typeof pid !== "number" || pid < 1) {
        throw new Error("Aris project lookup returned no project id");
      }
      return pid;
    },
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "v1/projects/find-or-create",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

// ── Client factory ─────────────────────────────────────────────────

export interface CreateArisOpenAIClientOptions {
  /** aris_server base URL — the part before `/v1`. */
  readonly baseUrl: string;
  /** Session key (X-Aris-Key value). */
  readonly apiKey: string;
  /** Resolved project id for this session. */
  readonly projectId: number;
  /** Orchestration thread id (already brand-stringified by caller). */
  readonly threadId: string;
  /**
   * Mutable holder for the conversation_id. Caller is responsible
   * for keeping `current` in sync (typically via the envelope handler
   * registered by ArisAgentRunner). Fetch wrapper reads it on each
   * chat-completion request.
   */
  readonly conversationIdHolder: ConversationIdHolder;
}

/**
 * Build an `OpenAI` client preconfigured to talk to `aris_server`
 * with the right auth header, body injection, and response stream
 * interception. The returned client is suitable for passing to
 * `OpenAIChatCompletionsModel(client, modelName)`.
 */
export function createArisOpenAIClient(opts: CreateArisOpenAIClientOptions): OpenAI {
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isChatCompletions = url.includes("/v1/chat/completions");

    let resp: Response;
    if (isChatCompletions && init?.method === "POST" && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        parsed.project_id = opts.projectId;
        parsed.thread_id = opts.threadId;
        parsed.conversation_id = opts.conversationIdHolder.current;
        // Slice 31 — inject per-message thinking toggle when set by the
        // runner. `undefined` means the user didn't flip the toggle for
        // this message, so we leave chat_template_kwargs unset and the
        // server applies its default (currently True).
        const thinkingMode = getRequestThinkingMode();
        if (thinkingMode !== undefined) {
          const existing =
            parsed.chat_template_kwargs &&
            typeof parsed.chat_template_kwargs === "object" &&
            !Array.isArray(parsed.chat_template_kwargs)
              ? (parsed.chat_template_kwargs as Record<string, unknown>)
              : {};
          parsed.chat_template_kwargs = {
            ...existing,
            enable_thinking: thinkingMode,
          };
        }
        const newInit: RequestInit = { ...init, body: JSON.stringify(parsed) };
        resp = await fetch(input, newInit);
      } catch (err) {
        // Don't fail the whole request just because we couldn't
        // inject — fall through to unmodified send. aris_server
        // will reject with 400 if project_id was actually missing,
        // and the OpenAI client will surface that to the caller.
        console.warn(
          `[ArisOpenAIClient] body inject failed, sending unmodified: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        resp = await fetch(input, init);
      }
    } else {
      resp = await fetch(input, init);
    }

    // Slice 29 — strip aris envelope frames from streaming chat
    // completion responses. Non-streaming and non-chat-completion
    // responses pass through unchanged.
    if (isChatCompletions) {
      return wrapResponseWithEnvelopeInterceptor(resp);
    }
    return resp;
  };

  return new OpenAI({
    baseURL: `${opts.baseUrl.replace(/\/+$/, "")}/v1`,
    // aris_server uses X-Aris-Key, not standard Bearer. The OpenAI
    // client requires SOMETHING for `apiKey` to construct, so we
    // pass a sentinel and override the actual auth via
    // defaultHeaders.
    apiKey: "ignored-by-aris-server",
    defaultHeaders: {
      "X-Aris-Key": opts.apiKey,
    },
    fetch: fetchImpl,
  });
}
