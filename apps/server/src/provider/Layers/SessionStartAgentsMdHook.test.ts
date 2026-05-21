/**
 * SessionStartAgentsMdHook tests.
 *
 * Exercises the hook against real on-disk convention files in a
 * tmp dir. Covers:
 *
 *   1. No cwd → no inject (the "no folder open" case)
 *   2. Missing convention files → no inject (fresh project)
 *   3. ARIS.md takes priority over AGENTS.md when both exist
 *   4. AGENTS.md is used as fallback when ARIS.md is absent
 *   5. Empty convention file → skipped (no inject)
 *   6. Hook integrates with HookBus — dispatchSessionStart returns
 *      the same inject string
 *   7. Hook can't read → returns no inject (directory as cwd, etc.)
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeHookBus } from "./HookBus.ts";
import { makeSessionStartAgentsMdHook } from "./SessionStartAgentsMdHook.ts";

const tempDirs: string[] = [];

async function makeTempCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aris-agents-md-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("SessionStartAgentsMdHook — no cwd", () => {
  it("returns no inject when cwd is undefined", async () => {
    const hook = makeSessionStartAgentsMdHook();
    const result = await hook.handler({
      event: "SessionStart",
      threadId: "thread-1",
      cwd: undefined,
    });
    expect(result).toEqual({});
  });
});

describe("SessionStartAgentsMdHook — missing files", () => {
  it("returns no inject when no convention files exist", async () => {
    const cwd = await makeTempCwd();
    const hook = makeSessionStartAgentsMdHook();
    const result = await hook.handler({
      event: "SessionStart",
      threadId: "thread-1",
      cwd,
    });
    expect(result).toEqual({});
  });
});

describe("SessionStartAgentsMdHook — ARIS.md priority", () => {
  it("uses ARIS.md when both ARIS.md and AGENTS.md exist", async () => {
    const cwd = await makeTempCwd();
    await writeFile(join(cwd, "ARIS.md"), "# Aris conventions\nUse bun.", "utf-8");
    await writeFile(join(cwd, "AGENTS.md"), "# Agent conventions\nUse npm.", "utf-8");

    const hook = makeSessionStartAgentsMdHook();
    const result = await hook.handler({
      event: "SessionStart",
      threadId: "thread-1",
      cwd,
    });

    expect(result.inject).toBeDefined();
    expect(result.inject!).toContain("Project conventions (ARIS.md)");
    expect(result.inject!).toContain("# Aris conventions");
    expect(result.inject!).toContain("Use bun.");
    expect(result.inject!).not.toContain("AGENTS.md");
  });
});

describe("SessionStartAgentsMdHook — AGENTS.md fallback", () => {
  it("uses AGENTS.md when ARIS.md is absent", async () => {
    const cwd = await makeTempCwd();
    await writeFile(join(cwd, "AGENTS.md"), "# Agent conventions\nUse npm.", "utf-8");

    const hook = makeSessionStartAgentsMdHook();
    const result = await hook.handler({
      event: "SessionStart",
      threadId: "thread-1",
      cwd,
    });

    expect(result.inject).toBeDefined();
    expect(result.inject!).toContain("Project conventions (AGENTS.md)");
    expect(result.inject!).toContain("# Agent conventions");
    expect(result.inject!).toContain("Use npm.");
  });
});

describe("SessionStartAgentsMdHook — empty files", () => {
  it("skips an empty ARIS.md and falls back to AGENTS.md", async () => {
    const cwd = await makeTempCwd();
    await writeFile(join(cwd, "ARIS.md"), "   \n  \n", "utf-8"); // whitespace only
    await writeFile(join(cwd, "AGENTS.md"), "# Fallback conventions", "utf-8");

    const hook = makeSessionStartAgentsMdHook();
    const result = await hook.handler({
      event: "SessionStart",
      threadId: "thread-1",
      cwd,
    });

    expect(result.inject).toBeDefined();
    expect(result.inject!).toContain("Project conventions (AGENTS.md)");
    expect(result.inject!).toContain("# Fallback conventions");
  });

  it("skips an empty AGENTS.md when it's the only file", async () => {
    const cwd = await makeTempCwd();
    await writeFile(join(cwd, "AGENTS.md"), "", "utf-8"); // completely empty

    const hook = makeSessionStartAgentsMdHook();
    const result = await hook.handler({
      event: "SessionStart",
      threadId: "thread-1",
      cwd,
    });

    expect(result).toEqual({});
  });
});

describe("SessionStartAgentsMdHook — HookBus integration", () => {
  it("dispatchSessionStart returns the hook's inject string", async () => {
    const cwd = await makeTempCwd();
    await writeFile(join(cwd, "ARIS.md"), "# Aris rules\nRun `bun test`.", "utf-8");

    const bus = makeHookBus();
    bus.register(makeSessionStartAgentsMdHook());

    const out = await bus.dispatchSessionStart({
      event: "SessionStart",
      threadId: "thread-1",
      cwd,
    });

    expect(out).toBeDefined();
    expect(out!).toContain("Project conventions (ARIS.md)");
    expect(out!).toContain("# Aris rules");
    expect(out!).toContain("Run `bun test`.");
  });

  it("dispatchSessionStart returns undefined when no conventions exist", async () => {
    const cwd = await makeTempCwd();
    const bus = makeHookBus();
    bus.register(makeSessionStartAgentsMdHook());

    const out = await bus.dispatchSessionStart({
      event: "SessionStart",
      threadId: "thread-1",
      cwd,
    });

    expect(out).toBeUndefined();
  });
});

describe("SessionStartAgentsMdHook — error resilience", () => {
  it("returns no inject when cwd is a path we can't read as a file", async () => {
    // The hook uses fs.stat + fs.readFile — for a directory, stat
    // will return a directory (not a file), so it skips. This is
    // normal behavior, not an error — but verifies the hook doesn't
    // blow up on unexpected inode types.
    const hook = makeSessionStartAgentsMdHook();
    const result = await hook.handler({
      event: "SessionStart",
      threadId: "thread-1",
      cwd: "/", // root directory — stat will say "directory", hook skips
    });
    expect(result).toEqual({});
  });

  it("returns no inject when cwd is a non-existent path", async () => {
    const hook = makeSessionStartAgentsMdHook();
    const result = await hook.handler({
      event: "SessionStart",
      threadId: "thread-1",
      cwd: "/nonexistent/path/12345",
    });
    // fs.stat throws ENOENT → caught internally → returns null → no inject
    expect(result).toEqual({});
  });
});
