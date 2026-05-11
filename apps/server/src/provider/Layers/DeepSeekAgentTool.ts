/**
 * DeepSeekAgentTool — the `spawn_worker` tool that lets DeepSeek
 * delegate a self-contained subtask to a fresh sub-agent and get
 * the worker's final output back.
 *
 * Slice COORD-1: Foundation. Mirrors the leaked Rust impl in
 * `~/Projects/claude-code/src-rust/cc-tools/src/agent_tool.rs` —
 * fresh client per spawn, exclusion-based default tool set with
 * optional whitelist override, no AgentTool recursion, no event
 * forwarding (worker tool calls don't bubble up to the parent UI).
 *
 * Architecture:
 *
 *   Parent agent → calls spawn_worker(input) → tool execute spawns:
 *     1. Fresh OpenAIClient (same cloud trusted-caller endpoint,
 *        same bearer — DS is stateless server-side, no isolation
 *        work needed beyond a fresh Agent).
 *     2. Tool list resolved from the parent's catalog: explicit
 *        whitelist if input.tools was passed, else default-exclusion
 *        (parent's tools minus WORKER_EXCLUDED_TOOL_NAMES).
 *     3. New `Agent` instance with input.system_prompt as
 *        instructions (or a minimal "you are a sub-agent" framing).
 *     4. SDK Runner.run(workerAgent, input.prompt) with the parent's
 *        AbortSignal threaded through so killing the parent cascades
 *        to in-flight workers.
 *     5. Result.finalOutput returned to the parent as text. Errors
 *        wrapped in a clear "worker failed: ..." message so the
 *        coordinator can route around the failure rather than
 *        crashing the whole turn.
 *
 * Always-on per Kenny (2026-05-10): no runtime mode gating. DS is
 * cheap, let her decide when to fan out. The tool description
 * carries the "when to use this" nudging since COORD-2 (full
 * coordinator system prompt with four-phase training) hasn't
 * shipped yet.
 *
 * NOT registered for Aris-provider threads — Aris (POD) doesn't have
 * the OpenAI Agents SDK runtime that AgentTool depends on.
 *
 * @module DeepSeekAgentTool
 */
import { Agent, run, tool, type Tool } from "@openai/agents";
import { OpenAIChatCompletionsModel } from "@openai/agents-openai";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import { ArisToolCallId, type ArisEvent, type TurnId } from "@t3tools/contracts";

import { createDeepSeekOpenAIClient } from "./DeepSeekOpenAIClient.ts";
import {
  DEFAULT_WORKER_MAX_TURNS,
  WORKER_EXCLUDED_TOOL_NAMES,
  type WorkerUsage,
} from "./CoordinatorTypes.ts";
import { createDeepSeekSessionScratchpadTools } from "./DeepSeekSessionScratchpadTools.ts";

/**
 * Dependencies the AgentTool factory needs from its caller. Most of
 * these are the same values the parent DeepSeekAdapter already has
 * in scope when it composes the tool list — we just thread them
 * through the composer (DeepSeekAgentTools) into the AgentTool
 * factory.
 */
export interface DeepSeekAgentToolDeps {
  /** Cloud trusted-caller base URL (same value used by parent's OpenAIClient). */
  readonly cloudBaseUrl: string;
  /** Long-lived local_api_key bearer (same value used by parent's OpenAIClient). */
  readonly cloudToken: string;
  /** Default model name for spawned workers when the model doesn't override. */
  readonly defaultModelName: string;
  /**
   * The parent's full DS tool catalog (everything from
   * `createDeepSeekAgentTools` MINUS the AgentTool itself). Workers
   * draw from this list when filtering by allowlist or applying
   * default exclusion.
   */
  readonly parentTools: ReadonlyArray<Tool>;
  /**
   * Parent's AbortSignal — propagated to spawned workers so a parent
   * cancellation cascades. Optional because some callers (tests)
   * don't have one. Production always passes the runtime mode's
   * signal.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * COORD-5 — session scratchpad context. When present, each spawned
   * worker gets its own pair of `read_session_scratchpad` /
   * `append_session_scratchpad` tools with the writer label set to
   * the worker's description, so peer workers in this turn can see
   * who contributed what. Optional so non-coordinator callers can
   * still use the AgentTool factory.
   */
  readonly sessionScratchpadCtx?: {
    readonly cwd: string;
    readonly threadId: string;
    readonly parentTurnId: string;
  };
  /**
   * COORD-6.1 — emit `aris.worker.spawn.started` /
   * `aris.worker.spawn.completed` so the right-sidebar
   * CoordinatorActivityPanel can render live worker rows. The
   * adapter passes a callback that publishes through its existing
   * publishArisEvent hook (same one used for tool.started /
   * tool.completed). Optional so non-adapter callers (tests) can
   * skip the event channel.
   */
  readonly emitCoordinatorEvent?: (event: ArisEvent) => void;
}

