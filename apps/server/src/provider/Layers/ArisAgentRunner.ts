/**
 * ArisAgentRunner — drives an `@openai/agents` Agent and translates
 * SDK stream events into Aris bus events.
 *
 * Why this file exists:
 *   The OpenAI Agents SDK's `run()` returns a stream of typed events
 *   (raw model deltas, run-item lifecycle, agent updates). The chat UI
 *   subscribes to a different vocabulary — `aris.assistant.delta`,
 *   `aris.tool.started`, `aris.turn.completed`, etc. (see
 *   `packages/contracts/src/arisEvent.ts`). This module is the bridge:
 *   it consumes the SDK stream and publishes equivalent Aris events
 *   through a pluggable `ArisAgentEventEmitter` interface so:
 *
 *     - Production wires it to `publishArisEvent` (Effect-based) once
 *       Slice 30 retires the for-loop in ArisAdapter.
 *     - The spike wires it to a plain `console.log` emitter to verify
 *       event ordering and payload shapes without the WS infrastructure.
 *
 * Slice 27 scope:
 *   - aris.turn.started / aris.turn.completed / aris.turn.failed
 *   - aris.assistant.delta (token-level, per-iteration messageId)
 *   - aris.assistant.message.completed
 *   - aris.tool.started / aris.tool.completed
 *
 * NOT in scope (deferred):
 *   - aris.reasoning.delta — Slice 28 (Qwen `<think>` parsing)
 *   - aris.tool.completed status="error" — Slice 23 (structured errors)
 *   - aris.thread.persisted — Slice 29 (Aris envelope frames)
 *   - aris.compaction.* / aris.memory.* — server-side, unaffected
 *   - aris.approval.* — runtime-mode gates, future slice
 *   - aris.rate_limit — Slice 30 catch-handler
 *
 * Tool error semantics (carry-over):
 *   The current ArisClientTools wrappers return `{ok:false, output:"Error: …"}`
 *   on failure rather than throwing. The SDK has no way to know a string
 *   result was "an error" — so all `aris.tool.completed` events here use
 *   `status="success"` regardless of whether the underlying tool succeeded.
 *   Slice 23 changes the wrappers to throw real `Error` objects, at which
 *   point the SDK marks the result `is_error: true` and we'll branch.
 *
 * Brand-type pragmatism:
 *   ArisEvent's payloads use branded primitives (NonNegativeInt,
 *   IsoDateTime, etc.). Constructing brand-typed values inline would
 *   double the LOC here for no behavioral gain — the runner is internal
 *   infrastructure, the WS schema validates events at the boundary
 *   anyway. Each emit publishes a plain object cast `as unknown as
 *   ArisEvent` and lets the WS layer do the brand-type contract check.
 *
 * @module ArisAgentRunner
 */
import { type Agent, type AgentInputItem, run } from "@openai/agents";

import type { ArisEvent, MessageId, RuntimeMode, ThreadId, TurnId } from "@t3tools/contracts";

// Slice M.1 / H-4A — error sanitizer is shared with the DeepSeek path
// so both providers agree on what's safe to ship to the renderer. See
// `sanitizeProviderErrorForUi` for the rationale (cap length, strip
// token/key-like substrings, single-line). The Aris path was missed
// when Slice J.3 (M3-1) landed sanitization on the DeepSeek path;
// Slice M closes that parity gap.
import { sanitizeProviderErrorForUi } from "./DeepSeekAgentRunner.ts";
import { setArisEnvelopeHandler, setRequestThinkingMode } from "./ArisStreamInterceptor.ts";

// ── Emitter contract ────────────────────────────────────────────────

/**
 * Where Aris events go after the runner produces them. Production
 * passes an emitter that forwards to the live `arisEventBus`. The
 * spike passes one that just `console.log`s.
 */
export interface ArisAgentEventEmitter {
  publish(event: ArisEvent): void | Promise<void>;
}

// ── Public options ─────────────────────────────────────────────────

