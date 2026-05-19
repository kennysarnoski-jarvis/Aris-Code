/**
 * Aris event vocabulary — wire format for the dedicated Aris event channel
 * (`aris.event` WS push messages, Cut C of the Aris architecture).
 *
 * These events flow ArisLLM → ArisAdapter → WS push → web renderer WITHOUT
 * routing through the orchestration engine or state.sqlite. They are a
 * fresh design — not a mirror of `ProviderRuntimeEvent` — so that:
 *
 *   1. Aris-specific concerns (memory graph traversal, structured search
 *      result sections, per-tool richer events) live in the wire format
 *      directly instead of being forced into the Codex-shaped shared union.
 *   2. The `aris.tool.started`/`aris.tool.completed` shape is generic so
 *      every tool has a baseline card; tool-class-specific events
 *      (`aris.web.search.results`, `aris.memory.context.surfaced`, etc.)
 *      ride alongside the generic pair to enable richer renders.
 *   3. Apps/server's orchestration engine never sees them.
 *
 * Ordering guarantee: events are in-order within a `turnId`. Cross-turn
 * ordering is best-effort. On reconnect mid-turn the source of truth is
 * `GET /v1/threads/{thread_id}/messages`, NOT replayed events.
 *
 * The approval response (client → server) is intentionally NOT a push
 * event — it lives at the bottom of this file as `ArisApprovalDecisionRequest`,
 * a regular WS RPC payload.
 */
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import {
  ApprovalRequestId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  SafeRecordKey,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  WorkspacePathString,
} from "./baseSchemas";
import {
  ChatAttachment,
  PROVIDER_ASSISTANT_DELTA_MAX_CHARS,
  PROVIDER_ASSISTANT_TEXT_MAX_CHARS,
  ProviderApprovalDecision,
  RuntimeMode,
} from "./orchestration";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
// Slice E.1 / H-2C — `SafeRecordKey` blocks prototype-magic keys
// (`__proto__`, `constructor`, `prototype`) at the schema boundary. See
// baseSchemas.ts for the full rationale. Used here for tool-call `args`
// records emitted by Aris events.
const UnknownRecordSchema = Schema.Record(SafeRecordKey, Schema.Unknown);

// ── Shared sub-types ────────────────────────────────────────────────

export const ArisToolCallId = TrimmedNonEmptyString.pipe(Schema.brand("ArisToolCallId"));
export type ArisToolCallId = typeof ArisToolCallId.Type;

export const ArisMemoryScope = Schema.Literals(["global", "project"]);
export type ArisMemoryScope = typeof ArisMemoryScope.Type;

export const ArisWebSearchFreshness = Schema.Literals(["pd", "pw", "pm", "py"]);
export type ArisWebSearchFreshness = typeof ArisWebSearchFreshness.Type;

export const ArisToolCompletionStatus = Schema.Literals(["success", "error"]);
export type ArisToolCompletionStatus = typeof ArisToolCompletionStatus.Type;

export const ArisSessionEndedReason = Schema.Literals(["user_closed", "error", "stream_closed"]);
export type ArisSessionEndedReason = typeof ArisSessionEndedReason.Type;

export const ArisTurnCancelReason = Schema.Literals(["user_aborted", "client_disconnected"]);
export type ArisTurnCancelReason = typeof ArisTurnCancelReason.Type;

export const ArisErrorCode = Schema.Literals([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "rate_limit",
  "unknown",
]);
export type ArisErrorCode = typeof ArisErrorCode.Type;

export const ArisUsage = Schema.Struct({
  promptTokens: Schema.optional(NonNegativeInt),
  completionTokens: Schema.optional(NonNegativeInt),
  totalTokens: Schema.optional(NonNegativeInt),
});
export type ArisUsage = typeof ArisUsage.Type;

/** One of the four V1 memdir types — enforced server-side in
 * `aris_db.MEMORY_TYPES`. Mirrored here on the wire so the UI can
 * group consistently between live bus events and HTTP fetches. */
export const ArisMemoryType = Schema.Literals(["user", "feedback", "project", "reference"]);
export type ArisMemoryType = typeof ArisMemoryType.Type;

export const ArisMemoryNode = Schema.Struct({
  id: NonNegativeInt,
  type: ArisMemoryType,
  label: TrimmedNonEmptyStringSchema,
  /** One-line hook for relevance matching (V1 memdir frontmatter
   * `description`). Optional because legacy rows that pre-date the
   * memdir port don't have one until consolidate-memory backfills. */
  description: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  scope: ArisMemoryScope,
});
export type ArisMemoryNode = typeof ArisMemoryNode.Type;

export const ArisMemoryEdge = Schema.Struct({
  id: Schema.optional(NonNegativeInt),
  sourceId: NonNegativeInt,
  targetId: NonNegativeInt,
  relation: TrimmedNonEmptyStringSchema,
  weight: Schema.optional(Schema.Number),
});
export type ArisMemoryEdge = typeof ArisMemoryEdge.Type;

