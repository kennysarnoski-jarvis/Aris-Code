/**
 * ArisAdapterLive - Scoped live implementation for the Aris provider adapter.
 *
 * Wraps ArisLLM's OpenAI-compatible /v1/chat/completions streaming endpoint
 * behind the generic provider adapter contract and emits Aris bus events
 * (the dedicated `aris.*` event channel — Cut C).
 *
 * Architecture (post-Slice 30):
 *   - The agentic loop is owned by the OpenAI Agents SDK via
 *     `runArisAgentEffect`. This module's `runTurnStreaming` only handles
 *     the surrounding turn-lifecycle concerns (settings/project_id
 *     validation, session-state transitions, error wrapping, cancellation
 *     cleanup).
 *   - SSE parsing, `<think>` splitting, tool dispatch, and aris envelope
 *     interception live in dedicated helper modules
 *     (`ArisAgentRunner` / `ArisAgentTools` / `ArisOpenAIClient` /
 *     `ArisStreamInterceptor`) — see those files for details.
 *   - `interruptTurn` uses fiber interruption, which propagates through
 *     `Effect.tryPromise`'s AbortSignal to abort the in-flight SDK call.
 *
 * Deferred from the SDK migration (Slice 30 follow-ups):
 *   - Per-tool runtime-mode approval gating (was `approvalForTool` in
 *     ArisClientTools — needs re-implementation via SDK's needsApproval).
 *   - Rate-limit error classification (legacy parsed HTTP 429 directly;
 *     SDK errors get flattened into `provider_error`).
 *
 * @module ArisAdapterLive
 */
import {
  ApprovalRequestId,
  type ArisEvent,
  ArisToolCallId,
  type ChatAttachment,
  MessageId,
  type ProviderApprovalDecision,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Random,
  Stream,
} from "effect";

import { ArisEventBus } from "../../aris/Services/ArisEventBus.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterRateLimitError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ArisAdapter, type ArisAdapterShape } from "../Services/ArisAdapter.ts";
import { Agent, type AgentInputItem, run } from "@openai/agents";
import { OpenAIChatCompletionsModel } from "@openai/agents-openai";
import { runArisAgentEffect } from "./ArisAgentRunnerEffect.ts";
import { createArisAgentTools } from "./ArisAgentTools.ts";
// Slice M.1 / H-4B — error sanitizer is shared with the DeepSeek path
// so both providers agree on what's safe to ship to the renderer. See
// `sanitizeProviderErrorForUi` for the rationale (cap length, strip
// token/key-like substrings, single-line). Aris path was missed when
// Slice J.3 (M3-1) landed sanitization on the DeepSeek path; Slice M
// closes that parity gap.
import { sanitizeProviderErrorForUi } from "./DeepSeekAgentRunner.ts";
import {
  createArisOpenAIClient,
  makeConversationIdHolder,
  resolveProjectIdEffect,
} from "./ArisOpenAIClient.ts";
import { loadAllSkills } from "./ArisSkillsLoader.ts";
import {
  createUseSkillTool,
  type ForkExecutor,
  mapEffortToEnableThinking,
  rewriteSlashCommand,
} from "./ArisSkillsTool.ts";
import { getRequestThinkingMode, setRequestThinkingMode } from "./ArisStreamInterceptor.ts";

const PROVIDER = "aris" as const;
const DEFAULT_MODEL = "qwen-3.6";

/**
 * OpenAI-style multimodal content blocks. The user message accepts a flat
 * string OR an array of content parts so we can attach images alongside the
 * prompt. vLLM with the Qwen3.6 vision encoder consumes `image_url` parts
 * natively (`image_url.url` may be either an HTTP URL or a `data:image/...`
 * URL — we ship base64 data URLs since attachments live on the user's local
 * disk and there's no public endpoint serving them).
 */
type ArisUserContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