export interface RunArisAgentOptions {
  /** Pre-constructed Agent (model + tools + instructions). */
  readonly agent: Agent;
  /**
   * User input for this turn. Either:
   *   - A plain string (text-only turns), OR
   *   - An array of `AgentInputItem` the SDK accepts (multi-message
   *     conversations or multimodal content). For Aris's vision
   *     turns, the caller passes
   *     `[{ role: "user", content: [{type:"image_url",...}, {type:"text",text:"..."}] }]`.
   *
   * The runner forwards this to the SDK's `run()` call as-is; the SDK
   * does the OpenAI Chat Completions request body construction.
   */
  readonly prompt: string | AgentInputItem[];
  /** Active thread id (already brand-typed by caller). */
  readonly threadId: ThreadId;
  /** Turn id assigned by caller. */
  readonly turnId: TurnId;
  /** Stable id for the just-sent user message — flows into aris.turn.started. */
  readonly userMessageId: MessageId;
  /** Active runtime mode (auto-accept-edits / approval-required / full-access). */
  readonly runtimeMode: RuntimeMode;
  /** Where to publish events. */
  readonly emitter: ArisAgentEventEmitter;
  /**
   * When `true` (default), the runner emits `aris.turn.started`,
   * `aris.turn.completed`, and `aris.turn.failed` itself. Set to
   * `false` if the caller manages turn lifecycle externally — e.g.
   * ArisAdapter, which classifies errors (rate limit vs generic)
   * before emitting `aris.turn.failed` / `aris.rate_limit`. The
   * spike leaves this at default so its console emitter sees the
   * full event sequence.
   */
  readonly manageTurnLifecycle?: boolean;
  /**
   * Optional callback invoked the FIRST time the runner sees a
   * `conversation_id` field in an `aris` envelope SSE frame. The
   * caller typically writes the id into a `ConversationIdHolder` so
   * subsequent turns in the same session send it back to the server.
   * Idempotent — only fires once per turn (the field is part of
   * every frame but the handler tracks "already seen").
   */
  readonly onConversationIdReceived?: (conversationId: number) => void;
  /**
   * Slice 31 — per-message Thinking toggle. When `true` or `false`,
   * the runner sets a module-level state that ArisOpenAIClient's
   * fetch wrapper reads and injects into the chat-completions
   * request body as `chat_template_kwargs.enable_thinking`. When
   * `undefined` (default), no override is sent — server applies
   * its default (currently True). The runner clears the module
   * state in `finally` so values don't leak between turns.
   */
  readonly enableThinking?: boolean;
}

export interface RunArisAgentResult {
  readonly finalOutput: string | undefined;
  readonly messageCount: number;
}

// ── Implementation ─────────────────────────────────────────────────

const nowIso = (): string => new Date().toISOString();

/**
 * Max iterations the SDK is allowed to take per turn before throwing
 * `MaxTurnsExceeded`. The SDK's default is 10 — way too low for Aris's
 * workload where a single user prompt can drive a multi-file refactor
 * of 30+ tool calls. Slice 30h: explicitly raise to 60 so genuinely
 * complex turns don't silently terminate. The legacy custom for-loop
 * had this at 32; 60 gives ~2x headroom under the SDK runtime.
 */
const ARIS_AGENT_MAX_TURNS = 60;

// ── `<think>` stripper (Slice 28) ──────────────────────────────────
//
// Qwen3.6 emits `<think>...</think>` markers inline inside visible
// content. Per Kenny's UX call, the runner does NOT surface think
// content to the UI — tool events (aris.tool.started/completed) carry
// the verb-status indicator users actually want ("Reading X", "Running
// Y"). Think content is discarded.
//
// The challenge: SSE deltas chunk arbitrarily, so a marker can span
// chunks (e.g., "abc<thi" + "nk>secret</thi" + "nk>visible"). A
// naive regex per chunk misses it. This class is a small state
// machine: maintains an `inThink` flag and a `pending` buffer that
// holds the suffix of input that COULD be the start of a marker but
// isn't long enough to confirm yet. On each `feed()`, it returns the
// visible-only portion of the chunk.
//
// Behavior:
//   - Outside think: forward bytes; if a `<` appears, start buffering
//     until we either confirm `<think>` (switch state, drop those
//     bytes) or rule it out (flush the buffer as visible).
//   - Inside think: drop bytes; on `</think>`, exit the state, drop
//     the closing tag, resume forward.
//
// Edge cases:
//   - Stream ends mid-think (no closing tag): buffered think content
//     is silently dropped on `flush()`. The model "forgot" to close;
//     we don't surface partial reasoning.
//   - Stream ends with a buffered `<` partial-marker that turned out
//     to be normal text: `flush()` returns it.
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

class ThinkStripper {
  private inThink = false;
  private pending = ""; // partial marker suspect, outside think
  private pendingClose = ""; // partial close-marker suspect, inside think

