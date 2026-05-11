/**
 * DeepSeekAdapterLive — Scoped live implementation for the DeepSeek
 * provider adapter.
 *
 * Wraps V1 cloud's `/api/local/deepseek/v1/chat/completions`
 * trusted-caller proxy behind the generic provider adapter contract
 * and emits Aris bus events (the same `aris.*` event channel the UI
 * already consumes from `ArisEventBus`).
 *
 * Architecture (Slice 33f):
 *   - The agentic loop is owned by the OpenAI Agents SDK via
 *     `runDeepSeekAgentEffect` (Slice 33e). This module's
 *     `runTurnStreaming` only handles the surrounding turn-lifecycle
 *     concerns: settings validation, building the per-turn OpenAI
 *     client + Agent, error wrapping, cancellation cleanup.
 *   - Body injection (X-Aris-Key, reasoning effort), SSE
 *     `reasoning_content` extraction, and tool dispatch live in
 *     dedicated helper modules (`DeepSeekOpenAIClient`,
 *     `DeepSeekStreamInterceptor`, `DeepSeekAgentTools`,
 *     `DeepSeekAgentRunner`).
 *
 * What's intentionally NOT here vs ArisAdapter (deferred to follow-ups):
 *   - **Vision support**: DeepSeek V4-Pro is text-only per the recon
 *     memory (no image input). If V4-Pro adds vision later, port the
 *     `materializeUserContent` block from `ArisAdapter`.
 *   - **Project/conversation IDs**: DeepSeek is stateless from the
 *     cloud's perspective; multi-turn state lives in the message array
 *     Aris Code sends.
 *
 *   - **Pending approvals / sessionApprovedTools**: kept the data
 *     structure for parity with the AdapterShape contract, but
 *     DeepSeek's tools don't currently raise approval prompts — the
 *     map stays empty. When/if approval gating ships across providers
 *     this slot is already wired.
 *
 * Skills:
 *   DeepSeek reads from the SAME `.aris/skills/` directory the user
 *   already populates for Aris — author once, both providers see the
 *   skill. Slash-command dispatch (`/skillname`), the `use_skill`
 *   tool, fork-mode sub-agents, and shell expansion all work
 *   identically. The only DeepSeek-specific piece is
 *   `mapEffortToReasoningEffort` (see helper below), which translates
 *   the skill's `effort:` frontmatter into DeepSeek's three-level
 *   reasoning depth instead of Aris's binary `enable_thinking`. The
 *   shell-expansion env-var stays `ARIS_SHELL_EXPANSION` because
 *   "Aris Code" is the product brand — flipping it on enables shell
 *   substitution for skills regardless of which provider runs them.
 *
 * Auth source:
 *   DeepSeek dispatches use a long-lived `local_api_key`
 *   (`settings.providers.deepseek.cloudToken`), obtained by exchanging
 *   a `subscription_key` via V1 cloud's `/api/local/auth` endpoint —
 *   the same activation pattern V1 desktop Aris uses
 *   (`main_local.py:2824`). The bearer is sent as
 *   `Authorization: Bearer <local_api_key>` and validated by cloud
 *   against its own DB (no aris_server dependency). This intentionally
 *   does NOT reuse `providers.aris.apiKey` — that key lives in
 *   aris_server's (POD's) `user_sessions` table, so reusing it would
 *   couple DeepSeek to "POD must be online" and break Kenny's "stop
 *   POD when not testing" budget pattern. The cloud-issued bearer
 *   keeps DeepSeek POD-independent — cloud is always-on, POD can be
 *   cold all day. No 1-hour TTL; re-auth only if the subscription
 *   lapses or the user revokes.
 *
 * @module DeepSeekAdapterLive
 */
