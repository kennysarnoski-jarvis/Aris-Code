import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import type { WorkLogEntry } from "../../session-logic";
import { cn } from "~/lib/utils";

interface RollingReasoningProps {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  /**
   * Provider for the active thread. Routes the "actively streaming" signal
   * source: Aris threads listen for `aris.assistant.delta` on the dedicated
   * channel; other providers stay on the existing ephemeral content-delta
   * subscription.
   */
  readonly provider: string | null;
  /**
   * Slice 31 — snapshotted Thinking toggle for the in-flight Aris turn.
   * `null` means unknown / not Aris (use the "Thinking…" default);
   * `false` swaps the idle phrase to a non-reasoning verb so the live
   * status doesn't claim Aris is "Thinking…" when `<think>` blocks are
   * disabled for this turn.
   */
  readonly thinkingEnabled?: boolean | null;
  readonly latestWorkEntry: WorkLogEntry | null;
  readonly className?: string;
}

const HOLD_MS = 600; // min time any status stays visible before being replaced
const ELAPSED_THRESHOLD_MS = 5_000; // start showing " · Xs" after this long
const SLOW_THRESHOLD_MS = 30_000; // rotate to "Still ..." phrasing after this long
const ROTATION_INTERVAL_MS = 15_000; // step further once we're past slow threshold
const STREAM_GRACE_MS = 500; // content-delta within this window = actively streaming
const TICK_MS = 250;

interface ActivityDescriptor {
  readonly key: string;
  readonly phrases: ReadonlyArray<string>;
}

interface DisplayState {
  readonly descriptor: ActivityDescriptor;
  readonly startedAt: number;
}

function basename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

function truncateMiddle(value: string, max = 60): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function extractToolName(entry: WorkLogEntry): string | null {
  const direct = entry.toolTitle?.trim();
  if (direct) return direct.toLowerCase();
  const raw = (entry.label ?? "").trim();
  if (!raw) return null;
  const stripped = raw.replace(/\s+started\s*$/i, "").trim();
  if (!stripped) return null;
  const lc = stripped.toLowerCase();
  if (lc === "tool" || lc === "tool_call" || lc === "tool updated") return null;
  return lc;
}

function describeTool(entry: WorkLogEntry | null): ActivityDescriptor | null {
  if (!entry) return null;
  const id = entry.id;
  const tool = extractToolName(entry);
  const detail = entry.detail?.trim();
  const command = entry.command?.trim();

  if (tool === "read_file" && detail) {
    const target = basename(detail);
    return { key: `read:${id}`, phrases: [`Reading ${target}`, `Still reading ${target}…`] };
  }
  if (tool === "write_file" && detail) {
    const target = basename(detail.replace(/^write\s+/i, ""));
    return { key: `write:${id}`, phrases: [`Writing ${target}`, `Still writing ${target}…`] };
  }
  if (tool === "edit_file" && detail) {
    const target = basename(detail.replace(/^edit\s+/i, ""));
    return { key: `edit:${id}`, phrases: [`Editing ${target}`, `Still editing ${target}…`] };
  }
  if (tool === "bash" && (command || detail)) {
    const raw = command || detail || "";
    const truncated = truncateMiddle(raw);
    return {
      key: `cmd:${id}`,
      phrases: [`Running \`${truncated}\``, `Still running \`${truncated}\`…`],
    };
  }
  if (tool === "grep" && detail) {
    return { key: `grep:${id}`, phrases: [`Searching for ${detail}`, `Still searching…`] };
  }
  if (tool === "glob" && detail) {
    return { key: `glob:${id}`, phrases: [`Finding ${detail}`, `Still finding…`] };
  }
  if (tool === "list_directory" && detail) {
    const path = detail.replace(/^ls(?:\s+-R)?\s+/i, "");
    return { key: `ls:${id}`, phrases: [`Browsing ${path}`, `Still browsing…`] };
  }
  if (entry.itemType === "web_search") {
    return { key: `web:${id}`, phrases: [`Searching the web`, `Still searching…`] };
  }
  if (tool === "search_knowledge" || tool === "search_cve" || tool === "search_code") {
    return { key: `graph:${id}`, phrases: [`Searching graph`, `Still searching graph…`] };
  }
  if (tool) {
    return { key: `tool:${id}`, phrases: [`Using ${tool}`, `Still using ${tool}…`] };
  }
  return null;
}

const STREAMING_DESCRIPTOR: ActivityDescriptor = {
  key: "streaming",
  phrases: ["Writing response…", "Still writing…"],
};

const THINKING_DESCRIPTOR: ActivityDescriptor = {
  key: "thinking",
  phrases: ["Thinking…", "Still thinking…", "This is taking longer than usual…"],
};

/**
 * Slice 31 — idle descriptor used when the user disabled Thinking for the
 * active turn. Avoids the misleading "Thinking…" label when `<think>`
 * blocks are off (Qwen goes straight to tool calls / response). Verbs
 * stay verb-only, matching the rest of the rolling-reasoning vocabulary.
 */
