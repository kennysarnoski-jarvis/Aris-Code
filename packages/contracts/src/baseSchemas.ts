import { Schema } from "effect";

export const TrimmedString = Schema.Trim;
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

/**
 * Slice E.1 / H-2C fix (2026-05-16) — prototype-pollution-resistant
 * key schema for `Schema.Record` sites.
 *
 * Background: `Schema.Record(Schema.String, Schema.Unknown)` accepts
 * any string as a key, including the three JS prototype-magic names
 * (`__proto__`, `constructor`, `prototype`). Downstream consumers that
 * spread a decoded record into a plain object (`{ ...defaults,
 * ...record }`) or assign keys one at a time (`for (k of keys) obj[k]
 * = ...`) invoke V8's `__proto__` setter on the target, polluting
 * `Object.prototype` for the entire Node runtime. `constructor` and
 * `prototype` enable second-order escalation paths (`obj.constructor
 * .prototype.x = ...`).
 *
 * `SafeRecordKey` blocks all three names at the schema boundary so
 * the dangerous shapes never enter the runtime in the first place.
 * Defense-in-depth alongside whatever downstream code does — even if
 * a future consumer forgets to use `Object.create(null)`, this gate
 * still catches the attack.
 *
 * Applied at every `Schema.Record` site in the contracts: tool args,
 * user-input answers, runtime metadata, modelUsage, config. None of
 * these keys have any legitimate use as prototype-magic names — if a
 * future tool genuinely needs a field called "constructor", it
 * should be renamed.
 */
const FORBIDDEN_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/**
 * Slice H.1 / H3-6 fix — exported so schemas that already constrain key
 * shape via a custom regex (e.g. `TerminalEnvKeySchema`) can intersect
 * this filter onto their existing checks rather than replacing them.
 * Calling `Schema.String.check(yourCheck).check(safeRecordKeyFilter)`
 * AND-composes the two constraints, so a key must satisfy both.
 */
export const safeRecordKeyFilter = Schema.makeFilter<string>((key) =>
  FORBIDDEN_RECORD_KEYS.has(key)
    ? `record key \`${key}\` is reserved (prototype-pollution risk)`
    : true,
);
export const SafeRecordKey = Schema.String.check(safeRecordKeyFilter);

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Slice N.1 / M4-7 (2026-05-17) — upper bound on branded identifiers.
 *
 * Every entity ID produced by `makeEntityId` (ThreadId, TurnId,
 * MessageId, EventId, AuthSessionId, ProviderItemId, …) flows from
 * untrusted callers — WS RPC inputs, archive payloads, replayed
 * activity rows — into events, logs, sqlite columns, and projection
 * caches. Without a length bound, a malicious or buggy caller can
 * ship a 10MB identifier that propagates through every downstream
 * consumer (one row in the activity sequence projection, every event
 * in the bus replay, every NDJSON log line, every renderer copy).
 *
 * 256 chars is wildly generous — UUIDs are 36, the longest prefix-
 * tagged ID in production is ~40 chars. Picking a uniform cap here
 * means every entity ID is bounded the same way regardless of which
 * brand it lands on, and any future entity-ID schema added via
 * `makeEntityId` inherits the cap automatically — no per-site
 * remembering.
 */
export const ENTITY_ID_MAX_CHARS = 256;
/**
 * Construct a branded identifier. Enforces non-empty trimmed strings,
 * capped at `ENTITY_ID_MAX_CHARS` (Slice N.1 / M4-7).
 */
const makeEntityId = <Brand extends string>(brand: Brand) => {
  return TrimmedNonEmptyString.check(Schema.isMaxLength(ENTITY_ID_MAX_CHARS)).pipe(
    Schema.brand(brand),
  );
};

/**
 * Slice O / M4-3 (2026-05-17) — workspace path string schema.
 *
 * Use for every wire-input field that names an on-disk path the
 * server will operate on: `cwd` of a session, `cwd` of an archive
 * read, project paths, anything that flows from an untrusted caller
 * (WS RPC payload, archived event row) into `fs.*` / `path.join`.
 *
 * Two guards:
 *
 *   1. **Length cap** at `WORKSPACE_PATH_MAX_LENGTH` (4096 = POSIX
 *      `PATH_MAX` on Linux and macOS). The filesystem call will fail
 *      anyway past this, but capping at the schema boundary stops a
 *      10MB cwd from burning CPU through `split`/`join`/`toLowerCase`
 *      in `projectKeyFromCwd` before the fs layer rejects it.
 *
 *   2. **No NUL bytes**. Node's `fs.*` *usually* throws on `\0` in
 *      paths but the behavior is platform-quirky and a future
 *      runtime port (Bun, Deno, browser-side workers) might not.
 *      Reject at the schema so the dangerous shape never lands in
 *      the runtime in the first place.
 *
 * Defense-in-depth alongside the existing path-key sanitization in
 * `RollingWindowMemory.projectKeyFromCwd` and the `threadId`
 * `assertSafeThreadId` guard from Slice H.3.
 */
export const WORKSPACE_PATH_MAX_LENGTH = 4096;
const workspacePathFilter = Schema.makeFilter<string>((value) =>
  value.includes("\0") ? "workspace path must not contain NUL bytes" : true,
);
export const WorkspacePathString = TrimmedNonEmptyString.check(
  Schema.isMaxLength(WORKSPACE_PATH_MAX_LENGTH),
  workspacePathFilter,
);

/**
 * Slice S / M4-9.7 follow-up (2026-05-17) — branch-name validator.
 *
 * Aris's Round 5 audit (M4-9.7) flagged `git checkout <branch>` as
 * unsafe to user-controlled inputs because a branch name starting
 * with `-` injects a flag (`-b evil`, `--detach`, `-f`). The audit
 * proposed inserting `--` before the branch, but `git checkout --
 * <name>` is the FILE-RESTORE form — completely different operation.
 * Slice R applied + reverted that fix once tests caught the
 * regression.
 *
 * Right defense: validate the branch name at the schema boundary.
 * Reject the dangerous shapes before they reach git:
 *
 *   1. Leading `-` — flag injection. Git itself rejects this via
 *      `check-ref-format` but only AFTER it's parsed argv, so a
 *      crafted name still gets dispatched as a flag in the
 *      meantime. Schema-level rejection cuts that off.
 *   2. NUL bytes — fs / process boundary corruption.
 *   3. `..` segment — ref-path traversal (refs/heads/../config).
 *
 * Same shape as `SafeRecordKey` (Slice E.1) and `WorkspacePathString`
 * (Slice O) — composable filter so any future schema that names a
 * git ref can use the same guard.
 */
const safeBranchNameFilter = Schema.makeFilter<string>((value) => {
  if (value.startsWith("-")) {
    return "branch name must not start with `-` (flag-injection vector)";
  }
  if (value.includes("\0")) {
    return "branch name must not contain NUL bytes";
  }
  if (value.includes("..")) {
    return "branch name must not contain `..` (ref-path traversal)";
  }
  return true;
});
export const SafeBranchName = TrimmedNonEmptyString.check(safeBranchNameFilter);

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;
export const AuthSessionId = makeEntityId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;
