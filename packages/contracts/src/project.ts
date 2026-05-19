import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;

/**
 * Character cap on `projects.readFile` payloads. Monaco's editing/render
 * perf degrades on very large documents, so the server slices a file's
 * content to this length and flags the result `truncated`. ~2M chars is
 * roughly 2 MB of code — well past any hand-authored source file, but a
 * hard ceiling against minified bundles / lockfiles / accidental blobs
 * locking up the editor. Exported so the server reads it as the single
 * source of truth rather than redeclaring the number.
 */
export const PROJECT_READ_FILE_MAX_CHARS = 2_000_000;

/**
 * Slice C / H9 fix (2026-05-16) — character cap on `projects.writeFile`
 * payloads. Pre-Slice-C, `ProjectWriteFileInput.contents` was unbounded
 * `Schema.String`. Every other write-shaped input in the codebase has a
 * cap: terminal write 65 KB, provider turn input 120 K chars, filesystem
 * read 2 M chars. Without one, a malicious client could send a
 * multi-gigabyte string and exhaust server memory during JSON parse or
 * fill the disk during the write.
 *
 * The cap is set to 5× the read cap (10 M chars, ~20 MB UTF-16) to:
 *   - accommodate legitimate large files the Editor surfaces (the Editor
 *     reads up to PROJECT_READ_FILE_MAX_CHARS; round-trip saves naturally
 *     stay near that, but paste / generated-content / multi-file copy
 *     operations can briefly exceed it),
 *   - reject the obvious DoS payloads (multi-GB strings) at the wire,
 *   - leave headroom for legitimate workflows without becoming a
 *     "this user hits the cap every day" friction point.
 *
 * Server-side `WorkspaceFileSystem.writeFile` is the consumer; that path
 * also goes through the workspace jail (Slice B) before any byte hits
 * disk, so this is a defense-in-depth pre-filter at the schema boundary.
 */
export const PROJECT_WRITE_FILE_MAX_CHARS = 10_000_000;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  // Slice C / H9 — char cap on the contents payload. See
  // PROJECT_WRITE_FILE_MAX_CHARS for rationale on the value choice.
  contents: Schema.String.check(Schema.isMaxLength(PROJECT_WRITE_FILE_MAX_CHARS)),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
  },
) {}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  /** Path the server resolved + read, relative to the workspace root. */
  relativePath: TrimmedNonEmptyString,
  /** File contents — sliced to PROJECT_READ_FILE_MAX_CHARS when oversized. */
  contents: Schema.String,
  /**
   * True when the file exceeded PROJECT_READ_FILE_MAX_CHARS and `contents`
   * holds only the leading slice. The editor surfaces this so the user
   * knows they're not looking at the whole file.
   */
  truncated: Schema.Boolean,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    message: TrimmedNonEmptyString,
  },
) {}

export const ProjectListTreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListTreeInput = typeof ProjectListTreeInput.Type;

export const ProjectListTreeResult = Schema.Struct({
  /**
   * Full project file index — every file and directory entry, already
   * stripped of ignored dirs (node_modules, .git, dist, ...) and
   * gitignored paths when the project is a git repo. The client
   * assembles these flat entries into a tree.
   */
  entries: Schema.Array(ProjectEntry),
  /**
   * True when the underlying workspace index hit its entry cap — the
   * tree is a partial view of a very large project.
   */
  truncated: Schema.Boolean,
});
export type ProjectListTreeResult = typeof ProjectListTreeResult.Type;

export class ProjectListTreeError extends Schema.TaggedErrorClass<ProjectListTreeError>()(
  "ProjectListTreeError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
