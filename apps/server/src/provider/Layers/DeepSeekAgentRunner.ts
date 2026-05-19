/**
 * DeepSeekAgentRunner — drives an `@openai/agents` Agent against
 * DeepSeek (via the cloud trusted-caller proxy) and translates SDK
 * stream events into the same `aris.*` bus event vocabulary the UI
 * already consumes.
 *
 * Why this is forked from `ArisAgentRunner` and not extracted:
 *   ArisAgentRunner does several things DeepSeek doesn't need —
 *   `<think>...</think>` stripping (Slice 28 ThinkStripper), envelope
 *   handler for `data: {"aris":{...}}` frames (Slice 29 — conversation
 *   id, compaction, memory_changed), and `enable_thinking`
 *   chat_template_kwarg routing (Slice 31). DeepSeek replaces all of
 *   that with one cleaner mechanism: `reasoning_content` is a sibling
 *   field on each delta, extracted by `DeepSeekStreamInterceptor`
 *   (Slice 33b) and routed here as `aris.reasoning.delta` events.
 *
 *   The shared substrate (event publishing, tool event mapping,
 *   max-turns recovery) is genuinely identical across providers and
 *   would be a good extraction target — but per the recon memory's
 *   "Lean: ship DeepSeek as a fork, schedule consolidation slice
 *   after both providers are battle-tested" guidance, we fork now and
 *   refactor when both adapters have had real-world miles on them.
 *
 * Event vocabulary:
 *   - aris.turn.started / aris.turn.completed / aris.turn.failed
 *   - aris.assistant.delta / aris.assistant.message.completed
 *   - aris.tool.started / aris.tool.completed
 *   - aris.reasoning.delta (NEW route — the dropdown UI already
 *     consumes this from Aris; we send the same shape so the same
 *     component renders DeepSeek's chain-of-thought)
 *
 *   Bus events keep the `aris.` prefix even for DeepSeek because the
 *   UI is stable on that vocabulary. The recon memory flagged the
 *   bus-naming question as "open architectural" — going with the
 *   shared bus per path of least resistance. Rename slice if/when
 *   we add a third event-aware provider.
 *
 * NOT in scope (deferred to other slices):
 *   - Cost-pill / usage capture for billing UI — Slice 33j hooks into
 *     the SDK's run result and emits its own event.
 *   - Sub-agent / fork-mode (skills) — Slice 33's skills system uses
 *     `ArisAdapter`'s fork executor; if DeepSeek wants the same it
 *     wires its adapter the same way (Slice 33f).
 *
 * @module DeepSeekAgentRunner
 */
import {
  type Agent,
  type AgentInputItem,
  type RunState,
  type RunToolApprovalItem,
  run,
} from "@openai/agents";