  feed(input: string): string {
    if (input.length === 0) return "";
    let visible = "";
    for (const ch of input) {
      if (this.inThink) {
        // Looking for a closing `</think>` marker.
        this.pendingClose += ch;
        if (THINK_CLOSE.startsWith(this.pendingClose)) {
          if (this.pendingClose === THINK_CLOSE) {
            // Confirmed close: exit think mode, drop the marker.
            this.inThink = false;
            this.pendingClose = "";
          }
          // Otherwise still ambiguous — keep buffering.
        } else {
          // Not the prefix of a close marker — still inside think,
          // discard everything we held + the new char.
          this.pendingClose = "";
        }
      } else {
        // Looking for an opening `<think>` marker.
        this.pending += ch;
        if (THINK_OPEN.startsWith(this.pending)) {
          if (this.pending === THINK_OPEN) {
            // Confirmed open: drop the marker, enter think mode.
            this.inThink = true;
            this.pending = "";
            this.pendingClose = "";
          }
          // Otherwise still ambiguous — keep buffering.
        } else {
          // Bytes definitely aren't the prefix of `<think>`. Flush
          // the buffer to visible (the `<` started something else,
          // like `<div>`), then add the new char unless it itself
          // could be the start of a new marker.
          // Re-scan: walk the pending buffer + char one byte at a
          // time, emitting until we hit a `<` that could re-trigger.
          const buffered = this.pending;
          this.pending = "";
          for (const bch of buffered) {
            if (bch === "<") {
              this.pending = "<";
            } else {
              if (this.pending) visible += this.pending;
              this.pending = "";
              visible += bch;
            }
          }
        }
      }
    }
    return visible;
  }

  /**
   * Flush any leftover non-think bytes when the stream ends. Anything
   * still buffered inside a think block is dropped (model emitted an
   * unclosed `<think>` — we don't surface partial reasoning).
   */
  flush(): string {
    if (this.inThink) {
      this.inThink = false;
      this.pendingClose = "";
      return "";
    }
    const leftover = this.pending;
    this.pending = "";
    return leftover;
  }
}

/**
 * Drive an Agent end-to-end on a single user prompt, emitting Aris
 * bus events as the stream unfolds. Resolves when the stream is fully
 * consumed; throws if the SDK throws (caller wraps for the appropriate
 * `aris.turn.failed` / `aris.turn.cancelled` / `aris.rate_limit`
 * classification).
 */
