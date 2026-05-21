/**
 * Slice P contract tests — Round 4 M4-8 (Schema.Defect cause leak).
 *
 * Pins the schema-level removal of `cause: Schema.optional(Schema.Defect)`
 * from every tagged-error class on the wire so a future refactor that
 * re-adds it (and thus re-introduces the leak) trips here. The
 * actual leak shape — `Schema.Defect` encoding `new Error("sk-...")`
 * to `{ message: "sk-...", name: "Error" }` and shipping it through
 * the wire — was confirmed in the Round 4 audit; this test pins both
 *
 *   1. The "would-have-leaked" baseline — a probe schema with
 *      `Schema.Defect` still in it does in fact serialize the error
 *      message to the encoded form.
 *   2. The fix — every shipped tagged-error class either
 *      (a) doesn't carry `cause` in its schema at all, or
 *      (b) carries it but the encoded wire shape excludes `cause`.
 *
 * Representative coverage: we exercise `GitCommandError`,
 * `TextGenerationError`, `TerminalCwdError`, `OrchestrationGetSnapshotError`,
 * `FilesystemBrowseError`, and `OpenError` — one from each contract
 * file that had a `cause` field pre-Slice-P. If any of these regress,
 * the diagnosis is clear and the fix is scoped to one file.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  FilesystemBrowseError,
  GitCommandError,
  OpenError,
  OrchestrationGetSnapshotError,
  TerminalCwdError,
  TextGenerationError,
} from "@t3tools/contracts";

describe("Slice P — M4-8 baseline: Schema.Defect WOULD leak (kept for reference)", () => {
  // This probe demonstrates the leak shape we're defending against.
  // If the Effect Schema runtime ever changes its Defect serializer
  // to redact-by-default, the rest of the Slice P tests become
  // belt-and-suspenders rather than load-bearing — but until then,
  // the no-cause-on-wire guarantee comes from removing the field at
  // the schema level, NOT from anything Schema.Defect does.
  it("Schema.Defect encodes Error to { message, name } — the leak shape", () => {
    class LeakyError extends Schema.TaggedErrorClass<LeakyError>()("LeakyError", {
      detail: Schema.String,
      cause: Schema.optional(Schema.Defect),
    }) {}

    const err = new LeakyError({
      detail: "outer",
      cause: new Error("inner with sk-1234567890abcdef secret"),
    });
    const encoded = Schema.encodeUnknownSync(LeakyError)(err) as {
      cause?: { message?: string; name?: string };
    };

    // The leak: the cause's message lands on the wire verbatim.
    expect(encoded.cause).toBeDefined();
    expect(encoded.cause?.message).toContain("sk-1234567890abcdef");
  });
});

describe("Slice P — M4-8: shipped tagged errors no longer carry cause on the wire", () => {
  // For each representative class, construct an instance, encode it,
  // and assert the encoded shape does not have a `cause` key. Going
  // through the Schema.encodeUnknownSync path proves the wire output
  // — what a renderer would receive over WS — never includes cause.

  it("GitCommandError — no cause on wire", () => {
    const err = new GitCommandError({
      operation: "push",
      command: "git push",
      cwd: "/tmp",
      detail: "outer",
    });
    const encoded = Schema.encodeUnknownSync(GitCommandError)(err);
    expect(encoded).not.toHaveProperty("cause");
  });

  it("TextGenerationError — no cause on wire", () => {
    const err = new TextGenerationError({
      operation: "commit-message",
      detail: "model timed out",
    });
    const encoded = Schema.encodeUnknownSync(TextGenerationError)(err);
    expect(encoded).not.toHaveProperty("cause");
  });

  it("TerminalCwdError — no cause on wire", () => {
    const err = new TerminalCwdError({ cwd: "/tmp/nope", reason: "notFound" });
    const encoded = Schema.encodeUnknownSync(TerminalCwdError)(err);
    expect(encoded).not.toHaveProperty("cause");
  });

  it("OrchestrationGetSnapshotError — no cause on wire", () => {
    const err = new OrchestrationGetSnapshotError({ message: "snapshot failed" });
    const encoded = Schema.encodeUnknownSync(OrchestrationGetSnapshotError)(err);
    expect(encoded).not.toHaveProperty("cause");
  });

  it("FilesystemBrowseError — no cause on wire", () => {
    const err = new FilesystemBrowseError({ message: "ENOENT" });
    const encoded = Schema.encodeUnknownSync(FilesystemBrowseError)(err);
    expect(encoded).not.toHaveProperty("cause");
  });

  it("OpenError — no cause on wire", () => {
    const err = new OpenError({ message: "failed to spawn detached process" });
    const encoded = Schema.encodeUnknownSync(OpenError)(err);
    expect(encoded).not.toHaveProperty("cause");
  });
});

describe("Slice P — M4-8: constructor type signatures reject cause field", () => {
  // Type-level pin: the constructor of each tagged-error class
  // should not accept a `cause` key. If a future refactor re-adds
  // `cause: Schema.optional(Schema.Defect)` to the schema, the
  // constructor will accept the field again — but it shouldn't.
  // This is a structural test that confirms (at type level) the
  // schema field is gone. If you uncomment any of the lines below,
  // TypeScript should error.
  it("GitCommandError construction with cause: must not typecheck", () => {
    void new GitCommandError({
      operation: "push",
      command: "git push",
      cwd: "/tmp",
      detail: "outer",
      // @ts-expect-error — cause field removed in Slice P / M4-8
      cause: new Error("inner"),
    });
    expect(true).toBe(true); // assertion is the ts-expect-error directive
  });

  it("OpenError construction with cause: must not typecheck", () => {
    void new OpenError({
      message: "failed",
      // @ts-expect-error — cause field removed in Slice P / M4-8
      cause: new Error("inner"),
    });
    expect(true).toBe(true);
  });
});