import type {
  ArisEvent,
  DeepSeekReasoningEffort,
  MessageId,
  ProviderApprovalDecision,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { getRequestReasoningEffort, setRequestReasoningEffort } from "./DeepSeekOpenAIClient.ts";
import { formatRunnerToolCallLog } from "./DeepSeekToolCallLog.ts";
import {
  clearReasoningRoundtripCache,
  setDeepSeekReasoningHandler,
} from "./DeepSeekStreamInterceptor.ts";

// ── Emitter contract (same shape as Aris's) ────────────────────────

export interface DeepSeekAgentEventEmitter {
  publish(event: ArisEvent): void | Promise<void>;
}

// ── Public options ─────────────────────────────────────────────────

export interface RunDeepSeekAgentOptions {
  /** Pre-constructed Agent (model + tools + instructions). */
  readonly agent: Agent;
  /**
   * User input for this turn. Same shape as the Aris runner — string
   * or array of `AgentInputItem` for multi-message conversations.
   */
  readonly prompt: string | AgentInputItem[];
  /** Active thread id (already brand-typed by caller). */
  readonly threadId: ThreadId;
  /** Turn id assigned by caller. */
  readonly turnId: TurnId;
  /** Stable id for the just-sent user message. */
  readonly userMessageId: MessageId;
  /** Active runtime mode (auto-accept-edits / approval-required / full-access). */
  readonly runtimeMode: RuntimeMode;
  /** Where to publish events. */
  readonly emitter: DeepSeekAgentEventEmitter;
  /**
   * When `true` (default), the runner emits `aris.turn.started`,
   * `aris.turn.completed`, and `aris.turn.failed` itself. Set to
   * `false` if the caller manages turn lifecycle externally —
   * `DeepSeekAdapter` (Slice 33f) does its own error classification
   * before emitting failure events.
   */
  readonly manageTurnLifecycle?: boolean;
  /**
   * Per-message reasoning effort. When set, the runner stashes it into
   * the module-level holder that `DeepSeekOpenAIClient`'s fetch wrapper
   * reads to inject `thinking: { type: "enabled" }` + `reasoning_effort`
   * into the chat-completions request body. `undefined` (default) means
   * the cloud applies its default depth. Cleared in `finally{}` so it
   * doesn't leak across turns.
   */
  readonly reasoningEffort?: DeepSeekReasoningEffort;
  /**
   * Approval gateway (#22). Called when the SDK pauses the agent run
   * with a tool-approval interruption (a `bash` / `write_file` /
   * `edit_file` call against a runtime mode that requires gating).
   *
   * The callback should:
   *   1. Surface the approval request to the user (via `aris.approval.requested` event)
   *   2. Wait for the user's decision via the existing pendingApprovals
   *      Deferred + `respondToRequest` RPC pipeline
   *   3. Resolve with the chosen `ProviderApprovalDecision`
   *
   * When omitted, the runner auto-rejects every interruption (safe
   * default — never silently runs gated tools without a gateway).
   * `DeepSeekAdapter` provides the production implementation.
   */
  readonly requestApproval?: (item: RunToolApprovalItem) => Promise<ProviderApprovalDecision>;
}

export interface RunDeepSeekAgentResult {
  readonly finalOutput: string | undefined;
  readonly messageCount: number;
}

// ── Implementation ─────────────────────────────────────────────────

const nowIso = (): string => new Date().toISOString();

/**
 * Slice J.3 / M3-1 fix (2026-05-16) — sanitize an SDK / network error
 * message for safe publishing to the UI event bus.
 *
 * V8 / SDK / network error messages can carry user-controlled or
 * secret content: full request URLs (with auth query strings), HTTP
 * response bodies that echo input back, provider-side stack traces.
 * Raw `err.message` is appropriate for server-side stderr where the
 * operator is debugging; it is NOT appropriate for the renderer where
 * it persists in browser memory, screenshots, screen-shared video, or
 * error reports the user later submits.
 *
 * The sanitizer:
 *   1. Caps the message at 512 chars (typical legitimate provider
 *      errors are < 200 chars; pathological multi-KB strings get
 *      truncated).
 *   2. Strips substrings that look like bearer tokens or API keys —
 *      hex/base64 runs of ≥20 chars, `sk-...` prefixes, `Bearer ...`
 *      headers. Replaced with `<redacted>` so the message remains
 *      readable while the secret is gone.
 *   3. Strips newlines so multi-line stack traces don't bloat the UI
 *      string (the first line of an error is almost always enough).
 */
export const SANITIZED_ERROR_MAX_CHARS = 512;
const TOKEN_LIKE_RE =
  /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/=]{40,})/g;