/**
 * Build the `spawn_worker` tool. Single-element array to match the
 * composition shape used by every other DS tool family
 * (createDeepSeekScratchpadTool, createDeepSeekTodosTool,
 * createDeepSeekFactsTools, createDeepSeekArchiveTools).
 *
 * Returns `[]` when `parentTools` is empty — guards against being
 * called before any sibling tool families have been built. Should
 * never happen in production but keeps tests from crashing on a
 * nonsense input.
 */
export function createDeepSeekAgentTool(deps: DeepSeekAgentToolDeps): Tool[] {
  if (deps.parentTools.length === 0) return [];

  const spawnWorker = tool({
    name: "spawn_worker",
    description:
      "Delegate a self-contained subtask to a sub-agent worker and " +
      "get its final output back. Use this whenever a task can be " +
      "decomposed into independent pieces that don't need to share " +
      "in-flight context — research across multiple subdirectories, " +
      "auditing N independent files, drafting M variants of the same " +
      "thing, etc.\n\n" +
      "Each spawn_worker call is a fresh sub-agent: it has NO " +
      "visibility into your conversation history, scratchpad, todos, " +
      "or facts. The `prompt` you pass is the worker's entire " +
      "context — include any background it needs.\n\n" +
      "Workers are themselves full agentic sub-agents — they have the " +
      "SAME tool surface you do (file/shell/scratchpad/todos/facts/" +
      "archives), the SAME reasoning mode, and report back to you " +
      "with their final output. The only thing they can't do is " +
      "spawn their own workers (no recursion). Pass `tools: ['bash', " +
      "'read_file']` to restrict a worker to a narrow subset; omit " +
      "`tools` to give the worker your full tool set.\n\n" +
      "When to reach for this tool:\n" +
      "  - 'audit X across each of these N folders' → spawn N workers " +
      "in parallel, each scoped to one folder.\n" +
      "  - 'research these 5 topics and synthesize' → spawn 5 research " +
      "workers, then synthesize their outputs in your own response.\n" +
      "  - 'try 3 different approaches to this refactor' → spawn 3 " +
      "workers, each with one approach, compare results.\n\n" +
      "When NOT to reach for it: tasks that need shared in-flight " +
      "state (the worker can't see your scratchpad), single-step " +
      "tasks (overhead isn't worth it), or anything where you'd just " +
      "do the work yourself in 1-2 tool calls.",
    parameters: z.object({
      description: z
        .string()
        .describe(
          "Short 3-5 word label for what this worker is doing. Used in " +
            "logs and (eventually) UI tree views. 'research auth flow' good, " +
            "'do the thing' bad.",
        ),
      prompt: z
        .string()
        .describe(
          "Fully self-contained task prompt for the worker. Include all " +
            "background context — the worker has zero visibility into your " +
            "conversation history.",
        ),
      tools: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "Optional name allowlist. When omitted/null, worker gets your " +
            "full tool set minus spawn_worker and project/user state tools. " +
            "Pass e.g. ['bash', 'read_file'] to restrict to a narrow set.",
        ),
      system_prompt: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional override for worker's instructions. Default is a minimal " +
            "'you are a sub-agent, focus on the task, return a clear final " +
            "output' framing. Override for domain-specific worker personas.",
        ),
      max_turns: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          `Optional cap on worker iterations. Default ${DEFAULT_WORKER_MAX_TURNS}. ` +
            "Bump higher for deep research or complex implementation tasks.",
        ),
    }),
    async execute({ description, prompt, tools, system_prompt, max_turns }) {
      // Tool resolution: explicit whitelist OR exclusion-based default.
      // Both paths exclude WORKER_EXCLUDED_TOOL_NAMES even if the
      // model's whitelist tries to include something forbidden — the
      // exclusion list is the security boundary, not a default.
      const requestedSet = Array.isArray(tools) && tools.length > 0 ? new Set(tools) : null;
      const workerTools = deps.parentTools.filter((t) => {
        const name = t.name;
        if (WORKER_EXCLUDED_TOOL_NAMES.has(name)) return false;
        if (requestedSet !== null && !requestedSet.has(name)) return false;
        return true;
      });

      if (workerTools.length === 0) {
        return (
          "Worker spawn aborted: tool filter resolved to zero tools. " +
          (requestedSet !== null
            ? `Requested ${[...requestedSet].join(", ")} — none matched the parent's catalog or all matched were excluded for workers.`
            : "Parent catalog has no worker-eligible tools.")
        );
      }

      // Fresh client per spawn. Cheap (just a fetch wrapper) and
      // matches the Rust ref's pattern. Reuses the parent's bearer +
      // base URL so cloud-side metering attributes worker tokens to
      // the same user automatically.
      const workerClient = createDeepSeekOpenAIClient({
        cloudBaseUrl: deps.cloudBaseUrl,
        cloudToken: deps.cloudToken,
      });

      const workerInstructions =
        typeof system_prompt === "string" && system_prompt.length > 0
          ? system_prompt
          : "You are a sub-agent spawned by a coordinator. Focus on " +
            "the task in the user message, use your tools as needed, " +
            "and return a clear final output. You have no visibility " +
            "into the coordinator's conversation history — the prompt " +
            "you received contains all the context you have.\n\n" +
            "**Trust your tools and finish quickly.** If a search " +
            "tool (grep / glob) returns no matches, that IS the answer " +
            "— emit your final answer immediately stating 'no matches " +
            "found in <scope>'. Do NOT retry with variants of the same " +
            "search unless the prompt explicitly asks you to. Spinning " +
            "on tool variants burns your turn budget and produces " +
            "nothing. When you have enough information to answer the " +
            "task, STOP and emit a final response — don't gather more " +
            "than you need.";

      // COORD-4 — escalate tool. Worker-only; not in the parent's
      // catalog. When the worker calls this, we throw a tagged
      // sentinel that our catch recognizes and converts to an
      // `[ESCALATED]` marker for the parent. The coordinator prompt
      // (COORD-2) is trained to STOP and re-evaluate when it sees
      // this marker rather than spawning another worker with the
      // same plan.
      const escalationSentinel = "__WORKER_ESCALATION_SENTINEL__:";
      const escalateTool = tool({
        name: "escalate",
        description:
          "Flag to the coordinator that the plan you were given is " +
          "wrong, infeasible, or invalidated by something you " +
          "discovered. Calling this STOPS your run and returns control " +
          "to the coordinator with your reason. Use this when: the " +
          "task as described can't be completed (file doesn't exist, " +
          "wrong assumption baked into the prompt), you discovered " +
          "something that changes what should be done, or you're " +
          "stuck and can't proceed without the coordinator re-planning. " +
          "Don't use this for normal completion — just emit your final " +
          "answer for that. This is the 'something is wrong, re-think' " +
          "signal, not the 'I'm done' signal.",
        parameters: z.object({
          reason: z
            .string()
            .describe(
              "Concrete description of why you're escalating. What's wrong, " +
                "what you discovered, what the coordinator needs to know to " +
                "re-plan. Be specific — 'the file path in my prompt doesn't " +
                "exist; I checked /Users/kenny/Projects/t3code/foo and it's " +
                "not there' beats 'something is wrong'.",
            ),
        }),
        async execute({ reason }) {
          // Throw a tagged error. The spawn_worker.execute catch
          // recognizes the sentinel prefix and surfaces a clean
          // [ESCALATED] marker with the reason to the parent.
          throw new Error(`${escalationSentinel}${reason}`);
        },
      });

      // COORD-5 — Each worker gets its OWN session-scratchpad tool
      // pair, tagged with its description as the writer label. This
      // way when a worker appends, the entry is attributed to that
      // specific worker and peer workers can see who contributed
      // what. The parent's existing session-scratchpad tools (from
      // the composer with writerLabel="parent") were stripped out of
      // workerTools by the WORKER_EXCLUDED filter — actually they
      // weren't, since session-scratchpad tools aren't in the
      // exclude list. We strip them here and replace with the
      // worker-tagged versions to avoid the writer label being
      // wrong.
      const sessionScratchpadToolNames = new Set([
        "read_session_scratchpad",
        "append_session_scratchpad",
      ]);
      const workerSessionScratchpadTools = deps.sessionScratchpadCtx
        ? createDeepSeekSessionScratchpadTools({
            cwd: deps.sessionScratchpadCtx.cwd,
            threadId: deps.sessionScratchpadCtx.threadId,
            parentTurnId: deps.sessionScratchpadCtx.parentTurnId,
            writerLabel: description,
            ...(deps.emitCoordinatorEvent
              ? { emitCoordinatorEvent: deps.emitCoordinatorEvent }
              : {}),
          })
        : [];
      const workerToolsMinusSessionScratchpad = workerTools.filter(
        (t) => !sessionScratchpadToolNames.has(t.name),
      );

      const workerAgent = new Agent({
        name: `DeepSeek.Worker.${description.replaceAll(/\s+/g, "_")}`,
        instructions: workerInstructions,
        model: new OpenAIChatCompletionsModel(workerClient, deps.defaultModelName),
        // Workers get the parent's tool catalog (filtered, with the
        // parent-tagged session-scratchpad tools stripped), plus
        // worker-tagged session-scratchpad tools, plus the worker-only
        // escalate tool.
        tools: [
          ...workerToolsMinusSessionScratchpad,
          ...workerSessionScratchpadTools,
          escalateTool,
        ],
      });

      const turnCap =
        typeof max_turns === "number" && Number.isFinite(max_turns) && max_turns > 0
          ? Math.floor(max_turns)
          : DEFAULT_WORKER_MAX_TURNS;

      // COORD-1.1 — observability. Workers run in their own
      // Runner.run() so their tool calls don't appear in the parent's
      // runner log. Without these spawn/exit lines we have zero
      // visibility into what each worker did, which made the first
      // live test (4 workers all hitting max_turns) impossible to
      // diagnose. Logged to stderr so they interleave with the
      // existing [DeepSeekAdapter] / [DeepSeekAgentRunner] lines in
      // the dev electron output.
      const startedAtMs = Date.now();
      const workerToolNames = workerTools.map((t) => t.name).join(",");
      console.error(
        `[spawn_worker] START '${description}' tools=[${workerToolNames}] turnCap=${turnCap} promptLen=${prompt.length}`,
      );

      // COORD-6.1 — Emit aris.worker.spawn.started so the frontend
      // CoordinatorActivityPanel can render a "running" worker row.
      // We generate our own workerCallId for correlation since the
      // parent's spawn_worker tool_call_id isn't easily threaded into
      // execute. Frontend correlates start↔complete by this id.
      const workerCallId = ArisToolCallId.make(`worker_${randomUUID()}`);
      const startedAtIso = new Date().toISOString();
      if (deps.emitCoordinatorEvent && deps.sessionScratchpadCtx) {
        deps.emitCoordinatorEvent({
          type: "aris.worker.spawn.started",
          threadId: deps.sessionScratchpadCtx.threadId as never,
          turnId: deps.sessionScratchpadCtx.parentTurnId as TurnId,
          createdAt: startedAtIso as never,
          payload: {
            workerCallId,
            description,
            parentTurnId: deps.sessionScratchpadCtx.parentTurnId as TurnId,
            toolNames: workerTools.map((t) => t.name),
            turnCap,
            promptLength: prompt.length,
          },
        } as ArisEvent);
      }

      // Workers inherit the parent's reasoning effort (currently set
      // module-level via setRequestReasoningEffort). Per Kenny's KISS
      // call (2026-05-10): workers are full sub-agents, same tool
      // surface, same thinking mode. They report to the parent like
      // any other agent. If thinking mode causes a reasoning_content
      // roundtrip 400, that's a real cache bug to fix in the
      // interceptor, not something to work around by lobotomizing
      // workers.
      //
      // COORD-1.4 — Worker tool-call event forwarding. We stream the
      // worker's run() and iterate its events so every tool call the
      // worker makes shows up in the parent's stderr log with a
      // `[worker '...']` prefix. Without this we can't audit what
      // workers actually do — first live test had Aris's synthesis
      // claim 298 files in a directory that had 27, and we couldn't
      // tell whether her workers ran wc/find or guessed. Now we see
      // every tool name, args preview, output size per worker.
      const tag = `[worker '${description}']`;
      let toolCallCount = 0;
      let textChunks = 0;
      const finalTextParts: string[] = [];
      try {
        const stream = await run(workerAgent, prompt, {
          stream: true,
          maxTurns: turnCap,
          ...(deps.abortSignal !== undefined ? { signal: deps.abortSignal } : {}),
        });

        for await (const event of stream) {
          if (event.type === "raw_model_stream_event") {
            const ev = event.data;
            if (ev.type === "output_text_delta" && typeof ev.delta === "string") {
              textChunks += 1;
              finalTextParts.push(ev.delta);
            }
            continue;
          }
          if (event.type === "run_item_stream_event") {
            const item = event.item;
            if (item.type === "tool_call_item") {
              toolCallCount += 1;
              const raw = item.rawItem;
              if (
                raw.type === "function_call" &&
                typeof raw.name === "string" &&
                typeof raw.callId === "string"
              ) {
                const argsRaw = typeof raw.arguments === "string" ? raw.arguments : "";
                const argsPreview = argsRaw.length > 200 ? argsRaw.slice(0, 200) + "…" : argsRaw;
                console.error(
                  `${tag} tool_call: name=${raw.name} callId=${raw.callId} ` +
                    `argsBytes=${argsRaw.length} args=${JSON.stringify(argsPreview)}`,
                );
              }
              continue;
            }
            if (item.type === "tool_call_output_item") {
              const raw = item.rawItem;
              const callId = "callId" in raw && typeof raw.callId === "string" ? raw.callId : "?";
              const output = item.output;
              const outputStr = typeof output === "string" ? output : JSON.stringify(output);
              console.error(`${tag} tool_output: callId=${callId} outputBytes=${outputStr.length}`);
              continue;
            }
            // message_output_item — iteration boundary in worker's loop.
            // Not logged per-item; the final assembled text + chunk count
            // appear in the OK line below.
          }
        }

        // Streaming runs surface finalOutput via the same property
        // after the iteration completes. Fall back to the
        // accumulated delta text if finalOutput is null/undefined.
        const finalOutput = (stream as unknown as { finalOutput?: unknown }).finalOutput;
        const accumulatedText = finalTextParts.join("");
        const text =
          typeof finalOutput === "string" && finalOutput.length > 0
            ? finalOutput
            : accumulatedText.length > 0
              ? accumulatedText
              : `Worker '${description}' completed with no final output.`;

        const usage = extractUsage(stream);
        const elapsedMs = Date.now() - startedAtMs;
        console.error(
          `${tag} OK elapsed=${elapsedMs}ms toolCalls=${toolCallCount} ` +
            `textChunks=${textChunks} outputLen=${text.length}` +
            (usage ? ` usage=${formatUsage(usage)}` : ""),
        );

        const usageSuffix = usage ? `\n\n[worker usage: ${formatUsage(usage)}]` : "";
        const finalReturn = `${text}${usageSuffix}`;
        if (deps.emitCoordinatorEvent && deps.sessionScratchpadCtx) {
          deps.emitCoordinatorEvent({
            type: "aris.worker.spawn.completed",
            threadId: deps.sessionScratchpadCtx.threadId as never,
            turnId: deps.sessionScratchpadCtx.parentTurnId as TurnId,
            createdAt: new Date().toISOString() as never,
            payload: {
              workerCallId,
              description,
              parentTurnId: deps.sessionScratchpadCtx.parentTurnId as TurnId,
              status: "ok",
              elapsedMs,
              toolCalls: toolCallCount,
              outputBytes: finalReturn.length,
            },
          } as ArisEvent);
        }
        return finalReturn;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const elapsedMs = Date.now() - startedAtMs;

        // COORD-6.1 — DRY helper for emitting the completion event
        // from any of the three failure paths below. Always called
        // with the final return string so outputBytes reflects what
        // the parent will actually see.
        const emitCompleted = (
          status: "failed" | "budget_exceeded" | "escalated",
          finalReturn: string,
          errorMessage?: string,
        ) => {
          if (deps.emitCoordinatorEvent && deps.sessionScratchpadCtx) {
            deps.emitCoordinatorEvent({
              type: "aris.worker.spawn.completed",
              threadId: deps.sessionScratchpadCtx.threadId as never,
              turnId: deps.sessionScratchpadCtx.parentTurnId as TurnId,
              createdAt: new Date().toISOString() as never,
              payload: {
                workerCallId,
                description,
                parentTurnId: deps.sessionScratchpadCtx.parentTurnId as TurnId,
                status,
                elapsedMs,
                toolCalls: toolCallCount,
                outputBytes: finalReturn.length,
                ...(errorMessage ? { errorMessage } : {}),
              },
            } as ArisEvent);
          }
        };

        // COORD-4 — Escalation sentinel. The escalate tool throws a
        // tagged error; we extract the reason and surface it as an
        // `[ESCALATED]` marker the coordinator's prompt is trained
        // to act on (re-evaluate plan, don't blindly retry).
        const escalateIdx = message.indexOf(escalationSentinel);
        if (escalateIdx >= 0) {
          const reason = message.slice(escalateIdx + escalationSentinel.length);
          const partial = finalTextParts.join("");
          console.error(
            `${tag} ESCALATED elapsed=${elapsedMs}ms toolCalls=${toolCallCount} ` +
              `textChunks=${textChunks} reason="${reason.slice(0, 200)}"`,
          );
          const ret =
            `[ESCALATED — worker '${description}' flagged a problem with the plan]\n\n` +
            `Reason: ${reason}\n\n` +
            (partial.length > 0
              ? `Partial work the worker did before escalating:\n\n${partial}\n\n`
              : "") +
            `STOP and re-evaluate. Do not spawn another worker with the same plan. ` +
            `Read the reason, decide whether to: (a) spawn a different research worker ` +
            `to fill the gap, (b) revise the synthesis with this new info, or ` +
            `(c) tell the user the original plan can't be completed and propose alternatives.`;
          emitCompleted("escalated", ret, reason.slice(0, 500));
          return ret;
        }

        // COORD-3 — Structured outcome on MaxTurnsExceeded. Detect the
        // SDK's specific exception and surface a `[BUDGET EXCEEDED]`
        // marker the coordinator's prompt (COORD-2) is trained to
        // recognize, alongside the partial assembled text and tool
        // call count. The coordinator can decide to spawn a
        // refined-scope worker rather than just retrying with more
        // turns.
        const isMaxTurns =
          /max[\s_]*turns/i.test(message) || message.toLowerCase().includes("maxturnsexceeded");

        if (isMaxTurns) {
          const partial = finalTextParts.join("");
          console.error(
            `${tag} BUDGET_EXCEEDED elapsed=${elapsedMs}ms toolCalls=${toolCallCount} ` +
              `textChunks=${textChunks} partialLen=${partial.length} cap=${turnCap}`,
          );
          const ret =
            `[BUDGET EXCEEDED — worker '${description}' hit max_turns=${turnCap} ` +
            `after ${toolCallCount} tool call(s) and ${textChunks} text chunk(s)]\n\n` +
            (partial.length > 0
              ? `Partial assembled text from this worker (treat as in-progress):\n\n${partial}\n\n`
              : "Worker produced no visible text before hitting the cap.\n\n") +
            `If you want to continue this work, spawn a NEW worker with a more focused ` +
            `prompt that narrows the scope — don't re-run with a higher max_turns; the ` +
            `worker's strategy is what burned the budget, not the budget itself.`;
          emitCompleted("budget_exceeded", ret);
          return ret;
        }

        console.error(
          `${tag} FAIL elapsed=${elapsedMs}ms toolCalls=${toolCallCount} ` +
            `textChunks=${textChunks} error="${message}"`,
        );
        const ret = `Worker '${description}' failed: ${message}`;
        emitCompleted("failed", ret, message.slice(0, 500));
        return ret;
      }
    },
  });

  return [spawnWorker];
}