interface ArisSessionContext {
  session: ProviderSession;
  /**
   * Server-assigned conversation id, cached per-session. Undefined until
   * the first `{"aris":{"conversation_id":N}}` SSE header frame arrives on
   * the first turn; after that every turn carries it to resume the same
   * ArisLLM conversation row. The server owns all message history — the
   * client never ships prior turns on the wire.
   */
  conversationId: number | undefined;
  /**
   * Server-assigned project id, resolved once per session from the session
   * cwd via `/v1/projects/find-or-create`. Required on every new
   * conversation. Undefined until first resolution.
   */
  projectId: number | undefined;
  activeFiber: Fiber.Fiber<void, never> | undefined;
  stopped: boolean;
  readonly pendingApprovals: Map<ApprovalRequestId, Deferred.Deferred<ProviderApprovalDecision>>;
  /**
   * Tools the user has approved for the remainder of this session via
   * "Always allow this session". Checked before raising any further approval
   * prompt for the same tool name. Cleared when the session closes.
   */
  readonly sessionApprovedTools: Set<string>;
}

const makeArisAdapter = Effect.fn("makeArisAdapter")(function* () {
  const serverSettings = yield* ServerSettingsService;
  const arisEventBus = yield* ArisEventBus;
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* FileSystem.FileSystem;

  const sessions = new Map<ThreadId, ArisSessionContext>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /**
   * Slice 12 — Vision support. Read each image attachment from the local
   * attachment store and inline it as an OpenAI multimodal `image_url` part
   * with a base64 data URL. Returns the assembled content array (image parts
   * first, then a single text part), or `null` when there's nothing to
   * materialize so the caller can keep the legacy `content: string` shape
   * for plain-text turns. Mirrors the safety contract of Codex's
   * `materializeImageAttachments`: silently skip unresolved paths or files
   * the filesystem won't read instead of failing the whole turn.
   */
  const materializeUserContent = (
    userText: string,
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ): Effect.Effect<string | ReadonlyArray<ArisUserContentPart>, never> =>
    Effect.gen(function* () {
      if (!attachments || attachments.length === 0) {
        return userText;
      }

      const parts: Array<ArisUserContentPart> = [];
      for (const attachment of attachments) {
        if (attachment.type !== "image") continue;

        const resolvedPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!resolvedPath) continue;

        const fileInfo = yield* fileSystem
          .stat(resolvedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") continue;

        const bytes = yield* fileSystem
          .readFile(resolvedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!bytes) continue;

        const base64 = Buffer.from(bytes).toString("base64");
        parts.push({
          type: "image_url",
          image_url: { url: `data:${attachment.mimeType};base64,${base64}` },
        });
      }

      // No images survived materialization — preserve the legacy string shape
      // so we don't accidentally degrade a plain-text turn into the array
      // path (no point paying the format conversion cost when we have
      // nothing visual to send).
      if (parts.length === 0) {
        return userText;
      }

      // Always append the text part LAST so the model sees the images first
      // and the prompt second — matches the Qwen3.6 model card examples and
      // most multimodal training data layouts.
      parts.push({ type: "text", text: userText });
      return parts;
    });

  /**
   * Publish to the dedicated Aris event channel (Cut C). This is the
   * SOLE outbound path for Aris-provider events — Aris no longer touches
   * the orchestration runtime queue. Web subscribers consume via the WS
   * `aris.subscribeEvents` channel.
   */
  const publishArisEvent = (event: ArisEvent): Effect.Effect<void> => arisEventBus.publish(event);

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ArisSessionContext, ProviderAdapterError> => {
    const ctx = sessions.get(threadId);
    if (!ctx) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    if (ctx.stopped || ctx.session.status === "closed") {
      return Effect.fail(new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(ctx);
  };

  const notSupported = (operation: string, issue: string) =>
    new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue });

  const startSession: ArisAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const startedAt = yield* nowIso;
      const model =
        input.modelSelection?.provider === "aris" ? input.modelSelection.model : DEFAULT_MODEL;

      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        model,
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const ctx: ArisSessionContext = {
        session,
        conversationId: undefined,
        projectId: undefined,
        activeFiber: undefined,
        stopped: false,
        pendingApprovals: new Map(),
        sessionApprovedTools: new Set(),
      };
      sessions.set(input.threadId, ctx);

      const sessionStartedAt = yield* nowIso;
      yield* publishArisEvent({
        type: "aris.session.started",
        threadId: input.threadId,
        createdAt: sessionStartedAt,
        payload: {},
      });

      return session;
    },
  );

  // ── SDK-driven turn streaming ────────────────────────────────────
  //
  // Delegates the agentic loop to the OpenAI Agents SDK via
  // `runArisAgentEffect`, and only handles the surrounding
  // turn-lifecycle concerns:
  //   - settings + project_id validation
  //   - building the per-session OpenAI client + Agent
  //   - emitting `aris.turn.started` / `aris.turn.completed` (the
  //     runner skips these because we set `manageTurnLifecycle: false`)
  //   - error wrapping in the catch
  //   - cancellation cleanup in onInterrupt
  //
  // Streaming events (assistant.delta, tool.started/completed,
  // assistant.message.completed, thread.persisted, compaction.*,
  // memory.changed) are all emitted from inside the runner — no
  // `<think>` parser or envelope-frame logic lives here.
  //
  // History (Slices 25-30): replaces the original 1100+ line custom
  // for-loop that hand-rolled SSE parsing, tool dispatch, `<think>`
  // splitting, aris envelope-frame interception, MAX_TOOL_ITERATIONS
  // capping, and per-tool dedup. All of that is now either in the
  // SDK itself or in dedicated helper modules
  // (ArisAgentRunner / ArisAgentTools / ArisOpenAIClient /
  // ArisStreamInterceptor).
  const runTurnStreaming = (
    ctx: ArisSessionContext,
    turnId: TurnId,
    userText: string,
    modelOverride: string | undefined,
    attachments: ReadonlyArray<ChatAttachment> | undefined,
    enableThinking: boolean | undefined,
  ) => {
    let arisAssistantMessageCount = 0;

    const main = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.map((s) => s.providers.aris),
        Effect.orDie,
      );

      if (!settings.baseUrl) {
        const createdAt = yield* nowIso;
        yield* publishArisEvent({
          type: "aris.error",
          threadId: ctx.session.threadId,
          turnId,
          createdAt,
          payload: {
            code: "validation_error",
            message: "Aris base URL is not configured.",
            recoverable: true,
          },
        });
        return;
      }

      if (!settings.apiKey || settings.apiKey.length === 0) {
        const createdAt = yield* nowIso;
        yield* publishArisEvent({
          type: "aris.error",
          threadId: ctx.session.threadId,
          turnId,
          createdAt,
          payload: {
            code: "permission_error",
            message: "Aris is not signed in. Sign in from Aris Code settings.",
            recoverable: true,
          },
        });
        return;
      }

      // Resolve project_id once per session.
      if (ctx.projectId === undefined) {
        const cwd = ctx.session.cwd;
        if (!cwd) {
          const createdAt = yield* nowIso;
          yield* publishArisEvent({
            type: "aris.error",
            threadId: ctx.session.threadId,
            turnId,
            createdAt,
            payload: {
              code: "validation_error",
              message: "Aris requires a project folder. Open a folder first.",
              recoverable: true,
            },
          });
          return;
        }
        ctx.projectId = yield* resolveProjectIdEffect({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          cwd,
        });
      }

      // Build the OpenAI client + Agent for this turn. The
      // conversation-id holder bridges the envelope handler (writes)
      // with the fetch wrapper (reads on the next request body).
      const conversationIdHolder = makeConversationIdHolder();
      if (typeof ctx.conversationId === "number") {
        conversationIdHolder.current = ctx.conversationId;
      }
      const openaiClient = createArisOpenAIClient({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        projectId: ctx.projectId,
        threadId: ctx.session.threadId,
        conversationIdHolder,
      });
      const arisTools = createArisAgentTools({ cwd: ctx.session.cwd });

      // Slice 32b — discover user-authored skills under `.aris/skills/`
      // and register the `use_skill` tool when any are present. Loaded
      // once per turn (cheap disk scan: O(N) files where N is the
      // user's skills count, which is typically <20). The loader is
      // contractually non-rejecting — every fs failure is captured as
      // a SkillLoadError in the result — so `Effect.promise` is safe.
      // We log the per-file errors but don't propagate them; a single
      // malformed SKILL.md shouldn't take Aris offline.
      const skillsResult = yield* Effect.promise(() =>
        loadAllSkills({ workspaceRoot: ctx.session.cwd }),
      );
      if (skillsResult.errors.length > 0) {
        yield* Effect.logWarning("Some skills failed to load", {
          errors: skillsResult.errors.map((e) => `${e.path}: ${e.message}`),
        });
      }
      const modelName = modelOverride ?? DEFAULT_MODEL;

      // Slice 32e — fork-mode executor. When a skill declares
      // `context: fork`, the use_skill tool delegates here instead of
      // returning the rendered body to the parent. We spin up a fresh
      // sub-agent with:
      //   - The rendered body as `instructions` (system prompt).
      //   - A FRESH `ConversationIdHolder` so aris-server starts a
      //     new conversation row — no parent-history pollution and
      //     no risk of cross-contaminating the parent's KV cache.
      //   - The parent's tool factory result, filtered through the
      //     skill's `allowed-tools` list when present. The use_skill
      //     tool itself is intentionally NOT registered on the
      //     sub-agent: nested skills via fork are a deeper feature
      //     (potential infinite recursion risk) and out of 32e
      //     scope. Skills that want to compose can do it inline.
      //
      // The sub-agent's events (deltas, tool calls) are NOT bridged
      // to the parent's UI bus in this slice — the sub-agent runs
      // opaquely and the parent only sees a single `use_skill` tool
      // call with whatever finalOutput we return. UI bridging would
      // be a follow-up if the opaque experience proves too coarse.
      // Capture branded/optional fields into locals so the closure
      // doesn't have to re-narrow them on each invocation. The parent
      // agent's openaiClient already uses these same values; we
      // recapture rather than reuse so each fork can have its own
      // ConversationIdHolder.
      const forkProjectId = ctx.projectId;
      const forkThreadId = ctx.session.threadId;
      const forkBaseUrl = settings.baseUrl;
      const forkApiKey = settings.apiKey;
      const forkExecutor: ForkExecutor = async (input) => {
        const allowed = input.skill.frontmatter.allowedTools;
        const subAgentTools =
          allowed && allowed.length > 0
            ? arisTools.filter((t) => allowed.includes(t.name))
            : arisTools;

        const subHolder = makeConversationIdHolder();
        const subClient = createArisOpenAIClient({
          baseUrl: forkBaseUrl,
          apiKey: forkApiKey,
          projectId: forkProjectId,
          threadId: forkThreadId,
          conversationIdHolder: subHolder,
        });

        // Slice 32f — per-skill model + effort overrides. Both apply
        // ONLY in fork mode; inline mode silently ignores them
        // (documented in ArisSkillsTool's module docstring). Model is
        // a per-Agent-construction concern. Effort maps to the
        // chat-template `enable_thinking` kwarg via the request-mode
        // module state in ArisStreamInterceptor.
        const subModelName = input.skill.frontmatter.model ?? modelName;
        const subThinking = mapEffortToEnableThinking(input.skill.frontmatter.effort);

        const subAgent = new Agent({
          name: `Aris.Skill.${input.skill.name}`,
          instructions: input.renderedBody,
          model: new OpenAIChatCompletionsModel(subClient, subModelName),
          tools: subAgentTools,
        });

        // Save-and-restore the request-thinking-mode global so the
        // parent's value isn't stomped when the fork returns. The
        // parent's runner sets the mode at the top of its `run()`
        // and clears in finally; nested fork dispatch sits inside
        // that window, so we have to put back what was there before
        // — clearing to undefined would un-thinking the parent's
        // remaining iterations.
        const previousThinking = getRequestThinkingMode();
        if (subThinking !== undefined) {
          setRequestThinkingMode(subThinking);
        }
        try {
          // Trigger user message is intentionally minimal — the
          // body is already in `instructions`, so the sub-agent has
          // all the context it needs. The trigger just kicks off
          // generation.
          const result = await run(subAgent, "Begin executing the skill workflow.");
          const finalOutput = result.finalOutput;
          if (finalOutput == null) {
            return `Skill '${input.skill.name}' completed with no final output.`;
          }
          return typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput);
        } finally {
          if (subThinking !== undefined) {
            setRequestThinkingMode(previousThinking);
          }
        }
      };

      // Slice 32g — shell expansion in skill bodies. Default OFF for
      // safety (see security model in ArisSkillsShellExpansion). User
      // opts in via env var until the settings screen gets a
      // dedicated control (deferred — would need contracts +
      // serverSettings + UI changes spanning more files than this
      // slice should touch).
      const shellExpansionEnabled = ((): boolean => {
        const raw = process.env["ARIS_SHELL_EXPANSION"]?.trim().toLowerCase();
        return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
      })();

      const useSkillTool = createUseSkillTool({
        skills: skillsResult.skills,
        forkExecutor,
        shellExpansion: {
          enabled: shellExpansionEnabled,
          cwd: ctx.session.cwd ?? process.cwd(),
        },
      });
      const tools = useSkillTool ? [...arisTools, useSkillTool] : arisTools;
      const agent = new Agent({
        name: "Aris",
        // System prompt is constructed server-side by `aris_server`
        // from ARIS_PERSONA + ARIS_MEMORY_RULES + per-session
        // entrypoint/scratchpad/todos/graph context. Empty here.
        instructions: "",
        model: new OpenAIChatCompletionsModel(openaiClient, modelName),
        tools,
      });

      // Materialize multimodal content if attachments are present.
      // For text-only turns this returns the plain string. For
      // image-bearing turns it returns content parts; we wrap them
      // in a single user message for the SDK's input items shape.
      // The cast bypasses `AgentInputItem`'s union discrimination —
      // at runtime the shape matches the user-role variant exactly,
      // but TS can't see through the union without painful narrowing
      // for our internal infrastructure code.
      // Slice 32h — slash-command dispatch. If the user's message
      // starts with `/skillname`, rewrite it into the rendered skill
      // body before we materialize content for the SDK. The model
      // sees the expanded prompt as the user's input — no autonomous
      // decision required, no use_skill round-trip. Slash dispatch
      // is always inline; `context: fork` is honored only when the
      // model invokes use_skill itself. Returns null when there's no
      // slash prefix or when the named skill isn't loaded, in which
      // case the original text passes through unchanged.
      const slashRewrite = yield* Effect.promise(() =>
        rewriteSlashCommand({
          text: userText,
          skills: skillsResult.skills,
          shellExpansion: {
            enabled: shellExpansionEnabled,
            cwd: ctx.session.cwd ?? process.cwd(),
          },
        }),
      );
      const effectiveUserText = slashRewrite ? slashRewrite.text : userText;

      const userContent = yield* materializeUserContent(effectiveUserText, attachments);
      const sdkInput: string | AgentInputItem[] =
        typeof userContent === "string"
          ? userContent
          : ([
              {
                role: "user",
                content: userContent,
              },
            ] as unknown as AgentInputItem[]);

      const userMessageId = MessageId.make(`user:${turnId}`);
      const startedAt = yield* nowIso;
      yield* publishArisEvent({
        type: "aris.turn.started",
        threadId: ctx.session.threadId,
        turnId,
        createdAt: startedAt,
        payload: { userMessageId, runtimeMode: ctx.session.runtimeMode },
      });

      const result = yield* runArisAgentEffect({
        agent,
        prompt: sdkInput,
        threadId: ctx.session.threadId,
        turnId,
        userMessageId,
        runtimeMode: ctx.session.runtimeMode,
        publish: publishArisEvent,
        // We own the turn lifecycle (started/completed/failed) so we
        // can do error classification before publishing turn.failed.
        manageTurnLifecycle: false,
        onConversationIdReceived: (cid) => {
          ctx.conversationId = cid;
          conversationIdHolder.current = cid;
        },
        // Slice 31 — per-message Thinking toggle from sendTurn input.
        // `undefined` lets server apply its default (currently True).
        ...(enableThinking !== undefined ? { enableThinking } : {}),
      });
      arisAssistantMessageCount = result.messageCount;

      const completedAt = yield* nowIso;
      yield* publishArisEvent({
        type: "aris.turn.completed",
        threadId: ctx.session.threadId,
        turnId,
        createdAt: completedAt,
        payload: { messageCount: arisAssistantMessageCount },
      });

      const idleAt = yield* nowIso;
      ctx.session = {
        ...ctx.session,
        status: "ready",
        activeTurnId: undefined,
        updatedAt: idleAt,
      };
      ctx.activeFiber = undefined;
      console.error(
        `[ArisAdapter Slice30c] TURN COMPLETE — session=ready turnId=${turnId} messageCount=${arisAssistantMessageCount}`,
      );
    });

    return main.pipe(
      Effect.catch((err) =>
        Effect.gen(function* () {
          // The runner wraps SDK errors as `ProviderAdapterRequestError`,
          // so rate-limit specialization (which the legacy fetch did
          // by inspecting HTTP 429 directly) is currently flattened
          // into the generic provider-error path. A follow-up slice
          // can restore rate-limit detection by inspecting the SDK's
          // own error types inside the runner. For now: every SDK
          // failure becomes `aris.error` + `aris.turn.failed`.
          //
          // Slice 30h diagnostic: surface the error in bun-dev so we
          // can see WHEN SDK throws happen. Without this the catch
          // path is silent — the user sees the turn end with no
          // closing message and no clue what went wrong.
          console.error(
            `[ArisAdapter Slice30c] CATCH — turnId=${turnId} ` +
              `errorTag=${err._tag ?? "<none>"} ` +
              `detail=${JSON.stringify(err.message ?? String(err)).slice(0, 300)}`,
          );
          const failedAt = yield* nowIso;
          // Slice M.1 / H-4B — sanitize before publishing to UI bus.
          // Bind once and reuse across both publishes so both events
          // ship the same redacted string. Mirrors the DeepSeek path
          // at DeepSeekAdapter.ts (see Slice J.3 / M3-1).
          const safeMessage = sanitizeProviderErrorForUi(err.message);
          yield* publishArisEvent({
            type: "aris.error",
            threadId: ctx.session.threadId,
            turnId,
            createdAt: failedAt,
            payload: {
              code: "provider_error",
              message: safeMessage,
              recoverable: false,
            },
          });
          yield* publishArisEvent({
            type: "aris.turn.failed",
            threadId: ctx.session.threadId,
            turnId,
            createdAt: failedAt,
            payload: { errorMessage: safeMessage },
          });
          const idleAt = yield* nowIso;
          ctx.session = {
            ...ctx.session,
            status: "error",
            activeTurnId: undefined,
            updatedAt: idleAt,
          };
          ctx.activeFiber = undefined;
          ctx.pendingApprovals.clear();
        }),
      ),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          // Slice 30h diagnostic — surface interrupts the same way
          // we surface caught errors, so cancelled turns aren't
          // confused with crashed turns in the bun-dev tail.
          console.error(`[ArisAdapter Slice30c] CANCELLED — turnId=${turnId}`);
          const cancelledAt = yield* nowIso;
          yield* publishArisEvent({
            type: "aris.turn.cancelled",
            threadId: ctx.session.threadId,
            turnId,
            createdAt: cancelledAt,
            payload: { reason: "user_aborted" },
          });
          ctx.session = { ...ctx.session, activeTurnId: undefined };
          ctx.activeFiber = undefined;
          ctx.pendingApprovals.clear();
        }),
      ),
    );
  };

  const sendTurn: ArisAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const ctx = yield* requireSession(input.threadId);

    // Slice 12 — Vision: a turn must carry SOMETHING — either a non-empty
    // text prompt OR at least one attachment. Pure-image turns are valid
    // (the model card shows examples like "image attached, no caption" →
    // model describes what it sees), so we only reject when both channels
    // are empty.
    const trimmedInput = input.input?.trim() ?? "";
    const hasAttachments = (input.attachments?.length ?? 0) > 0;
    if (trimmedInput.length === 0 && !hasAttachments) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Aris requires non-empty text input or at least one attachment.",
      });
    }

    const modelSelection =
      input.modelSelection?.provider === "aris" ? input.modelSelection : undefined;
    if (modelSelection?.model) {
      ctx.session = { ...ctx.session, model: modelSelection.model };
    }

    const turnId = TurnId.make(yield* Random.nextUUIDv4);
    const updatedAt = yield* nowIso;
    ctx.session = {
      ...ctx.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt,
    };

    const fiber = yield* runTurnStreaming(
      ctx,
      turnId,
      trimmedInput,
      modelSelection?.model,
      input.attachments,
      input.enableThinking,
    ).pipe(Effect.forkChild);
    ctx.activeFiber = fiber;

    return {
      threadId: ctx.session.threadId,
      turnId,
    };
  });

  const interruptTurn: ArisAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const ctx = yield* requireSession(threadId);
      const fiber = ctx.activeFiber;
      if (fiber) {
        ctx.activeFiber = undefined;
        yield* Fiber.interrupt(fiber);
      }
    },
  );

  const respondToRequest: ArisAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "v1/chat/completions/respondToRequest",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      ctx.pendingApprovals.delete(requestId);
      yield* Deferred.succeed(pending, decision);
    },
  );

  const respondToUserInput: ArisAdapterShape["respondToUserInput"] = (threadId) =>
    Effect.fail(
      notSupported(
        "respondToUserInput",
        `Aris does not issue user-input requests (thread ${threadId}).`,
      ),
    );

  const stopSessionInternal = (ctx: ArisSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      const fiber = ctx.activeFiber;
      ctx.activeFiber = undefined;
      if (fiber) {
        yield* Fiber.interrupt(fiber);
      }
      const updatedAt = yield* nowIso;
      ctx.session = { ...ctx.session, status: "closed", updatedAt };
      sessions.delete(ctx.session.threadId);

      const endedAt = yield* nowIso;
      yield* publishArisEvent({
        type: "aris.session.ended",
        threadId: ctx.session.threadId,
        createdAt: endedAt,
        payload: { reason: "user_closed" },
      });
    });

  const stopSession: ArisAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const ctx = sessions.get(threadId);
      if (!ctx) return;
      yield* stopSessionInternal(ctx);
    },
  );

  const listSessions: ArisAdapterShape["listSessions"] = () =>
    Effect.sync(() =>
      Array.from(sessions.values())
        .filter((c) => !c.stopped)
        .map((c) => c.session),
    );

  const hasSession: ArisAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const ctx = sessions.get(threadId);
      return ctx !== undefined && !ctx.stopped;
    });

  const readThread: ArisAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      return {
        threadId: ctx.session.threadId,
        turns: [],
      };
    });

  const rollbackThread: ArisAdapterShape["rollbackThread"] = (threadId) =>
    Effect.fail(
      notSupported("rollbackThread", `Aris does not support rollback (thread ${threadId}).`),
    );

  const stopAll: ArisAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
      discard: true,
    });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
      discard: true,
    }),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    // Cut C, slice 3e-iv-b-ii — the orchestration runtime queue is dead.
    // Aris no longer flows through `ProviderService.streamEvents` /
    // `ProviderRuntimeIngestion`; consumers use `ArisEventBus` directly.
    // Returning an empty stream satisfies the `ProviderAdapterShape`
    // contract while signalling "no orchestration events from Aris."
    //
    // Slice 9.15 attempted to restore this path to fix chat timeline
    // alternation, but it caused a worse regression: messages
    // disappeared on turn-settle because of orchestration vs DB
    // reconciliation conflicts. Reverted 2026-05-06. The original
    // "all-my-messages-then-all-hers" rendering pattern is the
    // accepted trade for messages persisting reliably. Future fixes
    // for alternation should target the chat timeline's reconciliation
    // logic (MessagesTimeline.tsx) rather than emitting parallel
    // events from this adapter.
    get streamEvents() {
      return Stream.empty;
    },
  } satisfies ArisAdapterShape;
});

export const ArisAdapterLive = Layer.effect(ArisAdapter, makeArisAdapter());