export function sanitizeProviderErrorForUi(raw: string): string {
  const oneLine = raw.replace(/[\r\n]+/g, " ").trim();
  const redacted = oneLine.replace(TOKEN_LIKE_RE, "<redacted>");
  if (redacted.length <= SANITIZED_ERROR_MAX_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, SANITIZED_ERROR_MAX_CHARS)}…`;
}

/**
 * Default max iterations the SDK is allowed to take per turn before
 * throwing `MaxTurnsExceeded`. Aris's 60-cap was tuned for its
 * smaller context window — DS V4-Pro's 1M window can sustain much
 * longer agentic loops on real refactors (200+ tool calls observed
 * in practice on multi-file work).
 *
 * Override via env: `ARIS_DS_AGENT_MAX_TURNS` — useful for debugging
 * runaway loops without touching the source. Set to a small number
 * (e.g. 5) to see the cap-hit path; set to a big number (e.g. 500)
 * for an audit task that legitimately needs many iterations.
 */
const DEFAULT_DEEPSEEK_AGENT_MAX_TURNS = 200;

function getDeepSeekAgentMaxTurns(): number {
  const raw = process.env["ARIS_DS_AGENT_MAX_TURNS"]?.trim();
  if (raw && raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_DEEPSEEK_AGENT_MAX_TURNS;
}

/**
 * Drive an Agent end-to-end on a single user prompt against DeepSeek,
 * emitting bus events as the stream unfolds. Resolves when the stream
 * is fully consumed; throws if the SDK throws (caller wraps for the
 * appropriate failure classification).
 */
export async function runDeepSeekAgent(
  opts: RunDeepSeekAgentOptions,
): Promise<RunDeepSeekAgentResult> {
  const {
    agent,
    prompt,
    threadId,
    turnId,
    userMessageId,
    runtimeMode,
    emitter,
    manageTurnLifecycle = true,
    reasoningEffort,
    requestApproval,
  } = opts;

  // Stash the per-request reasoning effort BEFORE the SDK call so
  // `DeepSeekOpenAIClient`'s fetch wrapper picks it up on the
  // outbound chat-completions request. Cleared in `finally{}` below
  // so it doesn't leak across turns.
  setRequestReasoningEffort(reasoningEffort);

  const publish = async (raw: Record<string, unknown>): Promise<void> => {
    await emitter.publish(raw as unknown as ArisEvent);
  };

  // ── aris.turn.started ────────────────────────────────────────────
  if (manageTurnLifecycle) {
    await publish({
      type: "aris.turn.started",
      threadId,
      turnId,
      createdAt: nowIso(),
      payload: { userMessageId, runtimeMode },
    });
  }

  // Per-iteration assistant-message state. Same minting rule as
  // ArisAgentRunner — first VISIBLE delta of an iteration mints a
  // message id; cleared on `message_output_item`.
  let assistantMessageId: string | undefined;
  let assistantText = "";
  let messageCount = 0;

  // Wire the reasoning interceptor's handler so DeepSeek's sibling
  // `reasoning_content` deltas surface as bus events rather than
  // being silently dropped. The `aris.reasoning.delta` payload is
  // just `{ text }` — there's no companion `*.message.completed`
  // event in the contract; the dropdown UI infers end-of-reasoning
  // when `aris.assistant.delta` starts arriving (per the recon,
  // DeepSeek's stream emits all reasoning_content first, then all
  // content). Cleared in `finally{}` so the handler doesn't leak
  // between turns or to other runners.
  setDeepSeekReasoningHandler((deltaText) => {
    if (deltaText.length === 0) return;
    void emitter.publish({
      type: "aris.reasoning.delta",
      threadId,
      turnId,
      createdAt: nowIso(),
      payload: { text: deltaText },
    } as unknown as ArisEvent);
  });

  try {
    const maxTurns = getDeepSeekAgentMaxTurns();
    console.error(
      `[DeepSeekAgentRunner] run() start — turnId=${turnId} ` +
        `maxTurns=${maxTurns} ` +
        `reasoningEffort=${getRequestReasoningEffort() ?? "<cloud-default>"}`,
    );

    // #22 — Approval gate loop. The SDK pauses the agent run with an
    // interruption when a `needsApproval`-flagged tool fires. We
    // resume by calling state.approve()/reject() per interruption,
    // then re-running with the state object. Repeat until the run
    // completes without any pending approvals. When no `requestApproval`
    // gateway is provided, we auto-reject every interruption (safe
    // default).
    let currentInput: typeof prompt | RunState<unknown, Agent<unknown, "text">> = prompt;
    let result!: Awaited<ReturnType<typeof run>>;
    let approvalIteration = 0;
    while (true) {
      result = await run(agent, currentInput as never, {
        stream: true,
        maxTurns,
      });

      let dbgDeltaCount = 0;
      let dbgDeltaChars = 0;

      for await (const event of result) {
        if (event.type === "raw_model_stream_event") {
          const ev = event.data;
          if (ev.type === "output_text_delta" && typeof ev.delta === "string") {
            // Visible-text delta — the SDK has already had the
            // `reasoning_content` field stripped by
            // DeepSeekStreamInterceptor before this event reached us,
            // so `ev.delta` is pure visible content. No think-stripping
            // needed.
            dbgDeltaCount += 1;
            dbgDeltaChars += ev.delta.length;
            if (!assistantMessageId) {
              assistantMessageId = `assistant:${turnId}-${Date.now()}`;
              assistantText = "";
            }
            assistantText += ev.delta;
            await publish({
              type: "aris.assistant.delta",
              threadId,
              turnId,
              createdAt: nowIso(),
              payload: {
                messageId: assistantMessageId,
                text: ev.delta,
              },
            });
          }
          continue;
        }

        if (event.type === "run_item_stream_event") {
          const item = event.item;

          if (item.type === "message_output_item") {
            // Iteration boundary. Close out any in-flight assistant
            // message; reasoning has no companion completed event in
            // the contract so it just stops emitting deltas (the
            // dropdown UI handles that case).
            if (assistantMessageId) {
              await publish({
                type: "aris.assistant.message.completed",
                threadId,
                turnId,
                createdAt: nowIso(),
                payload: {
                  messageId: assistantMessageId,
                  finalText: assistantText,
                  contentLength: assistantText.length,
                },
              });
              messageCount += 1;
              assistantMessageId = undefined;
              assistantText = "";
            }
            console.error(
              `[DeepSeekAgentRunner] message_output_item: ` +
                `deltas=${dbgDeltaCount} chars=${dbgDeltaChars}`,
            );
            dbgDeltaCount = 0;
            dbgDeltaChars = 0;
            continue;
          }

          if (item.type === "tool_call_item") {
            const raw = item.rawItem;
            if (
              raw.type === "function_call" &&
              typeof raw.callId === "string" &&
              typeof raw.name === "string"
            ) {
              const argsRaw = typeof raw.arguments === "string" ? raw.arguments : "";
              let args: Record<string, unknown> = {};
              let parseError: string | null = null;
              try {
                const parsed = JSON.parse(argsRaw);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  args = parsed as Record<string, unknown>;
                } else {
                  parseError = `parsed value is not an object: ${typeof parsed}`;
                }
              } catch {
                // Slice H.2 / H3-1 fix (2026-05-16) — V8's `JSON.parse`
                // error messages embed input snippets for common failure
                // modes (e.g. `Unexpected token 'b', "{"apiKey": badvalue}"
                // is not valid JSON`). The pre-Slice-H code captured
                // `err.message` directly, which leaked the offending JSON
                // body — including any secrets the tool call carried — into
                // stderr via the formatter below. The Slice A H12 fix made
                // the formatter only accept `argsBytes: number`, but
                // `parseError` was a separate string field that bypassed
                // that guarantee. We now record only a byte-count-stamped
                // generic message: no user-controlled content can land
                // here, by construction.
                parseError = `invalid JSON (${argsRaw.length} bytes)`;
                args = {};
              }
              // Slice A (H12 fix) — args content removed from stderr.
              // The shared formatter only accepts argsBytes (a number), so
              // it's compile-time impossible to leak the args value here.
              // Slice H.2 (H3-1 fix) — parseError is now a server-generated
              // byte-count message (see catch above), not V8's
              // input-embedding error message. Both channels are now
              // structurally incapable of carrying user-controlled content.
              console.error(
                formatRunnerToolCallLog({
                  toolName: raw.name,
                  callId: raw.callId,
                  argsBytes: argsRaw.length,
                  ...(parseError !== null ? { parseError } : {}),
                }),
              );
              await publish({
                type: "aris.tool.started",
                threadId,
                turnId,
                createdAt: nowIso(),
                payload: {
                  toolCallId: raw.callId,
                  name: raw.name,
                  args,
                },
              });
            }
            continue;
          }

          if (item.type === "tool_call_output_item") {
            const raw = item.rawItem;
            const callId =
              "callId" in raw && typeof raw.callId === "string" ? raw.callId : undefined;
            if (callId) {
              const output = item.output;
              const outputStr = typeof output === "string" ? output : JSON.stringify(output);
              const preview = outputStr.length > 500 ? outputStr.slice(0, 500) : outputStr;
              console.error(
                `[DeepSeekAgentRunner] tool_call_output_item: ` +
                  `callId=${callId} outputBytes=${outputStr.length}`,
              );
              await publish({
                type: "aris.tool.completed",
                threadId,
                turnId,
                createdAt: nowIso(),
                payload: {
                  toolCallId: callId,
                  status: "success",
                  resultPreview: preview,
                },
              });
            }
            continue;
          }
        }
        // RW-1 diagnostic — surface unknown event/item shapes so we can
        // see what the SDK is actually feeding the loop. The 60-turn
        // cap was hitting on simple tasks with only ONE visible
        // tool_call_item logged; everything else was invisible. This
        // logs every top-level event type and every run_item subtype
        // that isn't already handled above. Remove once we understand
        // what's looping.
        if (event.type === "run_item_stream_event") {
          const item = event.item;
          const itemType = item.type;
          if (
            itemType !== "message_output_item" &&
            itemType !== "tool_call_item" &&
            itemType !== "tool_call_output_item"
          ) {
            const raw = (item as { rawItem?: { type?: string } }).rawItem;
            const rawType = raw && typeof raw.type === "string" ? raw.type : "<unknown>";
            console.error(
              `[DeepSeekAgentRunner] UNHANDLED run_item: itemType=${itemType} rawType=${rawType}`,
            );
          }
        }
        // Other top-level event types (`raw_model_stream_event`,
        // `agent_updated_stream_event`) are intentionally ignored — the
        // SDK's type system narrows the universe to exactly those plus
        // `run_item_stream_event`, and the no-op behavior is correct.
      }

      await result.completed;

      // #22 — After the stream drains, check whether the run paused on
      // any `needsApproval` interruptions. If so, we surface each one
      // through the approval gateway, apply the user's decision via
      // state.approve/reject, and re-enter the loop with the resumed
      // state. If not, we break and proceed to the normal finalize
      // path below.
      const interruptions = result.interruptions ?? [];
      if (interruptions.length === 0) {
        break;
      }
      console.error(
        `[DeepSeekAgentRunner] approval interruption — turnId=${turnId} ` +
          `iter=${approvalIteration} pending=${interruptions.length}`,
      );
      for (const item of interruptions) {
        let decision: ProviderApprovalDecision;
        if (requestApproval) {
          try {
            decision = await requestApproval(item);
          } catch (gatewayErr) {
            console.warn(
              `[DeepSeekAgentRunner] approval gateway threw — auto-rejecting: ${
                gatewayErr instanceof Error ? gatewayErr.message : String(gatewayErr)
              }`,
            );
            decision = "decline";
          }
        } else {
          // No gateway wired — never silently approve. Reject so the
          // model gets a clean "user said no" signal and can decide
          // what to do next.
          decision = "decline";
        }
        if (decision === "accept" || decision === "acceptForSession") {
          result.state.approve(item, {
            alwaysApprove: decision === "acceptForSession",
          });
        } else {
          // "decline" or "cancel" — both reject. cancel implies user
          // wants to abort the whole turn; the model will get the
          // rejection and typically wraps up.
          result.state.reject(item);
        }
      }
      // The cast goes through `unknown` because `RunState`'s generic
      // signature doesn't structurally overlap with `AgentInputItem[]`,
      // even though the SDK's run() overload accepts both at the value
      // level. Safe: result.state is the exact type we want for the
      // next iteration's resume call.
      currentInput = result.state as unknown as typeof currentInput;
      approvalIteration += 1;
    }

    const finalOutputStr = typeof result.finalOutput === "string" ? result.finalOutput : "";
    console.error(
      `[DeepSeekAgentRunner] result.completed: ` +
        `messageCount=${messageCount} ` +
        `finalOutputLen=${finalOutputStr.length} ` +
        `approvalIterations=${approvalIteration}`,
    );

    if (manageTurnLifecycle) {
      await publish({
        type: "aris.turn.completed",
        threadId,
        turnId,
        createdAt: nowIso(),
        payload: { messageCount },
      });
    }

    return {
      finalOutput: typeof result.finalOutput === "string" ? result.finalOutput : undefined,
      messageCount,
    };
  } catch (err) {
    // Mirror Aris's MaxTurnsExceeded recovery: convert the SDK's
    // hard throw into a soft "we ran out of budget, ask again to
    // continue" assistant message so the chat UI doesn't render an
    // error banner for what's really just a continuation prompt.
    const errMsg = err instanceof Error ? err.message : String(err);
    const isMaxTurns = /\bmax\s*turns?\b/i.test(errMsg) && /\bexceed/i.test(errMsg);
    if (isMaxTurns) {
      const cappedText =
        `Hit the agent step cap (${getDeepSeekAgentMaxTurns()}) for this turn. ` +
        `Got partway through the work above — some done, some pending. ` +
        `Send another message and I'll pick up where I left off.`;
      const cappedMessageId = `assistant:${turnId}-cap-${Date.now()}`;
      await publish({
        type: "aris.assistant.delta",
        threadId,
        turnId,
        createdAt: nowIso(),
        payload: { messageId: cappedMessageId, text: cappedText },
      });
      await publish({
        type: "aris.assistant.message.completed",
        threadId,
        turnId,
        createdAt: nowIso(),
        payload: {
          messageId: cappedMessageId,
          finalText: cappedText,
          contentLength: cappedText.length,
        },
      });
      messageCount += 1;
      console.error(
        `[DeepSeekAgentRunner] MaxTurnsExceeded handled gracefully — ` +
          `turnId=${turnId} synthetic message emitted, returning normally`,
      );
      if (manageTurnLifecycle) {
        await publish({
          type: "aris.turn.completed",
          threadId,
          turnId,
          createdAt: nowIso(),
          payload: { messageCount },
        });
      }
      return { finalOutput: cappedText, messageCount };
    }

    if (manageTurnLifecycle) {
      // Slice J.3 / M3-1 fix (2026-05-16) — sanitize the error message
      // before publishing it onto the UI event bus. `err.message` can
      // carry SDK-generated content that includes request URLs (with
      // auth query params), HTTP response bodies (with API key
      // fragments echoed back), or provider-side stack traces. The
      // raw string is fine for server-side logs but should NOT flow
      // verbatim to the renderer where it can land in browser history,
      // screenshots, or shared error reports. Cap to 512 chars and
      // strip anything that looks like a bearer token or sk- key.
      await publish({
        type: "aris.turn.failed",
        threadId,
        turnId,
        createdAt: nowIso(),
        payload: { errorMessage: sanitizeProviderErrorForUi(errMsg) },
      });
    }
    throw err;
  } finally {
    // Hygiene: clear all module-level holders so they don't leak
    // into the next turn or pollute another runner that might be
    // active. The roundtrip cache MUST be cleared between runs —
    // tool_call_ids from a prior turn would otherwise inject stale
    // reasoning into a new turn's assistant messages by id collision.
    setDeepSeekReasoningHandler(null);
    setRequestReasoningEffort(undefined);
    clearReasoningRoundtripCache();
  }
}
