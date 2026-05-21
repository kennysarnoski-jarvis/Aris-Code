/**
 * Slice S contract tests — M4-9.7 follow-up (SafeBranchName).
 *
 * Pins the schema-level branch-name filter so a future refactor that
 * drops the filter or weakens any of its three guards trips here.
 *
 * The three guards:
 *   1. Leading `-` — flag injection on `git checkout`, `git branch`,
 *      `git worktree`, etc. The original Slice R fix tried `--`
 *      separator and broke checkout semantics (see GitCore.ts revert
 *      comments). SafeBranchName is the correct defense.
 *   2. NUL bytes — fs / process boundary corruption.
 *   3. `..` segment — ref-path traversal (refs/heads/../config).
 *
 * Three representative input schemas are exercised
 * (`GitCheckoutInput`, `GitCreateBranchInput`,
 * `GitCreateWorktreeInput`) so a per-site typo at one of the four
 * applied sites shows up cleanly.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { GitCheckoutInput, GitCreateBranchInput, GitCreateWorktreeInput } from "@t3tools/contracts";

describe("Slice S — M4-9.7: SafeBranchName on GitCheckoutInput.branch", () => {
  const decode = Schema.decodeUnknownSync(GitCheckoutInput);

  it("accepts a normal branch name (regression check)", () => {
    const result = decode({ cwd: "/tmp/repo", branch: "feature/test" });
    expect(result.branch).toBe("feature/test");
  });

  it("rejects a branch name starting with `-` (flag-injection vector)", () => {
    // The load-bearing assertion. Pre-Slice-S this decoded as a
    // valid TrimmedNonEmptyString and `-b` reached git as the
    // FIRST positional arg — interpreted as the `-b` flag (create
    // new branch).
    expect(() => decode({ cwd: "/tmp/repo", branch: "-b evil" })).toThrow();
    expect(() => decode({ cwd: "/tmp/repo", branch: "--detach" })).toThrow();
    expect(() => decode({ cwd: "/tmp/repo", branch: "-f" })).toThrow();
  });

  it("rejects a branch name containing a NUL byte", () => {
    expect(() => decode({ cwd: "/tmp/repo", branch: "feature\0evil" })).toThrow();
  });

  it("rejects a branch name containing `..` (ref-path traversal)", () => {
    expect(() => decode({ cwd: "/tmp/repo", branch: "feature/../config" })).toThrow();
  });

  it("rejects an empty branch (TrimmedNonEmpty composes with filter)", () => {
    // Confirm the underlying non-empty guard didn't get dropped.
    expect(() => decode({ cwd: "/tmp/repo", branch: "" })).toThrow();
  });
});

describe("Slice S — M4-9.7: SafeBranchName on GitCreateBranchInput.branch", () => {
  const decode = Schema.decodeUnknownSync(GitCreateBranchInput);

  it("accepts a normal branch name (regression check)", () => {
    expect(decode({ cwd: "/tmp/repo", branch: "feature/new" }).branch).toBe("feature/new");
  });

  it("rejects a branch name starting with `-`", () => {
    // `git branch -d existing` would delete the existing branch.
    expect(() => decode({ cwd: "/tmp/repo", branch: "-d existing" })).toThrow();
  });
});

describe("Slice S — M4-9.7: SafeBranchName on GitCreateWorktreeInput.branch + newBranch", () => {
  const decode = Schema.decodeUnknownSync(GitCreateWorktreeInput);

  it("accepts normal branch + newBranch (regression check)", () => {
    const result = decode({
      cwd: "/tmp/repo",
      branch: "main",
      newBranch: "feature/from-main",
      path: null,
    });
    expect(result.branch).toBe("main");
    expect(result.newBranch).toBe("feature/from-main");
  });

  it("rejects flag-injection on the `branch` field", () => {
    expect(() =>
      decode({ cwd: "/tmp/repo", branch: "-b evil", newBranch: undefined, path: null }),
    ).toThrow();
  });

  it("rejects flag-injection on the `newBranch` field", () => {
    expect(() =>
      decode({ cwd: "/tmp/repo", branch: "main", newBranch: "-f bad", path: null }),
    ).toThrow();
  });
});
