/**
 * DeepSeekOpenAIClient — production-grade factory for the OpenAI SDK
 * client that talks to V1 cloud's DeepSeek trusted-caller proxy at
 * `${cloudBaseUrl}/api/local/deepseek/v1/chat/completions`.
 *
 * Architecture (Slice 33 — DeepSeek as 4th provider):
 *   Aris Code never holds DeepSeek's real API key. Instead it sends
 *   the user's long-lived `local_api_key` (issued by V1 cloud after
 *   exchanging a subscription_key via `/api/local/auth`) as
 *   `Authorization: Bearer <local_api_key>`. Cloud (33i) does:
 *     verify the bearer against its own DB → user_id → balance_cents
 *     check → inject `Authorization: Bearer sk-...` from cloud `.env`
 *     → proxy to api.deepseek.com → meter usage on the way back.
 *
 *   This is the SAME bearer pattern V1 desktop Aris uses for all its
 *   cloud calls (see `main_local.py` in the ArisLLM repo) — long-
 *   lived, no 1-hour TTL, no refresh dance. Re-auth only happens if
 *   the subscription lapses or the user revokes.
 *
 *   Why not the user's Aris session key (X-Aris-Key)?
 *   The session key lives in aris_server's (POD's) `user_sessions`
 *   table. Cloud has no visibility into that table — validating
 *   X-Aris-Key would require cloud to phone the POD, which couples
 *   DeepSeek to "POD must be online." The cloud-issued local_api_key
 *   lives in cloud's own DB, so cloud validates it independently and
 *   DeepSeek runs whenever cloud is up; the POD can be cold.
 *
 *   This gives us:
 *     - DeepSeek's real API key stays server-side (per `reference_cloud_secrets`)
 *     - Per-user metering / Stripe billing on the cloud
 *     - POD-independent dispatch (Kenny's "stop POD when not testing"
 *       budget pattern keeps working)
 *
 * Three responsibilities, mirroring `ArisOpenAIClient`'s shape:
 *
 *   1. Construct an `OpenAI` client whose `baseURL` points at the
 *      cloud proxy and whose `apiKey` IS the cloud JWT. The OpenAI
 *      SDK natively sends it as `Authorization: Bearer <apiKey>` —
 *      exactly what cloud's `_verify_token` expects.
 *
 *   2. Patch `fetch` to inject per-message reasoning controls into
 *      chat-completion request bodies when the runner has set them
 *      via `setRequestReasoningEffort`. DeepSeek's wire shape for
 *      reasoning depth is `thinking: {type: "enabled"}` paired with
 *      `reasoning_effort: "high" | "max"` (see `project_deepseek_v4_api_recon`
 *      for the live recon).
 *
 *   3. Wrap streaming chat-completion responses with
 *      `wrapResponseWithReasoningInterceptor` (Slice 33b) so DeepSeek's
 *      sibling `reasoning_content` field is extracted into the dropdown
 *      UI channel before the SDK consumes the stream.
 *
 * What this file does NOT do (vs ArisOpenAIClient):
 *   - No `project_id` resolution — DeepSeek is stateless from the
 *     cloud's perspective; user_id comes from JWT claims.
 *   - No `thread_id` / `conversation_id` injection — DeepSeek doesn't
 *     model conversations server-side; multi-turn state lives entirely
 *     in the message array Aris Code sends.
 *   - No envelope handler / `ConversationIdHolder` — there are no
 *     control-plane SSE frames in DeepSeek's stream (every frame
 *     carries `choices`).
 *
 * @module DeepSeekOpenAIClient
 */
import OpenAI from "openai";

import type { DeepSeekReasoningEffort } from "@t3tools/contracts";

import {
  lookupReasoningForToolCallId,
  wrapResponseWithReasoningInterceptor,
} from "./DeepSeekStreamInterceptor.ts";