export const ArisWebSearchResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  snippet: Schema.optional(Schema.String),
  extraSnippets: Schema.optional(Schema.Array(Schema.String)),
  ageHuman: Schema.optional(TrimmedNonEmptyStringSchema),
  sourceName: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ArisWebSearchResult = typeof ArisWebSearchResult.Type;

export const ArisWebSearchResultSections = Schema.Struct({
  web: Schema.Array(ArisWebSearchResult),
  news: Schema.Array(ArisWebSearchResult),
  faq: Schema.Array(ArisWebSearchResult),
});
export type ArisWebSearchResultSections = typeof ArisWebSearchResultSections.Type;

// ── Type literal discriminators ─────────────────────────────────────

const ArisSessionStartedType = Schema.Literal("aris.session.started");
const ArisSessionEndedType = Schema.Literal("aris.session.ended");

const ArisTurnStartedType = Schema.Literal("aris.turn.started");
const ArisTurnCompletedType = Schema.Literal("aris.turn.completed");
const ArisTurnFailedType = Schema.Literal("aris.turn.failed");
const ArisTurnCancelledType = Schema.Literal("aris.turn.cancelled");

const ArisAssistantDeltaType = Schema.Literal("aris.assistant.delta");
const ArisReasoningDeltaType = Schema.Literal("aris.reasoning.delta");
const ArisAssistantMessageCompletedType = Schema.Literal("aris.assistant.message.completed");

const ArisToolStartedType = Schema.Literal("aris.tool.started");
const ArisToolProgressType = Schema.Literal("aris.tool.progress");
const ArisToolCompletedType = Schema.Literal("aris.tool.completed");

const ArisMemoryQueriedType = Schema.Literal("aris.memory.queried");
const ArisMemoryContextSurfacedType = Schema.Literal("aris.memory.context.surfaced");
const ArisMemoryNodeUpsertedType = Schema.Literal("aris.memory.node.upserted");
const ArisMemoryEdgeAddedType = Schema.Literal("aris.memory.edge.added");
const ArisMemoryNodeDeletedType = Schema.Literal("aris.memory.node.deleted");

const ArisWebSearchExecutedType = Schema.Literal("aris.web.search.executed");
const ArisWebSearchResultsType = Schema.Literal("aris.web.search.results");
const ArisWebFetchExecutedType = Schema.Literal("aris.web.fetch.executed");
const ArisWebFetchCompletedType = Schema.Literal("aris.web.fetch.completed");

const ArisApprovalRequestedType = Schema.Literal("aris.approval.requested");
const ArisApprovalResolvedType = Schema.Literal("aris.approval.resolved");

// Slice 9.2: lifecycle pair surfaced when a fresh user turn arrives while
// the previous turn's background context-compaction side-call is still
// running. The UI shows a "Compacting earlier turns…" indicator between
// `started` and `completed` so the perceived stall is explained.
const ArisCompactionStartedType = Schema.Literal("aris.compaction.started");
const ArisCompactionCompletedType = Schema.Literal("aris.compaction.completed");

// Sidebar refresh trigger emitted once per turn after any graph-mutating
// memory tool fires (upsert_memory_node, add_memory_edge,
// delete_memory_node, consolidate_memory). Generic — the renderer-side
// hook refetches the whole graph regardless of which specific mutation
// happened, so a single per-turn signal covers any combination of writes.
// The more granular `aris.memory.node.upserted` / `.edge.added` /
// `.node.deleted` events further down are reserved for future per-mutation
// surfaces (e.g. live "memory node added" toast); not used today.
const ArisMemoryChangedType = Schema.Literal("aris.memory.changed");

// Emitted by ArisAdapter the moment it receives the first SSE envelope
// frame from aris_server containing the conversation_id. This is the
// earliest point the client can KNOW the server has persisted the
// conversation row to aris_memory.db (the row is created in
// `_prep_new_user_turn` BEFORE any SSE frame, so seeing the first frame
// means the row exists). `aris.turn.started` fires too early for this
// purpose — it's published before the chat-completion POST even goes
// out, so the server hasn't run yet. Drives sidebar thread-list refresh
// for brand-new threads on brand-new projects without the race that
// makes /v1/threads return empty if queried pre-persistence.
const ArisThreadPersistedType = Schema.Literal("aris.thread.persisted");

const ArisErrorType = Schema.Literal("aris.error");
const ArisRateLimitType = Schema.Literal("aris.rate_limit");

// COORD-6.1 — Coordinator/worker activity events. Emitted by the
// DeepSeek `spawn_worker` tool (start + completion paths) and by the
// `append_session_scratchpad` tool. Drive the right-sidebar
// CoordinatorActivityPanel: live worker rows + session scratchpad
// entries scoped to the current parent turn.
const ArisWorkerSpawnStartedType = Schema.Literal("aris.worker.spawn.started");
const ArisWorkerSpawnCompletedType = Schema.Literal("aris.worker.spawn.completed");
const ArisWorkerContextChangedType = Schema.Literal("aris.worker.context.changed");
const ArisSessionScratchpadAppendedType = Schema.Literal("aris.session_scratchpad.appended");