import {
  ApprovalRequestId,
  type ArisEvent,
  type ArisToolCallId,
  type DeepSeekReasoningEffort,
  MessageId,
  type ProviderApprovalDecision,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { randomUUID } from "node:crypto";
import { DateTime, Deferred, Effect, Fiber, Layer, Random, Stream } from "effect";

import { ArisEventBus } from "../../aris/Services/ArisEventBus.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { DeepSeekAdapter, type DeepSeekAdapterShape } from "../Services/DeepSeekAdapter.ts";
import { Agent, type RunToolApprovalItem, run } from "@openai/agents";
import { OpenAIChatCompletionsModel } from "@openai/agents-openai";
import { runDeepSeekAgentEffect } from "./DeepSeekAgentRunnerEffect.ts";
import { createDeepSeekAgentTools } from "./DeepSeekAgentTools.ts";
import {
  createDeepSeekOpenAIClient,
  getRequestReasoningEffort,
  setRequestReasoningEffort,
} from "./DeepSeekOpenAIClient.ts";
import { loadAllSkills } from "./ArisSkillsLoader.ts";
import { createUseSkillTool, type ForkExecutor, rewriteSlashCommand } from "./ArisSkillsTool.ts";
import {
  appendToActiveWindow,
  readActiveWindow,
  RollingWindowIOError,
  toRollingWindowIOError,
  tryRollover,
} from "./RollingWindowMemory.ts";
import {
  findLatestSummaryPath,
  generateRolloverSummaryBackground,
  readSummary,
} from "./DeepSeekRolloverSummary.ts";
import { readScratchpad, ScratchpadIOError, toScratchpadIOError } from "./ScratchpadMemory.ts";
import { readTodos, renderOpenTodos, TodosIOError, toTodosIOError } from "./TodosMemory.ts";
import { FactsIOError, readFacts, renderFacts, toFactsIOError } from "./FactsMemory.ts";
import type { AgentInputItem } from "@openai/agents";

const PROVIDER = "deepseek" as const;

/**
 * Build a one-line human-readable summary of a tool call for the
 * approval-prompt UI. Picks per-tool fields when known so the user
 * sees the most decision-relevant info; falls back to a JSON preview
 * for unknown tools.
 */
function buildApprovalSummary(
  toolName: string,
  args: Record<string, unknown>,
  argsRaw: string,
): string {
  if (toolName === "bash") {
    const cmd = typeof args["command"] === "string" ? args["command"] : "<no command>";
    return `bash: ${cmd.length > 200 ? cmd.slice(0, 200) + "…" : cmd}`;
  }
  if (toolName === "write_file") {
    const path = typeof args["path"] === "string" ? args["path"] : "<no path>";
    const contentLen = typeof args["content"] === "string" ? (args["content"] as string).length : 0;
    return `write_file: ${path} (${contentLen} bytes)`;
  }
  if (toolName === "edit_file") {
    const path = typeof args["path"] === "string" ? args["path"] : "<no path>";
    const search = typeof args["search"] === "string" ? args["search"] : "";
    const preview = search.length > 80 ? search.slice(0, 80) + "…" : search;
    return `edit_file: ${path} — replace ${JSON.stringify(preview)}`;
  }
  const argsPreview = argsRaw.length > 200 ? argsRaw.slice(0, 200) + "…" : argsRaw;
  return `${toolName}: ${argsPreview}`;
}
const DEFAULT_MODEL = "deepseek-v4-pro";

/**
 * Map a skill's `effort:` frontmatter value to a DeepSeek reasoning
 * effort. Skill authors use the same string vocabulary across
 * providers (per `mapEffortToEnableThinking` in `ArisSkillsTool`),
 * we just translate to DeepSeek's 3-level scale instead of Aris's
 * binary `enable_thinking`.
 *
 *   max | maximum | ultra                          → "max"
 *   high | medium | thinking | on | yes | true     → "high"
 *   low | minimal | off | no | false | light       → "light"
 *   anything else (or undefined)                   → undefined (cloud default)
 *
 * Note: "off"/"no"/"false" map to "light" not "no thinking" — V4-Pro
 * always reasons, only depth is controllable. The skill-frontmatter
 * vocabulary stays loose so authors don't have to know that.
 *
 * `undefined` means "don't override" so the cloud picks the default
 * depth. Mirrors Aris's "unknown values silently no-op" pattern so a
 * typo in skill frontmatter doesn't crash the dispatch.
 */
function mapEffortToReasoningEffort(
  effort: string | undefined,
): DeepSeekReasoningEffort | undefined {
  if (!effort) return undefined;
  const normalized = effort.trim().toLowerCase();
  switch (normalized) {
    case "max":
    case "maximum":
    case "ultra":
      return "max";
    case "high":
    case "medium":
    case "thinking":
    case "on":
    case "yes":
    case "true":
      return "high";
    case "low":
    case "minimal":
    case "off":
    case "no":
    case "false":
    case "light":
    case "non-think": // legacy alias — kept so old frontmatter still maps cleanly
      return "light";
    default:
      return undefined;
  }
}

interface DeepSeekSessionContext {
  session: ProviderSession;
  activeFiber: Fiber.Fiber<void, never> | undefined;
  stopped: boolean;
  /**
   * Pending approval map kept for AdapterShape parity. DeepSeek's
   * tools don't currently raise approval prompts so this map stays
   * empty — the slot is here for the day approval gating ships
   * across providers.
   */
  readonly pendingApprovals: Map<ApprovalRequestId, Deferred.Deferred<ProviderApprovalDecision>>;
  readonly sessionApprovedTools: Set<string>;
}

const makeDeepSeekAdapter = Effect.fn("makeDeepSeekAdapter")(function* () {
  const serverSettings = yield* ServerSettingsService;
  const arisEventBus = yield* ArisEventBus;

  const sessions = new Map<ThreadId, DeepSeekSessionContext>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /**
   * Publish to the same `aris.*` event channel that powers the chat
   * UI. Naming carries over from when the bus was Aris-only — the
   * recon memory flagged this as an open architectural question
   * ("rename or share?"). Sharing is the path of least resistance
   * and the UI consumes the same vocabulary regardless of provider.
   */
  const publishArisEvent = (event: ArisEvent): Effect.Effect<void> => arisEventBus.publish(event);

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<DeepSeekSessionContext, ProviderAdapterError> => {
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

  const startSession: DeepSeekAdapterShape["startSession"] = Effect.fn("startSession")(
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
        input.modelSelection?.provider === "deepseek" ? input.modelSelection.model : DEFAULT_MODEL;

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

      const ctx: DeepSeekSessionContext = {
        session,
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
  // `runDeepSeekAgentEffect`. This function only handles the
  // surrounding turn-lifecycle concerns:
  //   - settings + auth validation (cloudBaseUrl + session key)
  //   - building the per-turn OpenAI client + Agent
  //   - emitting `aris.turn.started` / `aris.turn.completed` (the
  //     runner skips these because we set `manageTurnLifecycle: false`
  //     so error classification can run BEFORE turn.failed lands)
  //   - error wrapping in the catch
  //   - cancellation cleanup in onInterrupt
  //
  // Streaming events (assistant.delta, reasoning.delta, tool.started/
  // completed, assistant.message.completed) are all emitted from
  // inside the runner.
  const runTurnStreaming = (
    ctx: DeepSeekSessionContext,
    turnId: TurnId,
    userText: string,
    modelOverride: string | undefined,
    reasoningEffort: DeepSeekReasoningEffort | undefined,
  ) => {
    let assistantMessageCount = 0;

    const main = Effect.gen(function* () {
      const allSettings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const deepseekSettings = allSettings.providers.deepseek;

      if (!deepseekSettings.cloudBaseUrl) {
        const createdAt = yield* nowIso;
        yield* publishArisEvent({
          type: "aris.error",
          threadId: ctx.session.threadId,
          turnId,
          createdAt,
          payload: {
            code: "validation_error",
            message: "DeepSeek cloud base URL is not configured.",
            recoverable: true,
          },
        });
        return;
      }

      if (!deepseekSettings.cloudToken || deepseekSettings.cloudToken.length === 0) {
        const createdAt = yield* nowIso;
        yield* publishArisEvent({
          type: "aris.error",
          threadId: ctx.session.threadId,
          turnId,
          createdAt,
          payload: {
            code: "permission_error",
            message: "Activate DeepSeek from settings — paste your subscription key.",
            recoverable: true,
          },
        });
        return;
      }

      const openaiClient = createDeepSeekOpenAIClient({
        cloudBaseUrl: deepseekSettings.cloudBaseUrl,
        cloudToken: deepseekSettings.cloudToken,
      });
      const modelName = modelOverride ?? DEFAULT_MODEL;
      const baseTools = createDeepSeekAgentTools({
        cwd: ctx.session.cwd,
        threadId: ctx.session.threadId,
        // #22 — Approval gating. Tools' `needsApproval` flag is set
        // based on the session's runtime mode at agent creation time.
        // Changing runtime mode mid-thread takes effect on the next
        // turn (gates are baked at tool-definition time, per SDK).
        runtimeMode: ctx.session.runtimeMode,
        // COORD-1 — pass cloud creds + default model so the composer
        // can build the `spawn_worker` AgentTool. Workers spawned via
        // this tool create their own OpenAIClient pointed at the same
        // cloud trusted-caller endpoint, reusing the same bearer.
        cloudBaseUrl: deepseekSettings.cloudBaseUrl,
        cloudToken: deepseekSettings.cloudToken,
        defaultModelName: modelName,
        // COORD-5 — parent turn id keys the per-session shared
        // scratchpad file so workers spawned within this turn share
        // the same jsonl. Each parent turn gets its own clean file.
        parentTurnId: turnId,
        // COORD-6.1 — emit aris.worker.spawn.* and
        // aris.session_scratchpad.appended events through the same
        // publish channel the runner uses for tool/turn events.
        // Frontend's right-sidebar CoordinatorActivityPanel
        // subscribes to these.
        emitCoordinatorEvent: (event) => {
          void publishArisEvent(event).pipe(Effect.runPromise);
        },
      });

      // Skills — load from `.aris/skills/` in the workspace. Same
      // directory Aris reads, so users author skills once and both
      // providers see them. Loader is contractually non-rejecting:
      // every fs failure surfaces as a SkillLoadError in the result
      // rather than throwing, so a single malformed SKILL.md can't
      // take DeepSeek offline.
      const skillsResult = yield* Effect.promise(() =>
        loadAllSkills({ workspaceRoot: ctx.session.cwd }),
      );
      if (skillsResult.errors.length > 0) {
        yield* Effect.logWarning("Some DeepSeek skills failed to load", {
          errors: skillsResult.errors.map((e) => `${e.path}: ${e.message}`),
        });
      }

      // Fork executor — when a skill declares `context: fork`, the
      // use_skill tool delegates here instead of returning the
      // rendered body to the parent. Spins up a fresh DeepSeek
      // sub-agent with its own OpenAI client (same cloud trusted-
      // caller endpoint, same session key — DeepSeek is stateless
      // server-side so no isolation work needed beyond a fresh
      // Agent instance). The parent's tool factory result is
      // filtered through the skill's `allowed-tools` list when
      // present. The use_skill tool itself is intentionally NOT
      // registered on the sub-agent: nested skills via fork are out
      // of V1 scope (potential infinite recursion risk).
      const forkCloudBaseUrl = deepseekSettings.cloudBaseUrl;
      const forkCloudToken = deepseekSettings.cloudToken;
      const forkExecutor: ForkExecutor = async (input) => {
        const allowed = input.skill.frontmatter.allowedTools;
        const subAgentTools =
          allowed && allowed.length > 0
            ? baseTools.filter((t) => allowed.includes(t.name))
            : baseTools;

        const subClient = createDeepSeekOpenAIClient({
          cloudBaseUrl: forkCloudBaseUrl,
          cloudToken: forkCloudToken,
        });

        const subModelName = input.skill.frontmatter.model ?? modelName;
        const subEffort = mapEffortToReasoningEffort(input.skill.frontmatter.effort);

        const subAgent = new Agent({
          name: `DeepSeek.Skill.${input.skill.name}`,
          instructions: input.renderedBody,
          model: new OpenAIChatCompletionsModel(subClient, subModelName),
          tools: subAgentTools,
        });

        // Save-and-restore the request-effort holder so the parent's
        // value isn't stomped when the fork returns. The parent's
        // runner sets the effort at the top of `run()` and clears in
        // finally; nested fork dispatch sits inside that window, so
        // we have to put back what was there before — clearing to
        // undefined would un-effort the parent's remaining iterations.
        const previousEffort = getRequestReasoningEffort();
        if (subEffort !== undefined) {
          setRequestReasoningEffort(subEffort);
        }
        try {
          const result = await run(subAgent, "Begin executing the skill workflow.");
          const finalOutput = result.finalOutput;
          if (finalOutput == null) {
            return `Skill '${input.skill.name}' completed with no final output.`;
          }
          return typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput);
        } finally {
          if (subEffort !== undefined) {
            setRequestReasoningEffort(previousEffort);
          }
        }
      };

      // Shell expansion in skill bodies. Default OFF for safety; user
      // opts in via env var. The flag name stays `ARIS_SHELL_EXPANSION`
      // because "Aris Code" is the product brand — flipping it on
      // enables shell substitution for skills regardless of which
      // provider is running them.
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
      const tools = useSkillTool ? [...baseTools, useSkillTool] : baseTools;

      const agent = new Agent({
        name: "DeepSeek",
        // System prompt for DeepSeek is intentionally empty here —
        // V1 cloud's trusted-caller endpoint may inject a system
        // prompt server-side (Slice 33i's call), or this gets filled
        // in once we know what positioning we want. Either way: the
        // adapter is the wrong place to hard-code persona text.
        instructions: "",
        model: new OpenAIChatCompletionsModel(openaiClient, modelName),
        tools,
      });

      // Slash-command dispatch. If the user's message starts with
      // `/skillname`, rewrite it into the rendered skill body before
      // we hand it to the SDK. Slash dispatch is always inline;
      // `context: fork` is honored only when the model invokes
      // use_skill itself. Returns null when there's no slash prefix
      // or when the named skill isn't loaded, in which case the
      // original text passes through unchanged.
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

      const userMessageId = MessageId.make(`user:${turnId}`);
      const startedAt = yield* nowIso;
      yield* publishArisEvent({
        type: "aris.turn.started",
        threadId: ctx.session.threadId,
        turnId,
        createdAt: startedAt,
        payload: { userMessageId, runtimeMode: ctx.session.runtimeMode },
      });

      // RW-2 — Read prior conversation from active.jsonl BEFORE we
      // persist the new user message. The on-disk view doesn't yet
      // include this turn's user input, so the read returns the prior
      // turn pairs only. We then append this turn's user message
      // in-memory to build the SDK input array. Disk persist runs
      // fire-and-forget so it never blocks the turn.
      //
      // Skip silently if the session has no cwd (rolling window is
      // per-project, no project = nowhere to put it, no history to
      // load). The runner falls back to single-message mode in that
      // case — same behavior as before RW-2.
      const archiveCwd = ctx.session.cwd;
      const sessionThreadId = ctx.session.threadId;

      // RW-3 — Check rollover trigger BEFORE reading prior history or
      // persisting the new user message. If active.jsonl has crossed
      // the token threshold (default 920K, env-overridable), atomically
      // rename it to window_NNN.jsonl. The next persist call will
      // create a fresh empty active.jsonl. Rollover failures don't
      // brick the turn — fall through to the read which will see
      // whatever state the disk is in.
      //
      // Why before the read: prior-history read should reflect
      // post-rollover state, otherwise we'd send all of windows 1..N
      // worth of messages to DS (overflowing context). RW-5 reads the
      // most-recent summary file separately and prepends it as a
      // system message so the new window starts with the rollup, not
      // a blank slate.
      //
      // RW-4 — On rollover, fire summary generation in the background
      // (fire-and-forget). DS Pro call takes 5-30s; awaiting would
      // block the user's next turn for that duration. Detached promise
      // means user proceeds at full speed; if their next turn fires
      // before the summary lands, RW-5 falls back to no-summary mode
      // for that one turn (still graceful).
      if (archiveCwd) {
        const rolloverResult = yield* Effect.tryPromise({
          try: () => tryRollover(archiveCwd, sessionThreadId),
          catch: toRollingWindowIOError("append"),
        }).pipe(
          Effect.catch((err: RollingWindowIOError) =>
            Effect.sync(() => {
              console.warn(
                `[DeepSeekAdapter] RW-3 rollover check failed (continuing): ${err.message}`,
              );
              return {
                rolledOver: false as const,
                currentTokens: 0,
                threshold: 0,
              };
            }),
          ),
        );
        if (rolloverResult.rolledOver) {
          generateRolloverSummaryBackground({
            cwd: archiveCwd,
            threadId: sessionThreadId,
            windowIndex: rolloverResult.windowIndex,
            archivedPath: rolloverResult.archivedPath,
            openaiClient,
          });
        }
      }

      let priorMessages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = [];
      if (archiveCwd) {
        // Read failures (corrupt file, permission issue, ENOENT for a
        // brand-new thread) shouldn't brick the turn — recover into
        // no-history mode using Effect.catch rather than try/catch
        // (try/catch inside Effect.gen is forbidden in Effect v4).
        priorMessages = yield* Effect.tryPromise({
          try: () => readActiveWindow(archiveCwd, sessionThreadId),
          catch: toRollingWindowIOError("read"),
        }).pipe(
          Effect.catch((err: RollingWindowIOError) =>
            Effect.sync(() => {
              console.warn(
                `[DeepSeekAdapter] RW-2 active-window read failed (continuing without history): ${err.message}`,
              );
              return [] as ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
            }),
          ),
        );
      }

      // RW-1 — Persist user message to active.jsonl. Fire-and-forget:
      // we do NOT await the disk write. Even a hung filesystem can't
      // block the turn this way. The .catch on the bare promise
      // swallows any failure so an unhandled rejection can't crash
      // the process.
      if (archiveCwd) {
        void appendToActiveWindow(archiveCwd, sessionThreadId, {
          role: "user",
          content: effectiveUserText,
          timestamp: startedAt,
          messageId: userMessageId,
          turnId,
        }).catch((err) => {
          console.warn(
            `[DeepSeekAdapter] RW-1 user-message persist failed (continuing): ${String(err)}`,
          );
        });
      }

      // RW-5 — If a rollup summary exists for this thread, read it and
      // prepend as a system message so the new active window is seeded
      // with prior context. Cloud's persona injection still places
      // ARIS_DS_PERSONA at index 0; this summary lands at index 1.
      // Per the V4 paper's prefix-cache guidance, persona stays the
      // immutable shared prefix (cacheable forever) and the summary
      // sits between persona and the changing live turns.
      //
      // Failure mode: if the summary file is missing (no rollover yet,
      // or RW-4 background generation hasn't completed for the latest
      // rollover), we just don't prepend anything. The thread proceeds
      // with whatever's in active.jsonl. The first turn after a fresh
      // rollover may briefly lack prior context until summary lands —
      // acceptable graceful degradation.
      let rolledUpSummaryText: string | null = null;
      if (archiveCwd) {
        rolledUpSummaryText = yield* Effect.tryPromise({
          try: async () => {
            const latest = await findLatestSummaryPath(archiveCwd, sessionThreadId);
            if (!latest) return null;
            return await readSummary(latest.path);
          },
          catch: toRollingWindowIOError("read"),
        }).pipe(
          Effect.catch((err: RollingWindowIOError) =>
            Effect.sync(() => {
              console.warn(
                `[DeepSeekAdapter] RW-5 summary read failed (continuing without seed): ${err.message}`,
              );
              return null as string | null;
            }),
          ),
        );
      }

      // MEM-1 — Read the project-scoped scratchpad and inject the
      // current state into the system prompt as a `<scratchpad>` block.
      // The scratchpad lives at `~/.aris/projects/<project-key>/scratchpad.jsonl`
      // and is shared across every thread under the same workspace cwd
      // (project-scoped, not thread-scoped — same shape as Aris's
      // (user, project) scope).
      //
      // Failure mode: if the read errors (corrupted file, perms, etc.)
      // we log and proceed without injecting. The thread still works;
      // the model just doesn't see the scratchpad this turn. Empty
      // scratchpad → no block injected at all (don't pollute the
      // prompt with an empty section).
      let scratchpadText: string | null = null;
      if (archiveCwd) {
        const raw = yield* Effect.tryPromise({
          try: () => readScratchpad(archiveCwd),
          catch: toScratchpadIOError("read"),
        }).pipe(
          Effect.catch((err: ScratchpadIOError) =>
            Effect.sync(() => {
              console.warn(
                `[DeepSeekAdapter] MEM-1 scratchpad read failed (continuing without it): ${err.message}`,
              );
              return "";
            }),
          ),
        );
        scratchpadText = raw.length > 0 ? raw : null;
      }

      // MEM-3 — Read user-global facts. NOT gated on archiveCwd —
      // facts live at `~/.aris/facts.jsonl` regardless of which
      // project is open, and apply across every project. Read every
      // turn so a fact upserted in this turn shows up in the next
      // turn's prompt.
      //
      // Failure mode: same as scratchpad/todos — log + continue
      // with the empty placeholder. Unlike scratchpad/todos, we
      // ALWAYS emit the `<facts>` block (even when empty) because
      // initial testing showed DS narrates "remembered facts" in
      // chat instead of calling `upsert_memory_node` when there's
      // no visible `<facts>` affordance in the prompt. The empty
      // placeholder tells the model the layer exists and how to
      // populate it.
      const factsText: string = yield* Effect.tryPromise({
        try: async () => renderFacts(await readFacts()),
        catch: toFactsIOError("read"),
      }).pipe(
        Effect.catch((err: FactsIOError) =>
          Effect.sync(() => {
            console.warn(
              `[DeepSeekAdapter] MEM-3 facts read failed (continuing with empty placeholder): ${err.message}`,
            );
            return "";
          }),
        ),
      );

      // MEM-2 — Read the project-scoped todos and render open ones
      // (pending + in_progress) for injection. Completed todos stay in
      // the file but are filtered out of the prompt — the model
      // shouldn't waste context on done work, and `clear --only-completed`
      // can sweep them via the manage_todos tool.
      //
      // Failure mode: same as scratchpad — log + continue without
      // injection. Empty open-list → no `<todos>` block at all.
      let todosText: string | null = null;
      if (archiveCwd) {
        const rendered = yield* Effect.tryPromise({
          try: async () => renderOpenTodos(await readTodos(archiveCwd)),
          catch: toTodosIOError("read"),
        }).pipe(
          Effect.catch((err: TodosIOError) =>
            Effect.sync(() => {
              console.warn(
                `[DeepSeekAdapter] MEM-2 todos read failed (continuing without them): ${err.message}`,
              );
              return "";
            }),
          ),
        );
        todosText = rendered.length > 0 ? rendered : null;
      }

      // RW-2 — Build the SDK input array. Prior turns become
      // `AgentInputItem` entries; current user input lands at the end.
      // When there's no prior history (first turn of a thread, or no
      // archive cwd), we send a single-message array which the SDK
      // treats identically to passing the string directly.
      //
      // RW-5 — If we have a rollup summary, prepend it as a system
      // message at the head of the array so the new window starts
      // with the rolled-up context.
      // #37 — Inject cwd context as a stable system message so DS knows
      // exactly where it's operating and stops hallucinating paths
      // (observed: `/Users/kennystevens/...` when actual cwd is
      // `/Users/kenny/Projects/...`). Stable per-thread so prefix
      // caching downstream of persona stays warm. Persona at index 0,
      // cwd at index 1, summary at index 2 (when present), live turns
      // at the tail — slot order matches V4 paper's prefix-cache
      // hierarchy from most-stable to least-stable.
      const cwdSystemMessage: AgentInputItem | null = archiveCwd
        ? ({
            role: "system",
            content:
              "## Working directory\n\n" +
              `You are operating in: \`${archiveCwd}\`\n\n` +
              "All relative paths in tool calls (read_file, glob, list_directory, " +
              "edit_file, write_file, bash) resolve from this directory unless an " +
              "absolute path is provided. **Always use this exact path or paths " +
              "underneath it — never invent or assume different user names, " +
              "project names, or directory layouts.** When unsure of a file's " +
              "location, run `bash` with `pwd` or `list_directory` first to " +
              "ground yourself rather than guessing.",
          } as AgentInputItem)
        : null;

      // MEM-2.5 — Always-on memory-architecture briefing. The model
      // needs to know its conversation is never truncated and that
      // archived windows are queryable, regardless of whether a
      // rollover has fired in this thread yet. Without this, DS thinks
      // anything not in the active context "evaporates" and either
      // over-relies on scratchpad for things conversation already
      // captures, or hesitates to engage with the user's references to
      // older turns. Stable per-thread (only depends on archiveCwd),
      // so it sits high in the prefix-cache hierarchy alongside the
      // cwd block.
      const memoryArchitectureMessage: AgentInputItem | null = archiveCwd
        ? ({
            role: "system",
            content:
              "## Your persistent memory architecture\n\n" +
              "Nothing you say or hear in this thread is ever truncated " +
              "or lost. Every message is persisted to " +
              "`~/.aris/projects/<this-project>/sessions/<this-thread>/active.jsonl`. " +
              "When the active window crosses ~940K tokens it's atomically " +
              "frozen as `window_NNN.jsonl` (with a summary handed forward " +
              "into the new active window) and a fresh active window starts. " +
              "Archived windows stay forever and remain queryable.\n\n" +
              "Three tools query the archives — use them proactively when " +
              "the user references earlier conversation that isn't in your " +
              "current context:\n\n" +
              "- `list_archives` — list archived windows with metadata + " +
              "summary previews. Cheap orientation call.\n" +
              "- `search_archives(query)` — keyword or regex search across " +
              "all archived transcripts for this thread. Use this when the " +
              "user asks about a topic, decision, or moment from before. " +
              "Don't say 'I don't have that context' — call this first.\n" +
              "- `read_archive_range(window_index, start_msg, end_msg)` — " +
              "pull a specific message range to see conversation flow. Use " +
              "after `search_archives` finds a hit when you need surrounding " +
              "context.\n\n" +
              "These tools are scoped to THIS thread's archives only. " +
              "Project-level state that survives across threads lives in " +
              "the `<scratchpad>` and `<todos>` blocks below (when " +
              "present); user-level state that survives across projects " +
              "lives in `<facts>`.",
          } as AgentInputItem)
        : null;

      // COORD-2 — Coordinator system prompt. Always-on training for
      // the spawn_worker tool, since spawn_worker is always-registered
      // for DS. Adapted from the leaked Anthropic TypeScript original
      // (the longer, more heavily-prompt-engineered version vs. the
      // leaner Rust port). Four-phase workflow + anti-lazy-delegation
      // guardrail + escalate-handling + read-the-output explicit
      // training. Stable per-thread so it sits in the prefix-cache
      // band alongside cwd and memory-architecture.
      const coordinatorSystemMessage: AgentInputItem = {
        role: "system" as const,
        content:
          "## Coordinator behavior — when you spawn workers\n\n" +
          "You have the `spawn_worker` tool. When a task can be " +
          "decomposed into independent subtasks, USE IT — fan out " +
          "research, audit, or generation work in parallel. The " +
          "remainder of this section is mandatory training for how to " +
          "behave when you choose to coordinate.\n\n" +
          "### The four-phase pattern\n\n" +
          "Real coordination follows four phases. They are not rigid — " +
          "you may loop back if implementation reveals research gaps — " +
          "but the default flow is:\n\n" +
          "1. **Research** — spawn parallel workers to investigate " +
          "subtopics. Each worker gets a self-contained prompt and " +
          "returns findings. Workers run independently; they do NOT " +
          "see your conversation history.\n" +
          "2. **Synthesis** — READ THE ACTUAL WORKER OUTPUTS. Build " +
          "your understanding from what they returned, not from what " +
          "you remember about the topic. If a worker returned a " +
          "specific number (file count, line count, version), use " +
          "THAT number — do not estimate or recall a different one.\n" +
          "3. **Implementation** — if the task requires producing " +
          "code, spawn implementation workers (or do it yourself). " +
          "Workers writing files should be given explicit, narrow " +
          "scope per file or per concern.\n" +
          "4. **Verification** — confirm the work actually does what " +
          "the user asked. Spawn test/verification workers if the " +
          "scope warrants, or run the checks yourself.\n\n" +
          "### Anti-lazy-delegation guardrails\n\n" +
          "These are the most important rules. Violating them produces " +
          "confident-sounding hallucinations:\n\n" +
          "- **NEVER say 'based on the worker findings' without " +
          "actually reading the worker output.** If a worker returned " +
          "1KB of text, your synthesis must reflect what's actually IN " +
          "that 1KB. If you find yourself generating numbers, file " +
          "counts, line counts, or other specific facts that didn't " +
          "appear in worker outputs — STOP. Either spawn a worker to " +
          "verify, run the command yourself, or omit the claim.\n" +
          "- **Workers can hallucinate too.** If a worker's output " +
          "contains numbers or claims that seem off, verify with a " +
          "direct tool call before incorporating them into your " +
          "synthesis.\n" +
          "- **Cite specific worker outputs in your synthesis.** When " +
          "you say 'WK1 found X', X should appear verbatim (or " +
          "near-verbatim) in WK1's returned text.\n\n" +
          "### When a worker escalates\n\n" +
          "Workers can call `escalate(reason)` to flag that the plan " +
          "is wrong. When you see `[ESCALATED — reason: ...]` in a " +
          "worker result, STOP. Read the reason carefully. Re-evaluate " +
          "your current plan against the new information. You may " +
          "need to: spawn new research workers to fill gaps, revise " +
          "your synthesis, or re-plan implementation entirely. Do NOT " +
          "simply spawn another worker with the same plan.\n\n" +
          "### When a worker hits its budget\n\n" +
          "If a worker returns `[BUDGET EXCEEDED — ...]`, the worker " +
          "ran out of turns before producing a final answer. The " +
          "result includes the partial assembled text — read it. If " +
          "the partial work is useful, integrate it. If you need to " +
          "continue, spawn a new worker with a more focused prompt " +
          "that narrows the task — don't just re-run the same prompt " +
          "with a higher max_turns; the worker's strategy is the " +
          "issue, not the budget.\n\n" +
          "### When NOT to spawn workers\n\n" +
          "- Tasks that need shared in-flight state (workers can't " +
          "see your scratchpad).\n" +
          "- Single-step tasks (one grep, one file read) — overhead " +
          "isn't worth it.\n" +
          "- Anything you'd complete in 1-2 of your own tool calls.\n" +
          "- Casual conversation, simple questions, follow-up " +
          "clarifications.\n\n" +
          "Use the tool. Don't narrate that you'd use the tool.",
      } as AgentInputItem;

      const sdkInputItems: AgentInputItem[] = [
        ...(cwdSystemMessage ? [cwdSystemMessage] : []),
        coordinatorSystemMessage,
        ...(memoryArchitectureMessage ? [memoryArchitectureMessage] : []),
        // MEM-3 — User-global facts block. ALWAYS emitted (even when
        // facts list is empty) because the model needs to see the
        // `<facts>` affordance every turn, otherwise it narrates
        // "remembered facts" in chat instead of calling the tool.
        // Sits right after the memory-architecture briefing because
        // both are user-level (apply across every project), before the
        // project-scoped scratchpad/todos blocks. Facts mutate slowly
        // (only when DS calls upsert/delete_memory_node), so they
        // belong above the turn-frequently-mutating scratchpad in the
        // prefix-cache hierarchy.
        {
          role: "system" as const,
          content:
            "## Persistent facts about the user\n\n" +
            "User-global facts that apply across EVERY project, not just " +
            "this one. The `<facts>` block below is the current contents " +
            "of `~/.aris/facts.jsonl`, replayed and grouped by type.\n\n" +
            "**WHEN THE USER SHARES A FACT ABOUT THEMSELVES OR HOW THEY " +
            "WANT YOU TO BEHAVE, CALL `upsert_memory_node` — DO NOT JUST " +
            "ACKNOWLEDGE IT IN CHAT.** Examples that should trigger a " +
            "tool call:\n" +
            "  - 'my name is X' / 'I'm X' / 'call me X' → upsert " +
            "(type=user, label=name)\n" +
            "  - 'remember that I have a daughter named Y' → upsert " +
            "(type=user, label=daughter-y)\n" +
            "  - 'don't use the word patch' / 'always reply in Spanish' / " +
            "'no apologies' → upsert (type=feedback, label=...)\n" +
            "  - 'I work as a Z' / 'I live in W' → upsert (type=user, " +
            "label=role-or-location)\n\n" +
            "Use `delete_memory_node` when the user asks to forget " +
            "something or when a stored fact is wrong. The block refreshes " +
            "every turn from disk — you don't need to re-read it.\n\n" +
            "<facts>\n" +
            (factsText.length > 0
              ? factsText
              : "(no facts saved yet — this is normal for a fresh user. " +
                "Call upsert_memory_node when the user shares anything " +
                "you should remember about them across projects.)") +
            "\n</facts>",
        } as AgentInputItem,
        // MEM-1 — Scratchpad block. Sits between cwd (most stable —
        // never changes per project) and the rollup summary (changes
        // on every rollover). Within a project the scratchpad mutates
        // turn-by-turn when DS calls update_scratchpad, so it's the
        // first non-stable item in the prefix-cache hierarchy.
        ...(scratchpadText
          ? [
              {
                role: "system" as const,
                content:
                  "## Project scratchpad\n\n" +
                  "Your in-flight working notes for this project. The buffer " +
                  "below is the current contents of " +
                  "`~/.aris/projects/<this-project>/scratchpad.jsonl`, " +
                  "replayed into a single text block. It persists across " +
                  "every thread in this project.\n\n" +
                  "Use the `update_scratchpad` tool with mode `set` to " +
                  "replace the buffer, `append` to add a line, or `clear` " +
                  "when the multi-step task is fully done. The block below " +
                  "refreshes every turn from the file — you don't need to " +
                  "re-read it.\n\n" +
                  "<scratchpad>\n" +
                  scratchpadText +
                  "\n</scratchpad>",
              } as AgentInputItem,
            ]
          : []),
        // MEM-2 — Open-todos block. Sits right after scratchpad (both
        // are project-scoped and both mutate within a turn). Only
        // pending + in_progress todos are shown — completed ones live
        // on disk for audit but don't burn prompt tokens. Use
        // `manage_todos` mode `add` to create, `set_status` to
        // transition, `clear` (with `only_completed: true`) to sweep
        // finished. The block refreshes every turn from
        // `~/.aris/projects/<this-project>/todos.jsonl`.
        ...(todosText
          ? [
              {
                role: "system" as const,
                content:
                  "## Project todos (open only)\n\n" +
                  "Open todos for this project — pending and in_progress. " +
                  "Completed todos are hidden from this block but still " +
                  "exist in the file (run `manage_todos` mode `list` to " +
                  "see everything, or mode `clear` with `only_completed: " +
                  "true` to sweep them).\n\n" +
                  "When you start work on a todo, transition it to " +
                  "`in_progress` via `manage_todos` mode `set_status`. " +
                  "When done, transition to `completed`. The block below " +
                  "refreshes every turn — you don't need to re-list.\n\n" +
                  "<todos>\n" +
                  todosText +
                  "\n</todos>",
              } as AgentInputItem,
            ]
          : []),
        ...(rolledUpSummaryText
          ? [
              {
                role: "system" as const,
                content:
                  "## Rolling-window memory rollup\n\n" +
                  "The conversation prior to this point was archived (it crossed " +
                  "the rolling-window threshold). The summary below carries " +
                  "forward what mattered. Treat it as authoritative ground " +
                  "truth about what was discussed and decided.\n\n" +
                  "## When to dig deeper into the archives\n\n" +
                  "Full earlier transcripts are queryable via three tools — " +
                  "USE THEM PROACTIVELY when the summary isn't enough:\n\n" +
                  "- `list_archives` — see what windows exist with metadata + " +
                  "summary previews. Cheap call, use it to orient when the user " +
                  "references prior conversations.\n" +
                  "- `search_archives(query)` — keyword/regex search across all " +
                  "archived transcripts. Use when the user asks about a topic, " +
                  "decision, or moment that the summary mentions but doesn't " +
                  "detail. Don't say 'I don't have those specifics' — call this.\n" +
                  "- `read_archive_range(window_index, start_msg, end_msg)` — pull " +
                  "a specific message range to see conversation flow. Use after " +
                  "search_archives finds a hit, when you need surrounding context.\n\n" +
                  "The archive is the lossless source. The summary is just an " +
                  "index. If you find yourself uncertain about a fact the user " +
                  "is referencing from before the rollover, the archive has it — " +
                  "go get it instead of guessing.\n\n" +
                  rolledUpSummaryText,
              } as AgentInputItem,
            ]
          : []),
        ...priorMessages.map((m) =>
          m.role === "user"
            ? ({ role: "user", content: m.content } as AgentInputItem)
            : ({
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: m.content }],
              } as AgentInputItem),
        ),
        { role: "user", content: effectiveUserText } as AgentInputItem,
      ];
      console.error(
        `[DeepSeekAdapter] RW-2/5/MEM-1/MEM-2/MEM-2.5/MEM-3/COORD-2 sending ${sdkInputItems.length} message(s) to runner ` +
          `(cwd: ${cwdSystemMessage ? "yes" : "no"}, ` +
          `coord: yes, ` +
          `mem-arch: ${memoryArchitectureMessage ? "yes" : "no"}, ` +
          `facts: ${factsText.length > 0 ? `${factsText.length} chars` : "empty placeholder"}, ` +
          `scratchpad: ${scratchpadText ? `${scratchpadText.length} chars` : "no"}, ` +
          `todos: ${todosText ? `${todosText.split("\n").length} open` : "no"}, ` +
          `summary: ${rolledUpSummaryText ? "yes" : "no"}, ` +
          `${priorMessages.length} from history + 1 new)`,
      );

      // RW-1 + RW-2.5 — Tap the publish callback so we persist completed
      // assistant messages to active.jsonl. We AWAIT the disk write
      // before publishing the message-completed event so a downstream
      // refetch (the UI's history hook fires on turn.completed) sees
      // the new message on disk rather than racing the write.
      //
      // Persist failures don't block the publish — they're logged and
      // the event still goes out, so the live buffer in the UI is
      // unaffected. The trade-off vs pure fire-and-forget: a few ms of
      // disk-write latency is added to the message-completed event
      // path, which is invisible to the user but eliminates the race
      // that caused assistant bubbles to disappear after turn settle.
      const persistingPublish = (event: ArisEvent): Effect.Effect<void> => {
        if (
          event.type === "aris.assistant.message.completed" &&
          archiveCwd &&
          event.payload.finalText.length > 0
        ) {
          const persistThreadId = ctx.session.threadId;
          const finalText = event.payload.finalText;
          const messageId = event.payload.messageId;
          const createdAt = event.createdAt;
          return Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () =>
                appendToActiveWindow(archiveCwd, persistThreadId, {
                  role: "assistant",
                  content: finalText,
                  timestamp: createdAt,
                  messageId,
                  turnId,
                }),
              catch: toRollingWindowIOError("append"),
            }).pipe(
              Effect.catch((err: RollingWindowIOError) =>
                Effect.sync(() => {
                  console.warn(
                    `[DeepSeekAdapter] RW-1 assistant-message persist failed (continuing): ${err.message}`,
                  );
                }),
              ),
            );
            yield* publishArisEvent(event);
          });
        }
        return publishArisEvent(event);
      };

      // #22 — Approval gateway. The runner pauses the SDK loop when
      // a `needsApproval`-flagged tool fires; this callback surfaces
      // each interruption as an `aris.approval.requested` event and
      // awaits the user's decision via the existing pendingApprovals
      // + `respondToRequest` pipeline. The Promise resolves with
      // whatever decision the user clicks; the runner then applies
      // approve/reject to the run state and resumes.
      //
      // The OpenAI Agents SDK's tool-approval mechanism takes a
      // Promise-returning callback. We capture the Effect context
      // here (still inside Effect.gen) and use `Effect.runPromiseWith`
      // inside the async callback — the v4 recommended bridge that
      // preserves the parent Effect's services. `publishArisEvent`
      // and `Deferred.make/await` have R = never, so this is purely
      // satisfying the language-service plugin without changing
      // runtime semantics.
      const approvalEffectContext = yield* Effect.context<never>();
      const requestApprovalGateway = async (
        item: RunToolApprovalItem,
      ): Promise<ProviderApprovalDecision> => {
        const approvalId = ApprovalRequestId.make(randomUUID());
        const toolName = item.name ?? "<unknown>";
        const argsRaw = item.arguments ?? "";
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(argsRaw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          // Args weren't valid JSON — keep empty record, model still
          // sees an approval prompt with the toolName and a preview.
        }
        const callId =
          "callId" in item.rawItem && typeof item.rawItem.callId === "string"
            ? item.rawItem.callId
            : `noid-${approvalId}`;
        const summary = buildApprovalSummary(toolName, args, argsRaw);

        const deferred = await Effect.runPromiseWith(approvalEffectContext)(
          Deferred.make<ProviderApprovalDecision>(),
        );
        ctx.pendingApprovals.set(approvalId, deferred);

        const requestedAt = new Date().toISOString();
        await Effect.runPromiseWith(approvalEffectContext)(
          publishArisEvent({
            type: "aris.approval.requested",
            threadId: ctx.session.threadId,
            turnId,
            createdAt: requestedAt,
            payload: {
              approvalId,
              toolCallId: callId as ArisToolCallId,
              toolName,
              summary,
              args,
            },
          }),
        );

        try {
          const decision = await Effect.runPromiseWith(approvalEffectContext)(
            Deferred.await(deferred),
          );
          // Publish `aris.approval.resolved` so the UI's
          // useArisPendingApprovals hook removes the popup. Without
          // this the prompt stays visible after the user clicks
          // approve/decline, and any subsequent click hits the empty
          // pendingApprovals slot (we deleted on respondToRequest)
          // and silently no-ops.
          const resolvedAt = new Date().toISOString();
          await Effect.runPromiseWith(approvalEffectContext)(
            publishArisEvent({
              type: "aris.approval.resolved",
              threadId: ctx.session.threadId,
              turnId,
              createdAt: resolvedAt,
              payload: { approvalId, decision },
            }),
          );
          return decision;
        } finally {
          // respondToRequest already deletes on success; this is a
          // safety net for the case where the deferred resolves but
          // the entry somehow lingers (defensive).
          ctx.pendingApprovals.delete(approvalId);
        }
      };

      const result = yield* runDeepSeekAgentEffect({
        agent,
        // RW-2 — pass the full prior conversation as a structured input
        // array instead of just the new user message string. The SDK
        // treats this as "use this exact conversation as starting
        // history" so DS sees what the user said three turns ago, not
        // just the most recent message.
        prompt: sdkInputItems,
        threadId: ctx.session.threadId,
        turnId,
        userMessageId,
        runtimeMode: ctx.session.runtimeMode,
        publish: persistingPublish,
        // We own the turn lifecycle so we can do error classification
        // before publishing turn.failed.
        manageTurnLifecycle: false,
        // #22 — pass the approval gateway so the runner can pause +
        // resume on tool-approval interruptions instead of auto-rejecting.
        requestApproval: requestApprovalGateway,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      });
      assistantMessageCount = result.messageCount;

      const completedAt = yield* nowIso;
      yield* publishArisEvent({
        type: "aris.turn.completed",
        threadId: ctx.session.threadId,
        turnId,
        createdAt: completedAt,
        payload: { messageCount: assistantMessageCount },
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
        `[DeepSeekAdapter] TURN COMPLETE — turnId=${turnId} messageCount=${assistantMessageCount}`,
      );
    });

    return main.pipe(
      Effect.catch((err) =>
        Effect.gen(function* () {
          // Same flat error path as ArisAdapter: rate-limit
          // specialization is deferred. The cloud trusted-caller
          // surfaces 429s back to Aris Code in some shape (TBD in
          // Slice 33i); a follow-up can split rate limits out of
          // the generic provider_error path here.
          console.error(
            `[DeepSeekAdapter] CATCH — turnId=${turnId} ` +
              `errorTag=${err._tag ?? "<none>"} ` +
              `detail=${JSON.stringify(err.message ?? String(err)).slice(0, 300)}`,
          );
          const failedAt = yield* nowIso;
          yield* publishArisEvent({
            type: "aris.error",
            threadId: ctx.session.threadId,
            turnId,
            createdAt: failedAt,
            payload: {
              code: "provider_error",
              message: err.message,
              recoverable: false,
            },
          });
          yield* publishArisEvent({
            type: "aris.turn.failed",
            threadId: ctx.session.threadId,
            turnId,
            createdAt: failedAt,
            payload: { errorMessage: err.message },
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
          console.error(`[DeepSeekAdapter] CANCELLED — turnId=${turnId}`);
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

  const sendTurn: DeepSeekAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const ctx = yield* requireSession(input.threadId);

    const trimmedInput = input.input?.trim() ?? "";
    if (trimmedInput.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "DeepSeek requires non-empty text input.",
      });
    }

    // DeepSeek V4-Pro is text-only per recon — silently ignore
    // attachments rather than failing the whole turn. Vision support
    // can be added when/if DeepSeek ships a multimodal model.
    if (input.attachments && input.attachments.length > 0) {
      console.warn(
        `[DeepSeekAdapter] sendTurn: ignoring ${input.attachments.length} attachment(s) — DeepSeek V4-Pro is text-only.`,
      );
    }

    const modelSelection =
      input.modelSelection?.provider === "deepseek" ? input.modelSelection : undefined;
    if (modelSelection?.model) {
      ctx.session = { ...ctx.session, model: modelSelection.model };
    }
    const reasoningEffort = modelSelection?.options?.effort;

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
      reasoningEffort,
    ).pipe(Effect.forkChild);
    ctx.activeFiber = fiber;

    return {
      threadId: ctx.session.threadId,
      turnId,
    };
  });

  const interruptTurn: DeepSeekAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const ctx = yield* requireSession(threadId);
      const fiber = ctx.activeFiber;
      if (fiber) {
        ctx.activeFiber = undefined;
        yield* Fiber.interrupt(fiber);
      }
    },
  );

  const respondToRequest: DeepSeekAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
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

  const respondToUserInput: DeepSeekAdapterShape["respondToUserInput"] = (threadId) =>
    Effect.fail(
      notSupported(
        "respondToUserInput",
        `DeepSeek does not issue user-input requests (thread ${threadId}).`,
      ),
    );

  const stopSessionInternal = (ctx: DeepSeekSessionContext) =>
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

  const stopSession: DeepSeekAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const ctx = sessions.get(threadId);
      if (!ctx) return;
      yield* stopSessionInternal(ctx);
    },
  );

  const listSessions: DeepSeekAdapterShape["listSessions"] = () =>
    Effect.sync(() =>
      Array.from(sessions.values())
        .filter((c) => !c.stopped)
        .map((c) => c.session),
    );

  const hasSession: DeepSeekAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const ctx = sessions.get(threadId);
      return ctx !== undefined && !ctx.stopped;
    });

  const readThread: DeepSeekAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      return {
        threadId: ctx.session.threadId,
        turns: [],
      };
    });

  const rollbackThread: DeepSeekAdapterShape["rollbackThread"] = (threadId) =>
    Effect.fail(
      notSupported("rollbackThread", `DeepSeek does not support rollback (thread ${threadId}).`),
    );

  const stopAll: DeepSeekAdapterShape["stopAll"] = () =>
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
    // DeepSeek (like Aris) doesn't flow through the orchestration
    // runtime queue — Aris bus subscribers consume the events
    // directly. Empty stream satisfies the AdapterShape contract.
    get streamEvents() {
      return Stream.empty;
    },
  } satisfies DeepSeekAdapterShape;
});

export const DeepSeekAdapterLive = Layer.effect(DeepSeekAdapter, makeDeepSeekAdapter());