// ── Per-message reasoning-effort holder ────────────────────────────
//
// DeepSeek's reasoning depth is set per-request via two body fields:
//   - `thinking: { type: "enabled" }`  — turns on the deeper reasoning track
//   - `reasoning_effort: "high" | "max"` — depth knob inside the track
//
// The Aris Code composer carries a per-message reasoning-effort selector
// (Slice 33h ships the UI). When the user picks an effort level, the
// runner stashes it via `setRequestReasoningEffort` before `run()` and
// clears it in `finally{}` so values don't leak across turns.
//
// Module-level state mirrors `ArisStreamInterceptor`'s thinking-mode
// holder — single-tenant assumption, JS single-threaded so it's safe
// in the spike.

let currentReasoningEffort: DeepSeekReasoningEffort | undefined = undefined;

/**
 * Set the reasoning-effort value to inject into the NEXT outbound
 * chat-completions request body. Pass `undefined` to clear (cloud
 * default applies). The runner pairs `set(effort)` with
 * `set(undefined)` in a `finally{}` block.
 */
export function setRequestReasoningEffort(effort: DeepSeekReasoningEffort | undefined): void {
  currentReasoningEffort = effort;
}

/** Read the currently-set reasoning effort. Used by the fetch wrapper. */
export function getRequestReasoningEffort(): DeepSeekReasoningEffort | undefined {
  return currentReasoningEffort;
}

// ── Client factory ─────────────────────────────────────────────────

export interface CreateDeepSeekOpenAIClientOptions {
  /**
   * Cloud trusted-caller base URL — the part before `/api/local/deepseek/v1`.
   * Typically `https://youraris.com` in production. May be a staging
   * host or local FastAPI dev server during development.
   */
  readonly cloudBaseUrl: string;
  /**
   * Long-lived `local_api_key` issued by V1 cloud after exchanging a
   * subscription_key. Sent as `Authorization: Bearer <local_api_key>`
   * on every request — the OpenAI SDK does this natively when given
   * as `apiKey`. Cloud validates against its own DB (no aris_server
   * dependency).
   */
  readonly cloudToken: string;
}

/**
 * Build an `OpenAI` client preconfigured to talk to V1 cloud's DeepSeek
 * trusted-caller proxy. The returned client is suitable for passing to
 * `OpenAIChatCompletionsModel(client, modelName)`.
 *
 * Example:
 *   const client = createDeepSeekOpenAIClient({
 *     cloudBaseUrl: "https://youraris.com",
 *     cloudToken: "<local_api_key-from-cloud-/api/local/auth>",
 *   });
 *   const model = new OpenAIChatCompletionsModel(client, "deepseek-v4-pro");
 */