const WORKING_NO_THINKING_DESCRIPTOR: ActivityDescriptor = {
  key: "working-no-thinking",
  phrases: ["Working…", "Still working…", "This is taking longer than usual…"],
};

function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

/**
 * Renders a single live status line below the working dots: verb-led,
 * matches the activity actually in flight (read/write/edit/bash/search/etc.),
 * shows " · Xs" after 5s, and rotates to a "Still ..." variant after 30s
 * to signal the activity is taking longer than usual.
 *
 * Resolution priority:
 *   1. Assistant content actively streaming (last content-delta < 500ms ago)
 *      → "Writing response…"
 *   2. Latest in-flight tool work entry → tool-specific phrase
 *   3. Idle within an active turn → "Thinking…"
 *
 * Fast tool transitions (e.g., a sub-second write_file flashing past) stay
 * visible for at least HOLD_MS before any further switch is allowed, so the
 * user can actually read what just happened.
 */
export function RollingReasoning({
  threadId,
  environmentId,
  provider,
  thinkingEnabled,
  latestWorkEntry,
  className,
}: RollingReasoningProps) {
  const initialNow = Date.now();
  const idleDescriptor =
    thinkingEnabled === false ? WORKING_NO_THINKING_DESCRIPTOR : THINKING_DESCRIPTOR;
  const idleDescriptorRef = useRef(idleDescriptor);
  useEffect(() => {
    idleDescriptorRef.current = idleDescriptor;
  }, [idleDescriptor]);
  const [displayState, setDisplayState] = useState<DisplayState>(() => ({
    descriptor: idleDescriptor,
    startedAt: initialNow,
  }));
  const [nowMs, setNowMs] = useState(initialNow);
  const contentLastDeltaAtRef = useRef(0);
  const lastSwitchAtRef = useRef(initialNow);
  const displayStateRef = useRef(displayState);

  useEffect(() => {
    displayStateRef.current = displayState;
  }, [displayState]);

  // Subscribe to assistant deltas to detect "actively streaming the answer".
  // Source selection (Cut C, slice 3e-ii-b):
  //   - Aris threads → dedicated `aris.event` channel, `aris.assistant.delta`
  //   - other providers → existing ephemeral `content-delta`
  // Only the timing matters (we just stamp `contentLastDeltaAtRef`), so the
  // branch on event shape is purely for which channel we listen on.
  useEffect(() => {
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    const unsubscribe =
      provider === "aris"
        ? api.aris.subscribeEvents({ threadId }, (event) => {
            if (event.type === "aris.assistant.delta") {
              contentLastDeltaAtRef.current = Date.now();
            }
          })
        : api.ephemeral.subscribeReasoning({ threadId }, (event) => {
            if (event.kind === "content-delta") {
              contentLastDeltaAtRef.current = Date.now();
            }
          });
    return () => {
      unsubscribe();
    };
  }, [environmentId, threadId, provider]);

  // Single ticker — re-evaluates the target descriptor and updates nowMs
  // for the elapsed-time suffix. Runs every TICK_MS so changes show up in
  // < 1s, plus once on mount and whenever latestWorkEntry changes identity.
  useEffect(() => {
    const evaluate = () => {
      const now = Date.now();
      const isStreaming = now - contentLastDeltaAtRef.current < STREAM_GRACE_MS;
      const target = isStreaming
        ? STREAMING_DESCRIPTOR
        : (describeTool(latestWorkEntry) ?? idleDescriptorRef.current);

      if (target.key !== displayStateRef.current.descriptor.key) {
        if (now - lastSwitchAtRef.current >= HOLD_MS) {
          lastSwitchAtRef.current = now;
          setDisplayState({ descriptor: target, startedAt: now });
        }
      }
      setNowMs(now);
    };

    evaluate();
    const id = setInterval(evaluate, TICK_MS);
    return () => clearInterval(id);
  }, [latestWorkEntry]);

  const elapsedMs = nowMs - displayState.startedAt;
  const phraseIndex =
    elapsedMs < SLOW_THRESHOLD_MS
      ? 0
      : Math.min(
          displayState.descriptor.phrases.length - 1,
          1 + Math.floor((elapsedMs - SLOW_THRESHOLD_MS) / ROTATION_INTERVAL_MS),
        );
  const phrase =
    displayState.descriptor.phrases[phraseIndex] ?? displayState.descriptor.phrases[0]!;
  const elapsedSuffix = elapsedMs >= ELAPSED_THRESHOLD_MS ? ` · ${formatElapsed(elapsedMs)}` : "";

  return (
    <div
      className={cn("truncate text-[13px] italic text-muted-foreground/60 leading-5", className)}
      aria-live="polite"
      aria-atomic="true"
    >
      {phrase}
      {elapsedSuffix}
    </div>
  );
}
