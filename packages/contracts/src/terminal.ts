import { Effect, Schema } from "effect";
import { safeRecordKeyFilter, TrimmedNonEmptyString } from "./baseSchemas";

export const DEFAULT_TERMINAL_ID = "default";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(20)).check(
  Schema.isLessThanOrEqualTo(400),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)).check(
  Schema.isLessThanOrEqualTo(200),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
// Slice H.1 / H3-6 — `__proto__`, `constructor`, and `prototype` all
// match the regex below (they're plain identifier-shaped strings), so
// the pre-Slice-H schema accepted them as env-var keys. If terminal
// env values ever flow through a spread into a plain object, that's a
// prototype-pollution vector. We AND the existing regex with
// `safeRecordKeyFilter` (Slice E.1 / H-2C) so the prototype-magic
// names are explicitly rejected at the schema boundary — same
// guarantee as every other `Schema.Record` site.
const TerminalEnvKeySchema = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))
  .check(safeRecordKeyFilter)
  .check(Schema.isMaxLength(128));
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
const TerminalEnvSchema = Schema.Record(TerminalEnvKeySchema, TerminalEnvValueSchema).check(
  Schema.isMaxProperties(128),
);

/**
 * Slice J.1 / M3-12 fix (2026-05-16) — caps on terminal output payloads.
 *
 * - `TERMINAL_HISTORY_MAX_CHARS` — the cumulative scrollback history
 *   the server retains for replay on session reattach. Pre-Slice-J
 *   the schema accepted unbounded `Schema.String`; a long-running
 *   terminal session producing megabytes of output could grow the
 *   persisted snapshot without bound. 16M chars (~32 MB UTF-16) is
 *   well above any realistic legitimate scrollback while still
 *   bounding the worst case.
 *
 * - `TERMINAL_OUTPUT_EVENT_MAX_CHARS` — per-event output chunk size.
 *   Mirrors the input cap (`TerminalWriteInput.data` at 64K) for
 *   symmetry — neither direction should fire a multi-MB single
 *   message. Real PTY chunks are typically tens-to-hundreds of bytes;
 *   64K chars is generous headroom.
 */
export const TERMINAL_HISTORY_MAX_CHARS = 16_777_216;
export const TERMINAL_OUTPUT_EVENT_MAX_CHARS = 65_536;

const TerminalIdWithDefaultSchema = TerminalIdSchema.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_ID)),
);

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = typeof TerminalThreadInput.Type;

const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdWithDefaultSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalOpenInput = Schema.Codec.Encoded<typeof TerminalOpenInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalRestartInput = Schema.Codec.Encoded<typeof TerminalRestartInput>;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = typeof TerminalCloseInput.Type;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  // Slice F.1 / M-2H — these were `Schema.String.check(Schema.isNonEmpty())`,
  // inconsistent with the input schemas above which use `TrimmedNonEmptyString`.
  // `isNonEmpty` checks length > 0 only, so whitespace-only values like
  // `"   "` slip through and silently mismatch threadId/terminalId/cwd
  // lookups downstream. Switching to the canonical
  // `TrimmedNonEmptyStringSchema` matches the input shape and closes the
  // whitespace-bypass class.
  threadId: TrimmedNonEmptyStringSchema,
  terminalId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  // Slice J.1 / M3-12 — bound the scrollback history at the wire so
  // a runaway terminal can't grow the snapshot payload unbounded.
  history: Schema.String.check(Schema.isMaxLength(TERMINAL_HISTORY_MAX_CHARS)),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  updatedAt: Schema.String,
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

const TerminalEventBaseSchema = Schema.Struct({
  // Slice F.1 / M-2H — see TerminalSessionSnapshot above for rationale.
  threadId: TrimmedNonEmptyStringSchema,
  terminalId: TrimmedNonEmptyStringSchema,
  createdAt: Schema.String,
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  // Slice J.1 / M3-12 — per-chunk output cap, mirrors the input cap on
  // TerminalWriteInput.data for symmetry.
  data: Schema.String.check(Schema.isMaxLength(TERMINAL_OUTPUT_EVENT_MAX_CHARS)),
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  // Slice N.2 / M4-10 — cap error message at the same chunk size used
  // for data events (`TERMINAL_OUTPUT_EVENT_MAX_CHARS`, 64K). Without
  // a cap, a hostile or runaway shell could ship a 100MB error
  // string through every renderer that has the terminal channel
  // open. Errors are diagnostic — 64K is more than enough for a
  // stack trace; anything larger is abuse.
  message: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(TERMINAL_OUTPUT_EVENT_MAX_CHARS),
  ),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;

export class TerminalCwdError extends Schema.TaggedErrorClass<TerminalCwdError>()(
  "TerminalCwdError",
  {
    cwd: Schema.String,
    reason: Schema.Literals(["notFound", "notDirectory", "statFailed"]),
  },
) {
  override get message() {
    if (this.reason === "notDirectory") {
      return `Terminal cwd is not a directory: ${this.cwd}`;
    }
    if (this.reason === "notFound") {
      return `Terminal cwd does not exist: ${this.cwd}`;
    }
    const causeMessage =
      this.cause && typeof this.cause === "object" && "message" in this.cause
        ? this.cause.message
        : undefined;
    return causeMessage
      ? `Failed to access terminal cwd: ${this.cwd} (${causeMessage})`
      : `Failed to access terminal cwd: ${this.cwd}`;
  }
}

export class TerminalHistoryError extends Schema.TaggedErrorClass<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literals(["read", "truncate", "migrate"]),
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Failed to ${this.operation} terminal history for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedErrorClass<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedErrorClass<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export const TerminalError = Schema.Union([
  TerminalCwdError,
  TerminalHistoryError,
  TerminalSessionLookupError,
  TerminalNotRunningError,
]);
export type TerminalError = typeof TerminalError.Type;