export async function runArisAgent(opts: RunArisAgentOptions): Promise<RunArisAgentResult> {
  const {
    agent,
    prompt,
    threadId,
    turnId,
    userMessageId,
    runtimeMode,
    emitter,
    manageTurnLifecycle = true,
    onConversationIdReceived,
    enableThinking,
  } = opts;

  // Slice 31 — set the per-request thinking-mode state BEFORE the SDK
  // call so ArisOpenAIClient's fetch wrapper picks it up on the
  // outbound chat-completions request. Cleared in the outer
  // finally{} block so it doesn't leak across turns.
  setRequestThinkingMode(enableThinking);

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

  // Per-iteration assistant-message state. The SDK does not expose a
  // stable messageId during streaming, so we mint one when the first
  // VISIBLE text delta of an iteration arrives and clear it when the
  // matching `message_output_item` fires. Note: visible only — a delta
  // entirely consumed by `<think>` content does not start a message.
  let assistantMessageId: string | undefined;
  let assistantText = "";
  let messageCount = 0;

  // Slice 28: one stripper per turn. Qwen never spans `<think>`
  // markers across iterations in practice, so per-message would also
  // work; per-turn is simpler and tolerates an unclosed think block
  // straddling iterations (gets dropped on flush at turn end).
  const thinkStripper = new ThinkStripper();

  // Slice 29: register an envelope handler that translates aris
  // control-plane SSE frames into bus events. Cleared in finally{}
  // so the handler doesn't leak between turns.
  let conversationPersistedAlready = false;
  setArisEnvelopeHandler((envelope) => {
    if (typeof envelope.conversation_id === "number" && !conversationPersistedAlready) {
      // First frame of the turn carries conversation_id — that's
      // the earliest the client can KNOW the server persisted the
      // conversation row. Drives sidebar thread-list refresh for
      // brand-new threads. `aris.turn.started` fires too early
      // (before the chat-completion POST goes out).
      conversationPersistedAlready = true;
      const cid = envelope.conversation_id;
      void emitter.publish({
        type: "aris.thread.persisted",
        threadId,
        turnId,
        createdAt: nowIso(),
        payload: { conversationId: cid },
      } as unknown as ArisEvent);
      // Hand the id back to the caller so the next turn's request
      // body can send conversation_id and the server resumes turn
      // state instead of opening a new conversation.
      if (onConversationIdReceived) {
        try {
          onConversationIdReceived(cid);
        } catch (err) {
          console.error(
            `[ArisAgentRunner] onConversationIdReceived threw — swallowed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    if (typeof envelope.compacting === "boolean") {
      // Slice 9.2 lifecycle: server emits compacting=true before
      // awaiting a still-running background compaction, then
      // compacting=false once the wait completes. UI shows
      // "Compacting earlier turns…" indicator inline.
      void emitter.publish({
        type: envelope.compacting ? "aris.compaction.started" : "aris.compaction.completed",
        threadId,
        turnId,
        createdAt: nowIso(),
        payload: {},
      } as unknown as ArisEvent);
    }
    if (envelope.memory_changed === true) {
      // Sidebar refresh trigger when a graph-mutating memory tool
      // fired this turn. Generic — UI refetches the whole graph
      // regardless of which mutation happened.
      void emitter.publish({
        type: "aris.memory.changed",
        threadId,
        turnId,
        createdAt: nowIso(),
        payload: {},
      } as unknown as ArisEvent);
    }
    // iteration_thinking is consumed by the server-side persistence
    // parser, not the client — no bus event needed.
  });

  try {
    console.error(
      `[ArisAgentRunner Slice30h] run() start — turnId=${turnId} maxTurns=${ARIS_AGENT_MAX_TURNS}`,
    );
    const result = await run(agent, prompt, {
      stream: true,
      maxTurns: ARIS_AGENT_MAX_TURNS,
    });

    // Slice 30e — diagnostic counters, logged once per
    // message_output_item so we know what Qwen actually emitted vs
    // what survived the think-stripper. Empty final-message problem
    // (DB row clen=0) needs this visibility to diagnose whether the
    // model emitted nothing OR emitted only `<think>` content that
    // got stripped.
    let dbgRawDeltaChars = 0;
    let dbgVisibleDeltaChars = 0;
    let dbgDeltaCount = 0;

    for await (const event of result) {
      if (event.type === "raw_model_stream_event") {
        const ev = event.data;
        // The SDK emits many sub-types of raw model events; we only
        // care about visible-text deltas. Reasoning content gets
        // stripped here (Slice 28); tool events carry the verb-status
        // indicator the UI shows in place of think content.
        if (ev.type === "output_text_delta" && typeof ev.delta === "string") {
          dbgRawDeltaChars += ev.delta.length;
          dbgDeltaCount += 1;
          const visible = thinkStripper.feed(ev.delta);
          if (visible.length === 0) {
            // Either entirely think content or buffered for marker
            // disambiguation. Don't emit a delta for empty visible.
            continue;
          }
          dbgVisibleDeltaChars += visible.length;
          if (!assistantMessageId) {
            assistantMessageId = `assistant:${turnId}-${Date.now()}`;
            assistantText = "";
          }
          assistantText += visible;
          await publish({
            type: "aris.assistant.delta",
            threadId,
            turnId,
            createdAt: nowIso(),
            payload: {
              messageId: assistantMessageId,
              text: visible,
            },
          });
        }
        continue;
      }

      if (event.type === "run_item_stream_event") {
        const item = event.item;

        if (item.type === "message_output_item") {
          // Drain any buffered non-think tail before completing the
          // message. Without this, a final partial-marker suspect
          // (e.g. an unparseable `<` at the end of stream) would be
          // dropped silently.
          const tail = thinkStripper.flush();
          if (tail.length > 0) {
            if (!assistantMessageId) {
              assistantMessageId = `assistant:${turnId}-${Date.now()}`;
              assistantText = "";
            }
            assistantText += tail;
            await publish({
              type: "aris.assistant.delta",
              threadId,
              turnId,
              createdAt: nowIso(),
              payload: {
                messageId: assistantMessageId,
                text: tail,
              },
            });
          }
          // Slice 30e — diagnostic. Logged whether or not the message
          // was assembled, so we see what the model emitted even when
          // the visible text ended up empty after think-stripping.
          console.error(
            `[ArisAgentRunner Slice30e] message_output_item: ` +
              `deltas=${dbgDeltaCount} ` +
              `rawChars=${dbgRawDeltaChars} ` +
              `visibleChars=${dbgVisibleDeltaChars} ` +
              `assistantTextLen=${assistantText.length} ` +
              `messageId=${assistantMessageId ?? "<none>"}`,
          );
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
          // Reset per-iteration counters so the next iteration's
          // numbers are accurate.
          dbgRawDeltaChars = 0;
          dbgVisibleDeltaChars = 0;
          dbgDeltaCount = 0;
          continue;
        }

        if (item.type === "tool_call_item") {
          // The rawItem is a discriminated union; for function calls
          // the shape is { type: "function_call", callId, name,
          // arguments }. We narrow defensively — anything other than
          // function_call we don't surface as an Aris tool event.
          const raw = item.rawItem;
          if (
            raw.type === "function_call" &&
            typeof raw.callId === "string" &&
            typeof raw.name === "string"
          ) {
            const argsRaw = typeof raw.arguments === "string" ? raw.arguments : "";
            let args: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(argsRaw);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                args = parsed as Record<string, unknown>;
              }
            } catch {
              // Malformed arguments JSON — surface as empty args. The
              // tool will fail with a validation error which we
              // capture in tool.completed.
              args = {};
            }
            console.error(
              `[ArisAgentRunner Slice30e] tool_call_item: ` +
                `name=${raw.name} callId=${raw.callId} argsBytes=${argsRaw.length}`,
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
          const callId = "callId" in raw && typeof raw.callId === "string" ? raw.callId : undefined;
          if (callId) {
            const output = item.output;
            const outputStr = typeof output === "string" ? output : JSON.stringify(output);
            const preview = outputStr.length > 500 ? outputStr.slice(0, 500) : outputStr;
            console.error(
              `[ArisAgentRunner Slice30e] tool_call_output_item: ` +
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

      // agent_updated_stream_event and any unknown event types fall
      // through silently — nothing to publish on those today.
    }

    await result.completed;

    // Slice 30e — final tally so we can confirm what the SDK
    // ultimately reported as the turn's output.
    const finalOutputStr = typeof result.finalOutput === "string" ? result.finalOutput : "";
    console.error(
      `[ArisAgentRunner Slice30e] result.completed: ` +
        `messageCount=${messageCount} ` +
        `finalOutputLen=${finalOutputStr.length} ` +
        `finalOutputPreview=${JSON.stringify(finalOutputStr.slice(0, 120))}`,
    );

    // ── aris.turn.completed ──────────────────────────────────────
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
    // ── Slice 30i — graceful MaxTurnsExceeded handling ──────────
    //
    // The SDK throws when iteration count exceeds ARIS_AGENT_MAX_TURNS.
    // Without special handling this propagates as
    // ProviderAdapterRequestError → aris.error + aris.turn.failed,
    // which the chat UI renders as an error banner. That's a bad UX
    // for what's actually just "the model was busy and ran out of
    // budget" — the user should be able to send another message and
    // continue.
    //
    // Detect the SDK's "Max turns (N) exceeded" error by message
    // pattern (no exported error class name to import cleanly) and
    // emit a synthetic assistant message + return cleanly. The
    // outer ArisAdapter catch handler then sees a successful
    // result and publishes aris.turn.completed normally.
    //
    // This message is live-only (not persisted to aris_memory.db).
    // If the user reloads, the message disappears — that's
    // intentional, since reload-survival isn't critical for a
    // continuation prompt that immediately gets answered.
    const errMsg = err instanceof Error ? err.message : String(err);
    const isMaxTurns = /\bmax\s*turns?\b/i.test(errMsg) && /\bexceed/i.test(errMsg);
    if (isMaxTurns) {
      const cappedText =
        `Hit the agent step cap (${ARIS_AGENT_MAX_TURNS}) for this turn. ` +
        `I got through a chunk of the work above — some done, some pending. ` +
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
        `[ArisAgentRunner Slice30i] MaxTurnsExceeded handled gracefully — ` +
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

      return {
        finalOutput: cappedText,
        messageCount,
      };
    }

    // Not a cap-hit — real error. Original handling: emit
    // aris.turn.failed if owning lifecycle, then re-throw so
    // outer catch (ArisAdapter) can classify and publish.
    //
    // Slice M.1 / H-4A — errMsg here can carry SDK-thrown content
    // that includes auth headers, raw prompt fragments echoed back, or
    // provider-side stack traces. Run through the same sanitizer the
    // DeepSeek path uses (caps 512 chars, strips bearer/sk-/long hex
    // and base64 blobs, single-line) before publishing to the UI bus.
    if (manageTurnLifecycle) {
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
    // Clear the envelope handler so it doesn't leak into the next
    // turn or pollute another runner that might be active.
    setArisEnvelopeHandler(null);
    // Slice 31 — same hygiene for the thinking-mode override.
    setRequestThinkingMode(undefined);
  }
}
