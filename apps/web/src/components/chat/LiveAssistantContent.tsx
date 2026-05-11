import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";

/**
 * Result of the live-assistant-buffer subscription.
 *
 * `text` accumulates content-delta payloads for the current in-flight turn.
 * `turnId` is the turn id of the most recent delta. Together they let
 * `deriveMessagesTimelineRows` synthesize an in-flight assistant message row
 * inside the timeline data array (rather than rendering a separate buffer in
 * the list footer), so the streaming → settled handoff is height-neutral.
 */
export interface LiveAssistantBuffer {
  readonly text: string;
  readonly turnId: string | null;
}

const EMPTY_BUFFER: LiveAssistantBuffer = { text: "", turnId: null };

/**
 * Subscribe to a thread's live assistant content stream and accumulate the
 * delta text for the current turn.
 *
 * Source selection (Cut C, slice 3e-ii-a):
 *   - For Aris-provider threads, subscribes to the dedicated `aris.event`
 *     channel and accumulates `aris.assistant.delta` payloads. This bypasses
 *     the orchestration projection pipeline and reads the same stream that
 *     `ArisAdapter` publishes directly.
 *   - For all other providers (Codex, Claude), keeps the existing
 *     `ephemeral.subscribeReasoning` content-delta subscription. Those
 *     providers project their content through state.sqlite's ephemeral
 *     broadcast and depend on the established path.
 *
 * Output shape (`{ text, turnId }`) is identical regardless of source so
 * `deriveMessagesTimelineRows` doesn't need to know which channel produced it.
 *
 * Buffer lifecycle:
 *   - Each delta event appends to the buffer.
 *   - A new `turnId` arriving mid-stream resets the buffer (stale stream from
 *     a cancelled or reissued turn).
 *   - Thread/env/provider switch fully resets the buffer.
 *   - The buffer is never proactively cleared on settled-message arrival —
 *     callers resolve the buffer-vs-settled handoff by checking whether
 *     `timelineEntries` contains an assistant message for `turnId`, and
 *     skipping the synthetic row if so. Render-time gating beats
 *     state-clearing for handoff because it eliminates the one-frame window
 *     where neither the buffer nor the settled bubble is visible.
 */
export function useLiveAssistantBuffer(
  threadId: ThreadId | null | undefined,
  environmentId: EnvironmentId | null | undefined,
  provider: string | null | undefined,
): LiveAssistantBuffer {
  const [buffer, setBuffer] = useState<LiveAssistantBuffer>(EMPTY_BUFFER);
  const bufferRef = useRef<string>("");
  const turnIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!threadId || !environmentId) {
      bufferRef.current = "";
      turnIdRef.current = null;
      setBuffer(EMPTY_BUFFER);
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    bufferRef.current = "";
    turnIdRef.current = null;
    setBuffer(EMPTY_BUFFER);

    const appendDelta = (eventTurnId: string | null, delta: string) => {
      // New turn arriving mid-stream — drop stale buffer.
      if (turnIdRef.current !== null && eventTurnId !== null && turnIdRef.current !== eventTurnId) {
        bufferRef.current = "";
      }
      turnIdRef.current = eventTurnId;
      bufferRef.current = bufferRef.current + delta;
      setBuffer({ text: bufferRef.current, turnId: turnIdRef.current });
    };

    // DeepSeek shares ArisEventBus (per the recon's shared-bus
    // decision), so its `aris.assistant.delta` events come through
    // the same `api.aris.subscribeEvents` channel. Codex/Claude
    // continue to use the ephemeral state.sqlite content-delta path.
    const usesArisChannel = provider === "aris" || provider === "deepseek";
    const unsubscribe = usesArisChannel
      ? api.aris.subscribeEvents({ threadId }, (event) => {
          if (event.type !== "aris.assistant.delta") {
            return;
          }
          appendDelta(event.turnId ?? null, event.payload.text);
        })
      : api.ephemeral.subscribeReasoning({ threadId }, (event) => {
          if (event.kind !== "content-delta") {
            return;
          }
          appendDelta(event.payload.turnId ?? null, event.payload.delta);
        });

    return () => {
      unsubscribe();
    };
  }, [environmentId, threadId, provider]);

  return buffer;
}