export function createDeepSeekOpenAIClient(opts: CreateDeepSeekOpenAIClientOptions): OpenAI {
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isChatCompletions = url.includes("/chat/completions");

    let resp: Response;
    if (isChatCompletions && init?.method === "POST" && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        applyReasoningEffortToBody(parsed, currentReasoningEffort);
        injectReasoningContentRoundtrip(parsed);
        const newInit: RequestInit = { ...init, body: JSON.stringify(parsed) };
        resp = await fetch(input, newInit);
      } catch (err) {
        // Don't fail the whole request just because we couldn't
        // inject — fall through to unmodified send. The cloud will
        // still process the request with its default reasoning depth,
        // and the OpenAI client will surface any real errors.
        console.warn(
          `[DeepSeekOpenAIClient] body inject failed, sending unmodified: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        resp = await fetch(input, init);
      }
    } else {
      resp = await fetch(input, init);
    }

    // Slice 33b — extract `reasoning_content` sibling field from
    // streaming chat-completion responses. Non-streaming and non-
    // chat-completion responses pass through unchanged.
    if (isChatCompletions) {
      return wrapResponseWithReasoningInterceptor(resp);
    }
    return resp;
  };

  return new OpenAI({
    baseURL: `${opts.cloudBaseUrl.replace(/\/+$/, "")}/api/local/deepseek/v1`,
    // The cloud-issued local_api_key IS the apiKey — OpenAI SDK sends
    // it natively as `Authorization: Bearer <apiKey>`, matching the
    // bearer pattern V1 desktop Aris uses for all cloud calls (see
    // `main_local.py` line 2018, etc). The Bearer vocabulary is fine
    // here: `feedback_no_token_vocabulary`'s "no Bearer" rule applies
    // to the aris_server perimeter, not to cloud APIs which already
    // use Bearer for their own auth.
    apiKey: opts.cloudToken,
    fetch: fetchImpl,
  });
}

// ── Body-shape helpers ─────────────────────────────────────────────

/**
 * Mutate `body` in place to set the right combination of `thinking`
 * and `reasoning_effort` for the requested depth. No-op when effort is
 * `undefined` — cloud applies its default in that case.
 *
 * Wire mapping (per `project_deepseek_v4_api_recon`):
 *   - "light" → strip any thinking/effort flags so the server defaults
 *               to baseline depth. `reasoning_content` still ships back
 *               per recon — V4-Pro is a reasoning-first model with no
 *               true off-switch, only a depth knob.
 *   - "high"  → thinking: { type: "enabled" }, reasoning_effort: "high"
 *   - "max"   → thinking: { type: "enabled" }, reasoning_effort: "max"
 *
 * Existing fields on `body` are preserved — if the runner has already
 * set `thinking` or `reasoning_effort` for some other reason we don't
 * stomp it.
 */
function applyReasoningEffortToBody(
  body: Record<string, unknown>,
  effort: DeepSeekReasoningEffort | undefined,
): void {
  if (effort === undefined) return;

  if (effort === "light") {
    // Baseline-depth mode — strip any thinking/effort flags the runner
    // may have set so the server's default reasoning depth kicks in.
    delete body.thinking;
    delete body.reasoning_effort;
    return;
  }

  // "high" or "max" — both ride the thinking track.
  const existingThinking =
    body.thinking && typeof body.thinking === "object" && !Array.isArray(body.thinking)
      ? (body.thinking as Record<string, unknown>)
      : {};
  body.thinking = {
    ...existingThinking,
    type: "enabled",
  };
  body.reasoning_effort = effort;
}

/**
 * Walk the outbound `messages` array and re-attach `reasoning_content`
 * to each assistant message that has tool_calls, looking up the cached
 * reasoning text by the first tool_call_id.
 *
 * Why this exists (DS-fix.7):
 *   DeepSeek V4 in thinking mode rejects followup requests where the
 *   prior assistant message had reasoning_content but it's missing
 *   from the resent message ("The `reasoning_content` in the thinking
 *   mode must be passed back to the API."). The OpenAI Agents SDK
 *   doesn't track reasoning_content (it's not in the OpenAI message
 *   schema), so we cache it from the response stream and re-inject it
 *   here on the way back out.
 *
 *   Cache is populated by `DeepSeekStreamInterceptor` and keyed by
 *   `tool_call_id`. We look up by the FIRST tool_call_id on each
 *   assistant message (per DeepSeek's stream order, all tool_calls in
 *   one response share the same prior reasoning block).
 *
 *   Skips silently when:
 *     - body has no messages array
 *     - assistant message has no tool_calls (final answer or pure
 *       text — no followup expected, no need to roundtrip)
 *     - cache miss (first iteration, or thinking was disabled)
 *     - assistant message already carries reasoning_content (caller
 *       already handled it)
 */
function injectReasoningContentRoundtrip(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") continue;
    if ("reasoning_content" in (msg as object)) continue;
    const toolCalls = (msg as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    const firstCall = toolCalls[0];
    if (!firstCall || typeof firstCall !== "object") continue;
    const id = (firstCall as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const cached = lookupReasoningForToolCallId(id);
    if (cached === undefined) continue;
    (msg as Record<string, unknown>).reasoning_content = cached;
  }
}
