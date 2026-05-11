import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type TurnId } from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      showAssistantCopyButton: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      latestWorkEntry: WorkLogEntry | null;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

/**
 * Returns true when an assistant message exists in `timelineEntries` *after*
 * the latest user message — i.e., the current turn's response has been
 * persisted into the timeline. Used by the in-flight synthetic-row check so
 * the synthetic disappears in the same render the settled row appears,
 * without relying on `turnId` equality (Aris settled messages currently
 * arrive without a `turnId` from the history fetch).
 */
function settledAssistantExistsAfterLatestUser(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): boolean {
  let latestUserIndex = -1;
  for (let i = timelineEntries.length - 1; i >= 0; i--) {
    const entry = timelineEntries[i];
    if (entry?.kind === "message" && entry.message.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex === -1) return false;
  for (let i = latestUserIndex + 1; i < timelineEntries.length; i++) {
    const entry = timelineEntries[i];
    if (entry?.kind === "message" && entry.message.role === "assistant") {
      return true;
    }
  }
  return false;
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnId: string | null;
  activeTurnStartedAt: string | null;
  liveStatusEntry: WorkLogEntry | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  /**
   * Accumulated text from the live ephemeral content stream for the current
   * in-flight turn, plus the turn id that text belongs to. When the buffer
   * has content AND no settled assistant message exists yet for that turn,
   * we synthesize an in-flight assistant message row so the streaming → settled
   * handoff is height-neutral (same row in the timeline, content updates in
   * place rather than swapping a footer buffer for a list row).
   */
  liveAssistantBufferText?: string;
  liveAssistantBufferTurnId?: string | null;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  // Synthetic in-flight assistant row — emitted when:
  //   (a) the live buffer has text, AND
  //   (b) the buffer's turnId matches the active turn (otherwise the buffer
  //       is stale — lingering content from a previous turn before the next
  //       stream's first delta arrives), AND
  //   (c) no settled assistant message exists *after* the latest user message
  //       in `timelineEntries` (i.e., the streaming response hasn't been
  //       persisted yet — once it has, the structural check trips and the
  //       synthetic disappears in the same render the settled row appears).
  //
  // The structural check (c) is used instead of `entry.message.turnId ===
  // liveBufferTurnId` because Aris's history fetch (`arisHistoryFetch.ts`)
  // doesn't propagate `turnId` onto settled `ChatMessage` objects — they
  // arrive with `turnId === undefined`, and a turn-id equality check would
  // never match. The structural check is robust to that.
  //
  // The synthetic uses the same `kind: "message"` shape as a real settled
  // row, so it goes through the same render path in `TimelineRowContent`
  // and produces an identical DOM structure. This is the load-bearing
  // property — the row's wrapper, padding, and metadata footer are all
  // present from the first delta, so when the settled row replaces the
  // synthetic, the height delta is essentially zero.
  const liveBufferText = input.liveAssistantBufferText ?? "";
  const liveBufferTurnId = input.liveAssistantBufferTurnId ?? null;
  // Buffer-vs-active-turn matching:
  //   - When a turn is actively in progress, the buffer's turnId must match
  //     the active turn id. This rejects stale buffer content from a
  //     previous turn that hasn't been cleared yet (e.g. after the user
  //     sends a fresh message but before the next stream's first delta
  //     arrives — the previous turn's text still sits in the buffer).
  //   - When `activeTurnId` is null (the most recent turn just ended),
  //     allow the buffer to keep rendering as long as the structural
  //     check below confirms no settled assistant has landed yet. This
  //     closes the half-second visual gap between stream-end (active
  //     turn cleared) and `arisRefetch` (settled row arrives).
  const bufferIsForActiveTurn =
    liveBufferTurnId !== null &&
    (input.activeTurnId === null || liveBufferTurnId === input.activeTurnId);
  const hasLiveBuffer = liveBufferText.length > 0 && bufferIsForActiveTurn;
  const hasSettledAssistantAfterLatestUser = settledAssistantExistsAfterLatestUser(
    input.timelineEntries,
  );

  if (hasLiveBuffer && !hasSettledAssistantAfterLatestUser) {
    const syntheticId = `streaming-assistant:${liveBufferTurnId}`;
    const syntheticCreatedAt = input.activeTurnStartedAt ?? new Date(0).toISOString();
    const syntheticMessage: ChatMessage = {
      id: syntheticId as MessageId,
      role: "assistant",
      text: liveBufferText,
      createdAt: syntheticCreatedAt,
      streaming: true,
      turnId: liveBufferTurnId as TurnId,
    };
    nextRows.push({
      kind: "message",
      id: syntheticId,
      createdAt: syntheticCreatedAt,
      message: syntheticMessage,
      durationStart: syntheticCreatedAt,
      showCompletionDivider: false,
      showAssistantCopyButton: false,
    });
    return nextRows;
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      latestWorkEntry: input.liveStatusEntry,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        a.latestWorkEntry === (b as typeof a).latestWorkEntry
      );

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return a.groupedEntries === (b as typeof a).groupedEntries;

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showCompletionDivider === bm.showCompletionDivider &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