/**
 * Worker outcome status — mirrors the four return paths in
 * spawn_worker.execute (OK / FAIL / BUDGET_EXCEEDED / ESCALATED).
 * The frontend renders these with distinct status pills.
 */
export const ArisWorkerSpawnStatus = Schema.Literals([
  "ok",
  "failed",
  "budget_exceeded",
  "escalated",
]);
export type ArisWorkerSpawnStatus = typeof ArisWorkerSpawnStatus.Type;

// ── Common envelope ────────────────────────────────────────────────

const ArisEventBase = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});
export type ArisEventBase = typeof ArisEventBase.Type;

// ── Payloads ───────────────────────────────────────────────────────

const ArisSessionStartedPayload = Schema.Struct({});
export type ArisSessionStartedPayload = typeof ArisSessionStartedPayload.Type;

const ArisSessionEndedPayload = Schema.Struct({
  reason: ArisSessionEndedReason,
  errorMessage: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ArisSessionEndedPayload = typeof ArisSessionEndedPayload.Type;

const ArisTurnStartedPayload = Schema.Struct({
  userMessageId: MessageId,
  runtimeMode: RuntimeMode,
});
export type ArisTurnStartedPayload = typeof ArisTurnStartedPayload.Type;

const ArisTurnCompletedPayload = Schema.Struct({
  messageCount: NonNegativeInt,
  usage: Schema.optional(ArisUsage),
});
export type ArisTurnCompletedPayload = typeof ArisTurnCompletedPayload.Type;

const ArisTurnFailedPayload = Schema.Struct({
  errorMessage: TrimmedNonEmptyStringSchema,
  retryAfterSeconds: Schema.optional(PositiveInt),
});
export type ArisTurnFailedPayload = typeof ArisTurnFailedPayload.Type;

const ArisTurnCancelledPayload = Schema.Struct({
  reason: ArisTurnCancelReason,
});
export type ArisTurnCancelledPayload = typeof ArisTurnCancelledPayload.Type;

const ArisAssistantDeltaPayload = Schema.Struct({
  messageId: MessageId,
  // Slice I / H3-7 — streaming delta cap.
  text: Schema.String.check(Schema.isMaxLength(PROVIDER_ASSISTANT_DELTA_MAX_CHARS)),
});
export type ArisAssistantDeltaPayload = typeof ArisAssistantDeltaPayload.Type;

const ArisReasoningDeltaPayload = Schema.Struct({
  // Slice I / H3-7 — streaming delta cap. Reasoning streams can be
  // verbose (long chain-of-thought), still bounded.
  text: Schema.String.check(Schema.isMaxLength(PROVIDER_ASSISTANT_DELTA_MAX_CHARS)),
});
export type ArisReasoningDeltaPayload = typeof ArisReasoningDeltaPayload.Type;

const ArisAssistantMessageCompletedPayload = Schema.Struct({
  messageId: MessageId,
  // Slice I / H3-7 — assembled final-text cap.
  finalText: Schema.String.check(Schema.isMaxLength(PROVIDER_ASSISTANT_TEXT_MAX_CHARS)),
  contentLength: NonNegativeInt,
});
export type ArisAssistantMessageCompletedPayload = typeof ArisAssistantMessageCompletedPayload.Type;

const ArisToolStartedPayload = Schema.Struct({
  toolCallId: ArisToolCallId,
  name: TrimmedNonEmptyStringSchema,
  args: UnknownRecordSchema,
  displayName: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ArisToolStartedPayload = typeof ArisToolStartedPayload.Type;

const ArisToolProgressPayload = Schema.Struct({
  toolCallId: ArisToolCallId,
  message: TrimmedNonEmptyStringSchema,
});
export type ArisToolProgressPayload = typeof ArisToolProgressPayload.Type;

const ArisToolCompletedPayload = Schema.Struct({
  toolCallId: ArisToolCallId,
  status: ArisToolCompletionStatus,
  resultPreview: Schema.optional(Schema.String),
  errorMessage: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ArisToolCompletedPayload = typeof ArisToolCompletedPayload.Type;

const ArisMemoryQueriedPayload = Schema.Struct({
  entitiesExtracted: Schema.Array(TrimmedNonEmptyStringSchema),
  nodesMatched: NonNegativeInt,
  hops: NonNegativeInt,
});
export type ArisMemoryQueriedPayload = typeof ArisMemoryQueriedPayload.Type;

const ArisMemoryContextSurfacedPayload = Schema.Struct({
  nodes: Schema.Array(ArisMemoryNode),
  edges: Schema.Array(ArisMemoryEdge),
});
export type ArisMemoryContextSurfacedPayload = typeof ArisMemoryContextSurfacedPayload.Type;

const ArisMemoryNodeUpsertedPayload = Schema.Struct({
  node: ArisMemoryNode,
  wasCreated: Schema.Boolean,
});
export type ArisMemoryNodeUpsertedPayload = typeof ArisMemoryNodeUpsertedPayload.Type;

const ArisMemoryEdgeAddedPayload = Schema.Struct({
  edge: ArisMemoryEdge,
});
export type ArisMemoryEdgeAddedPayload = typeof ArisMemoryEdgeAddedPayload.Type;

const ArisMemoryNodeDeletedPayload = Schema.Struct({
  nodeId: NonNegativeInt,
  label: TrimmedNonEmptyStringSchema,
});
export type ArisMemoryNodeDeletedPayload = typeof ArisMemoryNodeDeletedPayload.Type;

const ArisWebSearchExecutedPayload = Schema.Struct({
  query: TrimmedNonEmptyStringSchema,
  freshness: Schema.optional(ArisWebSearchFreshness),
});
export type ArisWebSearchExecutedPayload = typeof ArisWebSearchExecutedPayload.Type;

const ArisWebSearchResultsPayload = Schema.Struct({
  query: TrimmedNonEmptyStringSchema,
  sections: ArisWebSearchResultSections,
});
export type ArisWebSearchResultsPayload = typeof ArisWebSearchResultsPayload.Type;

const ArisWebFetchExecutedPayload = Schema.Struct({
  url: TrimmedNonEmptyStringSchema,
});
export type ArisWebFetchExecutedPayload = typeof ArisWebFetchExecutedPayload.Type;

const ArisWebFetchCompletedPayload = Schema.Struct({
  url: TrimmedNonEmptyStringSchema,
  contentLength: NonNegativeInt,
  title: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ArisWebFetchCompletedPayload = typeof ArisWebFetchCompletedPayload.Type;

const ArisApprovalRequestedPayload = Schema.Struct({
  approvalId: ApprovalRequestId,
  toolCallId: ArisToolCallId,
  toolName: TrimmedNonEmptyStringSchema,
  summary: TrimmedNonEmptyStringSchema,
  args: UnknownRecordSchema,
});
export type ArisApprovalRequestedPayload = typeof ArisApprovalRequestedPayload.Type;

const ArisApprovalResolvedPayload = Schema.Struct({
  approvalId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ArisApprovalResolvedPayload = typeof ArisApprovalResolvedPayload.Type;

// COORD-6.1 payloads ───────────────────────────────────────────────

/**
 * Emitted when spawn_worker.execute begins. The frontend uses this to
 * create a new "running" worker row in the CoordinatorActivityPanel.
 * `workerCallId` matches the parent's tool_call id for the
 * spawn_worker invocation, so the frontend can correlate this event
 * with the existing aris.tool.started for the spawn_worker call
 * itself.
 */
const ArisWorkerSpawnStartedPayload = Schema.Struct({
  workerCallId: ArisToolCallId,
  description: TrimmedNonEmptyStringSchema,
  parentTurnId: TurnId,
  toolNames: Schema.Array(TrimmedNonEmptyStringSchema),
  turnCap: NonNegativeInt,
  promptLength: NonNegativeInt,
  // 2026-05-12 — Working folder the worker operates in (inherited from
  // the parent's cwd). Optional for legacy events that pre-date this
  // field. Surfaced in the CoordinatorActivityPanel under the worker's
  // title so the user can see where the work is happening, Cowork-style.
  cwd: Schema.optional(Schema.String),
});
export type ArisWorkerSpawnStartedPayload = typeof ArisWorkerSpawnStartedPayload.Type;

/**
 * Emitted whenever a running worker's "what am I doing right now" label
 * changes — i.e. it just kicked off a new tool call. The frontend uses
 * this to render a one-line "currently doing X" under the worker title
 * in the CoordinatorActivityPanel, matching Cowork's task panel UX. The
 * label is derived from the tool call (tool name + args preview), e.g.
 * `Reading apps/web/foo.tsx` or `Running: grep -r "errorMessage"`.
 *
 * Fires once per tool_call_item the worker emits. Coalescing on the
 * client is fine — only the most recent label matters for rendering.
 */
const ArisWorkerContextChangedPayload = Schema.Struct({
  workerCallId: ArisToolCallId,
  parentTurnId: TurnId,
  contextLabel: TrimmedNonEmptyStringSchema,
});
export type ArisWorkerContextChangedPayload = typeof ArisWorkerContextChangedPayload.Type;

/**
 * Emitted when spawn_worker.execute completes, fails, escalates, or
 * hits the budget. The frontend uses this to flip the worker row from
 * "running" to its terminal status. `outputBytes` is the size of the
 * tool result the parent received (text the model will read for
 * synthesis).
 */
const ArisWorkerSpawnCompletedPayload = Schema.Struct({
  workerCallId: ArisToolCallId,
  description: TrimmedNonEmptyStringSchema,
  parentTurnId: TurnId,
  status: ArisWorkerSpawnStatus,
  elapsedMs: NonNegativeInt,
  toolCalls: NonNegativeInt,
  outputBytes: NonNegativeInt,
  errorMessage: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ArisWorkerSpawnCompletedPayload = typeof ArisWorkerSpawnCompletedPayload.Type;

/**
 * Emitted when append_session_scratchpad writes a new entry. Drives
 * the live entry feed in the CoordinatorActivityPanel. The frontend
 * appends new entries to its local list as they arrive; full-file
 * read on panel-mount handles the cold path.
 */
const ArisSessionScratchpadAppendedPayload = Schema.Struct({
  entryId: TrimmedNonEmptyStringSchema,
  parentTurnId: TurnId,
  writer: TrimmedNonEmptyStringSchema,
  content: Schema.String,
  totalEntries: NonNegativeInt,
});
export type ArisSessionScratchpadAppendedPayload = typeof ArisSessionScratchpadAppendedPayload.Type;

// Slice 9.2: payloads are intentionally empty — the event type itself
// (`aris.compaction.started` vs `.completed`) carries the lifecycle, and
// the renderer doesn't need any per-event data beyond knowing whether
// to show or hide the indicator. Kept as Structs (not bare nulls) so the
// schema stays homogeneous with the rest of the event family.
const ArisCompactionStartedPayload = Schema.Struct({});
export type ArisCompactionStartedPayload = typeof ArisCompactionStartedPayload.Type;

const ArisCompactionCompletedPayload = Schema.Struct({});
export type ArisCompactionCompletedPayload = typeof ArisCompactionCompletedPayload.Type;

// Empty payload for the same reason as the compaction events — the
// event type alone is the signal; the hook refetches the full graph
// rather than incrementally applying any per-event delta.
const ArisMemoryChangedPayload = Schema.Struct({});
export type ArisMemoryChangedPayload = typeof ArisMemoryChangedPayload.Type;

// Carries the server-assigned conversation id so subscribers can correlate
// (sidebar thread-list refresh, future "edit conversation metadata" flows).
// `threadId` is on the base envelope already; this is the inner-DB row id.
const ArisThreadPersistedPayload = Schema.Struct({
  conversationId: NonNegativeInt,
});
export type ArisThreadPersistedPayload = typeof ArisThreadPersistedPayload.Type;

const ArisErrorPayload = Schema.Struct({
  code: ArisErrorCode,
  message: TrimmedNonEmptyStringSchema,
  recoverable: Schema.Boolean,
});
export type ArisErrorPayload = typeof ArisErrorPayload.Type;

const ArisRateLimitPayload = Schema.Struct({
  retryAfterSeconds: PositiveInt,
});
export type ArisRateLimitPayload = typeof ArisRateLimitPayload.Type;

// ── Event variants ─────────────────────────────────────────────────

const ArisSessionStartedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisSessionStartedType,
  payload: ArisSessionStartedPayload,
});
export type ArisSessionStartedEvent = typeof ArisSessionStartedEvent.Type;

const ArisSessionEndedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisSessionEndedType,
  payload: ArisSessionEndedPayload,
});
export type ArisSessionEndedEvent = typeof ArisSessionEndedEvent.Type;

const ArisTurnStartedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisTurnStartedType,
  payload: ArisTurnStartedPayload,
});
export type ArisTurnStartedEvent = typeof ArisTurnStartedEvent.Type;

const ArisTurnCompletedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisTurnCompletedType,
  payload: ArisTurnCompletedPayload,
});
export type ArisTurnCompletedEvent = typeof ArisTurnCompletedEvent.Type;

const ArisTurnFailedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisTurnFailedType,
  payload: ArisTurnFailedPayload,
});
export type ArisTurnFailedEvent = typeof ArisTurnFailedEvent.Type;

const ArisTurnCancelledEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisTurnCancelledType,
  payload: ArisTurnCancelledPayload,
});
export type ArisTurnCancelledEvent = typeof ArisTurnCancelledEvent.Type;

const ArisAssistantDeltaEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisAssistantDeltaType,
  payload: ArisAssistantDeltaPayload,
});
export type ArisAssistantDeltaEvent = typeof ArisAssistantDeltaEvent.Type;

const ArisReasoningDeltaEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisReasoningDeltaType,
  payload: ArisReasoningDeltaPayload,
});
export type ArisReasoningDeltaEvent = typeof ArisReasoningDeltaEvent.Type;

const ArisAssistantMessageCompletedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisAssistantMessageCompletedType,
  payload: ArisAssistantMessageCompletedPayload,
});
export type ArisAssistantMessageCompletedEvent = typeof ArisAssistantMessageCompletedEvent.Type;

const ArisToolStartedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisToolStartedType,
  payload: ArisToolStartedPayload,
});
export type ArisToolStartedEvent = typeof ArisToolStartedEvent.Type;

const ArisToolProgressEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisToolProgressType,
  payload: ArisToolProgressPayload,
});
export type ArisToolProgressEvent = typeof ArisToolProgressEvent.Type;

const ArisToolCompletedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisToolCompletedType,
  payload: ArisToolCompletedPayload,
});
export type ArisToolCompletedEvent = typeof ArisToolCompletedEvent.Type;

const ArisMemoryQueriedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisMemoryQueriedType,
  payload: ArisMemoryQueriedPayload,
});
export type ArisMemoryQueriedEvent = typeof ArisMemoryQueriedEvent.Type;

const ArisMemoryContextSurfacedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisMemoryContextSurfacedType,
  payload: ArisMemoryContextSurfacedPayload,
});
export type ArisMemoryContextSurfacedEvent = typeof ArisMemoryContextSurfacedEvent.Type;

const ArisMemoryNodeUpsertedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisMemoryNodeUpsertedType,
  payload: ArisMemoryNodeUpsertedPayload,
});
export type ArisMemoryNodeUpsertedEvent = typeof ArisMemoryNodeUpsertedEvent.Type;

const ArisMemoryEdgeAddedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisMemoryEdgeAddedType,
  payload: ArisMemoryEdgeAddedPayload,
});
export type ArisMemoryEdgeAddedEvent = typeof ArisMemoryEdgeAddedEvent.Type;

const ArisMemoryNodeDeletedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisMemoryNodeDeletedType,
  payload: ArisMemoryNodeDeletedPayload,
});
export type ArisMemoryNodeDeletedEvent = typeof ArisMemoryNodeDeletedEvent.Type;

const ArisWebSearchExecutedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisWebSearchExecutedType,
  payload: ArisWebSearchExecutedPayload,
});
export type ArisWebSearchExecutedEvent = typeof ArisWebSearchExecutedEvent.Type;

const ArisWebSearchResultsEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisWebSearchResultsType,
  payload: ArisWebSearchResultsPayload,
});
export type ArisWebSearchResultsEvent = typeof ArisWebSearchResultsEvent.Type;

const ArisWebFetchExecutedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisWebFetchExecutedType,
  payload: ArisWebFetchExecutedPayload,
});
export type ArisWebFetchExecutedEvent = typeof ArisWebFetchExecutedEvent.Type;

const ArisWebFetchCompletedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisWebFetchCompletedType,
  payload: ArisWebFetchCompletedPayload,
});
export type ArisWebFetchCompletedEvent = typeof ArisWebFetchCompletedEvent.Type;

const ArisApprovalRequestedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisApprovalRequestedType,
  payload: ArisApprovalRequestedPayload,
});
export type ArisApprovalRequestedEvent = typeof ArisApprovalRequestedEvent.Type;

const ArisApprovalResolvedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisApprovalResolvedType,
  payload: ArisApprovalResolvedPayload,
});
export type ArisApprovalResolvedEvent = typeof ArisApprovalResolvedEvent.Type;

// COORD-6.1 event Schema.Structs ───────────────────────────────────

const ArisWorkerSpawnStartedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisWorkerSpawnStartedType,
  payload: ArisWorkerSpawnStartedPayload,
});
export type ArisWorkerSpawnStartedEvent = typeof ArisWorkerSpawnStartedEvent.Type;

const ArisWorkerSpawnCompletedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisWorkerSpawnCompletedType,
  payload: ArisWorkerSpawnCompletedPayload,
});
export type ArisWorkerSpawnCompletedEvent = typeof ArisWorkerSpawnCompletedEvent.Type;

const ArisWorkerContextChangedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisWorkerContextChangedType,
  payload: ArisWorkerContextChangedPayload,
});
export type ArisWorkerContextChangedEvent = typeof ArisWorkerContextChangedEvent.Type;

const ArisSessionScratchpadAppendedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisSessionScratchpadAppendedType,
  payload: ArisSessionScratchpadAppendedPayload,
});
export type ArisSessionScratchpadAppendedEvent = typeof ArisSessionScratchpadAppendedEvent.Type;

const ArisCompactionStartedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisCompactionStartedType,
  payload: ArisCompactionStartedPayload,
});
export type ArisCompactionStartedEvent = typeof ArisCompactionStartedEvent.Type;

const ArisCompactionCompletedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisCompactionCompletedType,
  payload: ArisCompactionCompletedPayload,
});
export type ArisCompactionCompletedEvent = typeof ArisCompactionCompletedEvent.Type;

const ArisMemoryChangedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisMemoryChangedType,
  payload: ArisMemoryChangedPayload,
});
export type ArisMemoryChangedEvent = typeof ArisMemoryChangedEvent.Type;

const ArisThreadPersistedEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisThreadPersistedType,
  payload: ArisThreadPersistedPayload,
});
export type ArisThreadPersistedEvent = typeof ArisThreadPersistedEvent.Type;

const ArisErrorEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisErrorType,
  payload: ArisErrorPayload,
});
export type ArisErrorEvent = typeof ArisErrorEvent.Type;

const ArisRateLimitEvent = Schema.Struct({
  ...ArisEventBase.fields,
  type: ArisRateLimitType,
  payload: ArisRateLimitPayload,
});
export type ArisRateLimitEvent = typeof ArisRateLimitEvent.Type;

// ── Discriminated union ────────────────────────────────────────────

