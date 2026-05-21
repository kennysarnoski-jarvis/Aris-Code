/**
 * Slice Z.2 — SessionStartCrossThreadHook tests.
 *
 * Exercises the hook end-to-end against a real on-disk sessions
 * directory in a tmp dir. The hook is the bus-native version of
 * Slice X's inline injection; these tests pin its behavior
 * specifically:
 *
 *   1. No cwd → no inject (the "no folder open" case)
 *   2. Empty sessions dir → no inject (fresh project)
 *   3. Prior thread with a rollover summary → inject contains
 *      the rendered briefing AND the boilerplate with the prior
 *      thread's id pre-filled into the archive-tool hints.
 *   4. Hook integrates with the bus: registering it and calling
 *      `dispatchSessionStart` returns the same string the hook
 *      produces directly.
 *   5. Read failure inside the hook is swallowed (returns no
 *      inject, sibling SessionStart hooks remain intact when
 *      composed through the bus).
 */
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeHookBus } from "./HookBus.ts";
import { makeRollingWindowConfig, projectKeyFromCwd } from "./RollingWindowMemory.ts";
import { makeSessionStartCrossThreadHook } from "./SessionStartCrossThreadHook.ts";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aris-session-start-cross-thread-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSummary(opts: {
  readonly home: string;
  readonly cwd: string;
  readonly threadId: string;
  readonly windowIndex: number;
  readonly mtimeMs: number;
  readonly text: string;
}): Promise<string> {
  const projectKey = projectKeyFromCwd(opts.cwd);
  const dir = join(opts.home, ".aris", "projects", projectKey, "sessions", opts.threadId);
  await mkdir(dir, { recursive: true });
  const padded = String(opts.windowIndex).padStart(3, "0");
  const filename = `window_${padded}.summary.md`;
  const filepath = join(dir, filename);
  await writeFile(filepath, opts.text, "utf8");
  const seconds = opts.mtimeMs / 1000;
  await utimes(filepath, seconds, seconds);
  return filepath;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("SessionStartCrossThreadHook — direct handler invocation", () => {
  it("returns no inject when cwd is undefined", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const spec = makeSessionStartCrossThreadHook(config);
    const result = await spec.handler({
      event: "SessionStart",
      threadId: "thread-current",
      cwd: undefined,
    });
    expect(result).toEqual({});
  });

  it("returns no inject when sessions dir doesn't exist yet", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const spec = makeSessionStartCrossThreadHook(config);
    const result = await spec.handler({
      event: "SessionStart",
      threadId: "thread-current",
      cwd: "/Users/test/proj",
    });
    expect(result).toEqual({});
  });

  it("returns no inject when only the current thread has summaries", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    await writeSummary({
      home,
      cwd,
      threadId: "thread-current",
      windowIndex: 1,
      mtimeMs: now,
      text: "## Topics\n- own thread, shouldn't surface",
    });
    const spec = makeSessionStartCrossThreadHook(config);
    const result = await spec.handler({
      event: "SessionStart",
      threadId: "thread-current",
      cwd,
    });
    expect(result).toEqual({});
  });

  it("returns inject with boilerplate + threadId-prefilled tool hints + summary when prior thread exists", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    await writeSummary({
      home,
      cwd,
      threadId: "thread-prior-abc",
      windowIndex: 2,
      mtimeMs: now - 60_000,
      text: "## Topics\n- prior thread's work",
    });
    const spec = makeSessionStartCrossThreadHook(config);
    const result = await spec.handler({
      event: "SessionStart",
      threadId: "thread-current",
      cwd,
    });
    expect(result.inject).toBeDefined();
    const inject = result.inject as string;

    // Boilerplate header
    expect(inject).toContain("## Prior thread in this project");
    expect(inject).toContain("## When to dig deeper");

    // The prior thread id is pre-filled in all three archive-tool hints
    expect(inject).toContain('list_archives(thread_id="thread-prior-abc")');
    expect(inject).toContain('search_archives(query, thread_id="thread-prior-abc")');
    expect(inject).toContain(
      'read_archive_range(window_index, start_msg, end_msg, thread_id="thread-prior-abc")',
    );

    // The rendered <thread_history> tail with the summary body
    expect(inject).toContain(
      '<thread_history thread_id="thread-prior-abc" source="rollover" window_index="2"',
    );
    expect(inject).toContain("prior thread's work");
    expect(inject).toContain("</thread_history>");
  });
});

describe("SessionStartCrossThreadHook — composed through the bus", () => {
  it("dispatchSessionStart returns the hook's inject string", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    await writeSummary({
      home,
      cwd,
      threadId: "thread-prior-bus",
      windowIndex: 1,
      mtimeMs: now - 60_000,
      text: "## Topics\n- bus-routed work",
    });

    const bus = makeHookBus();
    bus.register(makeSessionStartCrossThreadHook(config));
    const out = await bus.dispatchSessionStart({
      event: "SessionStart",
      threadId: "thread-current",
      cwd,
    });

    expect(out).toBeDefined();
    expect(out).toContain("bus-routed work");
    expect(out).toContain('list_archives(thread_id="thread-prior-bus")');
  });

  it("dispatchSessionStart returns undefined when no prior thread exists", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const bus = makeHookBus();
    bus.register(makeSessionStartCrossThreadHook(config));
    const out = await bus.dispatchSessionStart({
      event: "SessionStart",
      threadId: "thread-current",
      cwd: "/Users/test/fresh-project",
    });
    expect(out).toBeUndefined();
  });

  it("composes alongside a second SessionStart hook with priority ordering", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    await writeSummary({
      home,
      cwd,
      threadId: "thread-prior-compose",
      windowIndex: 1,
      mtimeMs: now - 60_000,
      text: "## Topics\n- composed work",
    });

    const bus = makeHookBus();
    // Register a higher-priority sibling that injects a header so we
    // can verify ordering: the sibling at priority 50 comes first,
    // the cross-thread hook at priority 100 comes second.
    bus.register({
      event: "SessionStart",
      name: "header-injector",
      priority: 50,
      handler: () => ({ inject: "PROJECT_HEADER_X" }),
    });
    bus.register(makeSessionStartCrossThreadHook(config));

    const out = await bus.dispatchSessionStart({
      event: "SessionStart",
      threadId: "thread-current",
      cwd,
    });

    expect(out).toBeDefined();
    const text = out as string;
    const headerIdx = text.indexOf("PROJECT_HEADER_X");
    const xthreadIdx = text.indexOf("## Prior thread in this project");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(xthreadIdx).toBeGreaterThan(headerIdx);
    // Bus join is "\n\n" — header and cross-thread block both present
    expect(text).toContain("PROJECT_HEADER_X\n\n## Prior thread in this project");
  });
});
