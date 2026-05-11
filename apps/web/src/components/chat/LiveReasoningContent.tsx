/**
 * LiveReasoningContent — accumulates `aris.reasoning.delta` payloads for
 * the active Aris thread and renders them as a collapsible "Show thinking"
 * block above the in-flight assistant message.
 *
 * Slice 1.12 (Reasoning UI regression fix).
 *
 * Pre-Cut-C the orchestration pipeline carried reasoning tokens into
 * state.sqlite's projection and the chat renderer surfaced them. Cut C
 * moved Aris onto her own dedicated `ArisEventBus`; the server publishes
 * `aris.reasoning.delta` correctly (see `ArisAdapter.ts:733`) and the
 * contract schema exists (`packages/contracts/src/arisEvent.ts:210`),
 * but no web-side subscriber consumed them — so reasoning silently
 * disappeared from the UI for Aris-provider threads. This module fixes
 * that gap.
 *
 * Architecture mirrors `LiveAssistantContent.tsx`:
 *   - `useLiveReasoningBuffer` accumulates delta text for the current turn
 *   - The live buffer is rendered above the streaming assistant row in
 *     `MessagesTimeline`, distinct from but adjacent to the answer
 *
 * Buffer lifecycle:
 *   - Each `aris.reasoning.delta` event appends to the buffer
 *   - A new `turnId` resets the buffer (stale stream from a cancelled
 *     or reissued turn)
 *   - Thread/env/provider switch fully resets the buffer
 *   - Buffer is never proactively cleared on settled-message arrival —
 *     the renderer chooses to fade or collapse the block as needed,
 *     same as the assistant buffer pattern
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { readEnvironmentApi } from "../../environmentApi";
import { cn } from "~/lib/utils";

export interface LiveReasoningBuffer {
  /** Accumulated reasoning text for the current in-flight turn. */
  readonly text: string;
  /** Turn id of the most recent delta — null until first delta arrives. */
  readonly turnId: string | null;
}

const EMPTY_BUFFER: LiveReasoningBuffer = { text: "", turnId: null };

/**
 * Subscribe to a thread's reasoning event stream and accumulate the
 * delta text for the current turn. Aris-only — Codex / Claude have their
 * own reasoning paths through the orchestration pipeline (out of scope
 * for this fix).
 */
export function useLiveReasoningBuffer(
  threadId: ThreadId | null | undefined,
  environmentId: EnvironmentId | null | undefined,
  provider: string | null | undefined,
): LiveReasoningBuffer {
  const [buffer, setBuffer] = useState<LiveReasoningBuffer>(EMPTY_BUFFER);
  const bufferRef = useRef<string>("");
  const turnIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Subscribe for Aris and DeepSeek threads — both publish
    // `aris.reasoning.delta` events through ArisEventBus (DeepSeek's
    // sibling reasoning_content gets routed to that event type by
    // DeepSeekAgentRunner). Codex carries reasoning via
    // codex/event/reasoning_content_delta; Claude via content.delta
    // with reasoning kind — those paths are separate slices.
    const usesArisReasoningChannel = provider === "aris" || provider === "deepseek";
    if (!usesArisReasoningChannel || !threadId || !environmentId) {
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

    const unsubscribe = api.aris.subscribeEvents({ threadId }, (event) => {
      if (event.type !== "aris.reasoning.delta") {
        return;
      }
      const eventTurnId = event.turnId ?? null;
      // New turn arriving mid-stream → drop stale buffer.
      if (turnIdRef.current !== null && eventTurnId !== null && turnIdRef.current !== eventTurnId) {
        bufferRef.current = "";
      }
      turnIdRef.current = eventTurnId;
      bufferRef.current = bufferRef.current + event.payload.text;
      setBuffer({ text: bufferRef.current, turnId: turnIdRef.current });
    });

    return () => {
      unsubscribe();
    };
  }, [environmentId, threadId, provider]);

  return buffer;
}

interface LiveReasoningBlockProps {
  readonly text: string;
  /** True while the assistant is still streaming (auto-expand). When the
   *  message settles, the block is collapsed by default — user can
   *  re-expand to inspect the trace. */
  readonly streaming: boolean;
}

/**
 * Render the reasoning text as a collapsible block. Auto-expanded while
 * streaming so the user sees Aris thinking; auto-collapsed (with the
 * preview line) when the turn settles, since the answer is what matters
 * after the fact.
 */
export function LiveReasoningBlock({ text, streaming }: LiveReasoningBlockProps) {
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);
  // While streaming → expanded. After settle → collapsed unless user has
  // explicitly toggled. Manual toggle wins over the streaming default.
  const expanded = manuallyToggled ?? streaming;

  if (!text.trim()) return null;

  return (
    <div className="mb-1 rounded-md border border-border/30 bg-background/20">
      <button
        type="button"
        onClick={() => setManuallyToggled(!expanded)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px] tracking-widest text-muted-foreground/50 uppercase hover:text-muted-foreground/80"
      >
        {expanded ? (
          <ChevronDownIcon className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
        <span>Thinking</span>
        {streaming ? (
          <span className="ml-1 text-muted-foreground/30 normal-case tracking-normal">…</span>
        ) : null}
      </button>
      {expanded ? (
        <div
          className={cn(
            "border-t border-border/20 px-3 py-2 text-[12px] leading-relaxed",
            "text-muted-foreground/70 italic whitespace-pre-wrap",
          )}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}