export const ArisEvent = Schema.Union([
  ArisSessionStartedEvent,
  ArisSessionEndedEvent,
  ArisTurnStartedEvent,
  ArisTurnCompletedEvent,
  ArisTurnFailedEvent,
  ArisTurnCancelledEvent,
  ArisAssistantDeltaEvent,
  ArisReasoningDeltaEvent,
  ArisAssistantMessageCompletedEvent,
  ArisToolStartedEvent,
  ArisToolProgressEvent,
  ArisToolCompletedEvent,
  ArisMemoryQueriedEvent,
  ArisMemoryContextSurfacedEvent,
  ArisMemoryNodeUpsertedEvent,
  ArisMemoryEdgeAddedEvent,
  ArisMemoryNodeDeletedEvent,
  ArisWebSearchExecutedEvent,
  ArisWebSearchResultsEvent,
  ArisWebFetchExecutedEvent,
  ArisWebFetchCompletedEvent,
  ArisApprovalRequestedEvent,
  ArisApprovalResolvedEvent,
  ArisCompactionStartedEvent,
  ArisCompactionCompletedEvent,
  ArisMemoryChangedEvent,
  ArisThreadPersistedEvent,
  ArisErrorEvent,
  ArisRateLimitEvent,
  // COORD-6.1
  ArisWorkerSpawnStartedEvent,
  ArisWorkerSpawnCompletedEvent,
  ArisWorkerContextChangedEvent,
  ArisSessionScratchpadAppendedEvent,
]);
export type ArisEvent = typeof ArisEvent.Type;

// ── Approval response (client → server, NOT a push event) ──────────

/**
 * Sent from the web client back to apps/server in response to an
 * `aris.approval.requested` push event. This is a regular WS RPC payload,
 * not a push event — it requires a real response cycle so the agentic
 * loop on aris_server can either resume or abort the held tool call.
 */
export const ArisApprovalDecisionRequest = Schema.Struct({
  threadId: ThreadId,
  approvalId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ArisApprovalDecisionRequest = typeof ArisApprovalDecisionRequest.Type;

/**
 * Failure cases for `aris.approval.decide`. Single-class wrapper with a
 * `detail` string keeps the contract minimal — the underlying causes
 * (unknown approval, closed session, missing thread) are all user-facing
 * variants of "we couldn't deliver your decision," and the renderer
 * shows the detail string verbatim in a toast.
 */
export class ArisApprovalDecideError extends Schema.TaggedErrorClass<ArisApprovalDecideError>()(
  "ArisApprovalDecideError",
  {
    detail: Schema.String,
  },
) {
  override get message() {
    return `Aris approval decide failed: ${this.detail}`;
  }
}

// ── WS subscription RPC ───────────────────────────────────────────

/**
 * WS method namespace for the dedicated Aris event channel. Lives in
 * its own constant rather than the shared `WS_METHODS` because the Aris
 * path is intentionally decoupled from the orchestration WS surface
 * under Cut C — adding methods here does not require touching the
 * orchestration RPC catalog.
 */
export const ARIS_WS_METHODS = {
  subscribeArisEvents: "aris.subscribeEvents",
  decideApproval: "aris.approval.decide",
  /**
   * Read the per-thread rolling-window archive (active.jsonl). Used by
   * the web client on thread mount to hydrate prior DS conversation
   * messages so they survive app restart. Currently DS-only since
   * Aris persists chat history via aris_memory.db on the POD/cloud
   * side. Lives in the `aris.*` namespace because the namespace was
   * already shared infrastructure for both providers (event bus,
   * approval RPC).
   */
  readArchive: "aris.archive.read",
  /**
   * Read the user-global facts store (`~/.aris/facts.jsonl`). Drives the
   * right-sidebar Memory panel (mirrors Cowork's Memory section). User-
   * global because facts apply across every project, not just the active
   * thread's. No input needed — the file path is fixed per host user.
   * Auto-refreshed on the client by re-calling this RPC whenever an
   * `aris.tool.completed` for `upsert_memory_node` / `delete_memory_node`
   * arrives, so the panel stays current without polling.
   */
  readFacts: "aris.facts.read",
} as const;

export const ArisSubscribeEventsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ArisSubscribeEventsInput = typeof ArisSubscribeEventsInput.Type;

/**
 * Server-pushed stream of `ArisEvent` values scoped to a single thread.
 * Subscribed once per thread by the web client; unsubscribed on thread
 * unmount. The stream's lifetime IS the subscription's lifetime — there
 * is no "history" semantic on this channel, only live events. For
 * settled chat history, fetch `GET /v1/threads/{thread_id}/messages`
 * directly from aris_server.
 */
export const WsSubscribeArisEventsRpc = Rpc.make(ARIS_WS_METHODS.subscribeArisEvents, {
  payload: ArisSubscribeEventsInput,
  success: ArisEvent,
  stream: true,
});

/**
 * Client-to-server: deliver the user's decision for a previously-pushed
 * `aris.approval.requested` event. Resolves the held tool call inside
 * `ArisAdapter`'s agentic loop — accept lets the tool run; decline /
 * cancel aborts the tool with a synthesized failure result.
 */
export const WsArisApprovalDecideRpc = Rpc.make(ARIS_WS_METHODS.decideApproval, {
  payload: ArisApprovalDecisionRequest,
  error: ArisApprovalDecideError,
});

// ── aris.archive.read — DS rolling-window history hydration ─────────

/**
 * Persisted chat message shape returned by `aris.archive.read`. Mirrors
 * the on-disk record format in `RollingWindowMemory.PersistedMessage`
 * with one field rename (`messageId` → `id`) so the client can drop
 * directly into `ChatMessage` without further transformation.
 */
export const ArisArchiveMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  // Slice N.2 / M4-11 — cap archive content at the same ceiling used
  // for live assistant text (`PROVIDER_ASSISTANT_TEXT_MAX_CHARS`,
  // 10M). Archive messages get replayed verbatim into the renderer
  // chat history on reload; without a cap, a corrupted or malicious
  // archive file could ship a multi-hundred-MB string through every
  // archive.read RPC response. Matches the live-stream final-text
  // cap at line 284 in this file so an archived message can't be
  // larger than the live message it was archived from.
  content: Schema.String.check(Schema.isMaxLength(PROVIDER_ASSISTANT_TEXT_MAX_CHARS)),
  turnId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  // Image attachments persisted alongside this user message (added
  // 2026-05-13). Optional — old records and assistant messages don't
  // carry one. Reuses the same `ChatAttachment` shape Codex/Claude
  // use so the client store's mapMessage path handles all three
  // providers uniformly.
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
});
export type ArisArchiveMessage = typeof ArisArchiveMessage.Type;