/**
 * Best-effort extraction of token usage from the SDK result. The
 * shape isn't strongly typed in the public API, so we probe a few
 * known paths and return undefined if nothing matches. Cloud-side
 * metering is the actual source of truth for billing — this is for
 * the model's own visibility into worker cost.
 */
function extractUsage(result: unknown): WorkerUsage | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  // Try a few known shapes — SDK has surfaced usage under different
  // keys across versions (`usage`, `context.usage`, `state.usage`).
  const candidates: unknown[] = [r["usage"]];
  const ctx = r["context"];
  if (ctx && typeof ctx === "object") {
    candidates.push((ctx as Record<string, unknown>)["usage"]);
  }
  const state = r["state"];
  if (state && typeof state === "object") {
    candidates.push((state as Record<string, unknown>)["usage"]);
  }
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const u = c as Record<string, unknown>;
    const inputTokens = typeof u["inputTokens"] === "number" ? u["inputTokens"] : undefined;
    const outputTokens = typeof u["outputTokens"] === "number" ? u["outputTokens"] : undefined;
    const totalTokens = typeof u["totalTokens"] === "number" ? u["totalTokens"] : undefined;
    if (inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined) {
      return {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
      };
    }
  }
  return undefined;
}

/** Compact usage rendering for the tool result tail. */
function formatUsage(u: WorkerUsage): string {
  const parts: string[] = [];
  if (u.inputTokens !== undefined) parts.push(`in=${u.inputTokens}`);
  if (u.outputTokens !== undefined) parts.push(`out=${u.outputTokens}`);
  if (u.totalTokens !== undefined) parts.push(`total=${u.totalTokens}`);
  return parts.join(", ");
}
