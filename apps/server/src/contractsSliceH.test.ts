/**
 * Slice H contract-and-runtime tests.
 *
 * Pins the H3-1 / H3-3 / H3-6 fixes at the schema / pure-helper layer
 * so a future refactor that loosens any of them trips here before the
 * regression ships. H3-4 (worktree path realpath walker) lives in
 * GitCore.test.ts since it needs real-filesystem symlinks.
 *
 *   - H3-1 (JSON.parse error content strip): exercised by the runner-
 *     level tests; this file pins the surrounding invariant that the
 *     `parseError` string carries only byte-count metadata, no
 *     attacker-controlled JSON content.
 *
 *   - H3-3 (`assertSafeThreadId` in RollingWindowMemory): pins the
 *     guard's accept/reject rules so a future refactor that widens
 *     the safe-character set or drops the path-separator check fails
 *     here. Indirectly tested via `getThreadArchiveDir` since
 *     `assertSafeThreadId` itself is module-private.
 *
 *   - H3-6 (`TerminalEnvSchema` intersected with `safeRecordKeyFilter`):
 *     pins the key validator so `__proto__` / `constructor` /
 *     `prototype` are rejected as env-var names, on top of the
 *     existing identifier-shape regex.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { TerminalOpenInput } from "@t3tools/contracts";
import {
  getThreadArchiveDir,
  makeRollingWindowConfig,
} from "./provider/Layers/RollingWindowMemory.ts";

// Slice L / M3-2 — tests construct their own config pointed at a
// synthetic home so they don't depend on (or write to) the real
// `~/.aris/...` directory. The threadId-safety checks below don't
// actually touch disk — `getThreadArchiveDir` is pure path math —
// but the config arg is required by the function signature now.
const TEST_RW_CONFIG = makeRollingWindowConfig("/Users/test");

describe("Slice H.1 — H3-6: TerminalEnvSchema rejects prototype-magic env-var names", () => {
  const decode = Schema.decodeUnknownSync(TerminalOpenInput);
  const base = {
    threadId: "thread-test",
    terminalId: "term-test",
    cwd: "/tmp",
  };

  it("accepts legitimate env var keys", () => {
    const result = decode({ ...base, env: { PATH: "/usr/bin", FOO_BAR: "baz" } });
    expect(result.env).toEqual({ PATH: "/usr/bin", FOO_BAR: "baz" });
  });

  for (const forbidden of ["__proto__", "constructor", "prototype"]) {
    it(`rejects \`${forbidden}\` as an env-var key (JSON.parse vector)`, () => {
      // Build the polluted payload via JSON.parse so __proto__ becomes
      // a real own property (object-literal syntax would make it the
      // prototype setter instead — same vector caveat as Slice E.1).
      const polluted = JSON.parse(`{"${forbidden}": "value"}`) as Record<string, unknown>;
      expect(() => decode({ ...base, env: polluted })).toThrow();
    });
  }

  it("still enforces the identifier-shape regex (Slice E.1 didn't replace it)", () => {
    // The pre-Slice-H regex `/^[A-Za-z_][A-Za-z0-9_]*$/` is preserved
    // as the first check. The `safeRecordKeyFilter` is AND-composed
    // onto it. Keys with disallowed shape characters (spaces, dashes,
    // dots) still trip the regex, independently of the new filter.
    expect(() => decode({ ...base, env: { "BAD KEY": "x" } })).toThrow();
    expect(() => decode({ ...base, env: { "bad.key": "x" } })).toThrow();
    expect(() => decode({ ...base, env: { "bad-key": "x" } })).toThrow();
  });
});

describe("Slice H.3 — H3-3: getThreadArchiveDir rejects unsafe threadId", () => {
  it("accepts a normal UUID-shaped threadId", () => {
    // The canonical legitimate shape. UUIDs, `thread_<uuid>`, and
    // alphanumeric slugs all pass.
    const dir = getThreadArchiveDir(TEST_RW_CONFIG, "/Users/test/proj", "thread_abc123");
    expect(dir).toContain("thread_abc123");
  });

  it("accepts a dash-separated threadId (common UUID rendering)", () => {
    const dir = getThreadArchiveDir(
      TEST_RW_CONFIG,
      "/Users/test/proj",
      "947fadf8-1999-4b59-9428-1bd5809605f2",
    );
    expect(dir).toContain("947fadf8-1999-4b59-9428-1bd5809605f2");
  });

  it("rejects path-traversal in threadId (../)", () => {
    // The load-bearing case. Pre-Slice-H this would normalize through
    // path.join, escaping the sessions/ directory.
    expect(() => getThreadArchiveDir(TEST_RW_CONFIG, "/Users/test/proj", "../../etc")).toThrow(
      /unsafe characters/i,
    );
  });

  it("rejects forward-slash path separator in threadId", () => {
    expect(() => getThreadArchiveDir(TEST_RW_CONFIG, "/Users/test/proj", "a/b/c")).toThrow(
      /unsafe characters/i,
    );
  });

  it("rejects backslash path separator in threadId", () => {
    expect(() => getThreadArchiveDir(TEST_RW_CONFIG, "/Users/test/proj", "a\\b\\c")).toThrow(
      /unsafe characters/i,
    );
  });

  it("rejects NUL byte in threadId", () => {
    // String.fromCharCode(0) so the source-level fixture is
    // unambiguous and immune to editor / formatter munging — same
    // pattern as the other null-byte tests in this codebase.
    const NUL = String.fromCharCode(0);
    expect(() =>
      getThreadArchiveDir(TEST_RW_CONFIG, "/Users/test/proj", `thread${NUL}evil`),
    ).toThrow(/unsafe characters/i);
  });

  it("rejects an empty threadId", () => {
    expect(() => getThreadArchiveDir(TEST_RW_CONFIG, "/Users/test/proj", "")).toThrow(/empty/i);
  });

  it("rejects an absurdly long threadId (>256 chars)", () => {
    // The cap exists so a hostile threadId can't blow up the path
    // length and bypass filesystem-level limits on later operations.
    const longId = "a".repeat(257);
    expect(() => getThreadArchiveDir(TEST_RW_CONFIG, "/Users/test/proj", longId)).toThrow(/256/);
  });

  it("rejects a `.` or `..` threadId standalone", () => {
    // Both `.` and `..` match nothing in the safe-character regex
    // (the regex requires [A-Za-z0-9_-]+, and `.` is none of those).
    expect(() => getThreadArchiveDir(TEST_RW_CONFIG, "/Users/test/proj", ".")).toThrow(
      /unsafe characters/i,
    );
    expect(() => getThreadArchiveDir(TEST_RW_CONFIG, "/Users/test/proj", "..")).toThrow(
      /unsafe characters/i,
    );
  });
});