/**
 * Input for `aris.archive.read`. Server uses `cwd` to locate the
 * per-thread archive directory under `~/.aris/projects/<key>/sessions/`.
 * Frontend already knows the project's cwd (it's the workspace it
 * mounted) so we send it explicitly rather than re-deriving server-side.
 */
export const ArisArchiveReadInput = Schema.Struct({
  threadId: ThreadId,
  // Slice O / M4-3 — cap cwd at WORKSPACE_PATH_MAX_LENGTH (4096) and
  // reject NUL bytes. The cwd flows through
  // `RollingWindowMemory.projectKeyFromCwd` → on-disk path → fs.readFile.
  // Pre-Slice-O this accepted any string, including a 10MB cwd that
  // would burn CPU through split/join/toLowerCase before fs rejected
  // it. See baseSchemas.ts for the rationale on the shared schema.
  cwd: WorkspacePathString,
});
export type ArisArchiveReadInput = typeof ArisArchiveReadInput.Type;

export const ArisArchiveReadOutput = Schema.Struct({
  messages: Schema.Array(ArisArchiveMessage),
});
export type ArisArchiveReadOutput = typeof ArisArchiveReadOutput.Type;

export class ArisArchiveReadError extends Schema.TaggedErrorClass<ArisArchiveReadError>()(
  "ArisArchiveReadError",
  {
    detail: Schema.String,
  },
) {
  override get message() {
    return `Aris archive read failed: ${this.detail}`;
  }
}

export const WsArisArchiveReadRpc = Rpc.make(ARIS_WS_METHODS.readArchive, {
  payload: ArisArchiveReadInput,
  success: ArisArchiveReadOutput,
  error: ArisArchiveReadError,
});

// ── aris.facts.read — Memory panel snapshot ─────────────────────────

/**
 * One persisted fact returned by `aris.facts.read`. Mirrors the
 * server-side `Fact` interface (FactsMemory.ts) one-to-one. The client
 * groups by `factType` and renders `label` as the row title, with
 * `description` + `content` revealed on click-to-expand.
 */
export const ArisFact = Schema.Struct({
  factType: Schema.Literals(["user", "feedback"]),
  label: Schema.String,
  description: Schema.String,
  content: Schema.String,
});
export type ArisFact = typeof ArisFact.Type;

/**
 * No input — facts are user-global (path is fixed at
 * `~/.aris/facts.jsonl`). Empty struct kept for forward-compat in case
 * we need per-host or per-account scoping later.
 */
export const ArisFactsReadInput = Schema.Struct({});
export type ArisFactsReadInput = typeof ArisFactsReadInput.Type;

export const ArisFactsReadOutput = Schema.Struct({
  facts: Schema.Array(ArisFact),
});
export type ArisFactsReadOutput = typeof ArisFactsReadOutput.Type;

export class ArisFactsReadError extends Schema.TaggedErrorClass<ArisFactsReadError>()(
  "ArisFactsReadError",
  {
    detail: Schema.String,
  },
) {
  override get message() {
    return `Aris facts read failed: ${this.detail}`;
  }
}

export const WsArisFactsReadRpc = Rpc.make(ARIS_WS_METHODS.readFacts, {
  payload: ArisFactsReadInput,
  success: ArisFactsReadOutput,
  error: ArisFactsReadError,
});
