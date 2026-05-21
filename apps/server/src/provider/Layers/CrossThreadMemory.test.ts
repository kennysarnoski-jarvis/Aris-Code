/**
 * CrossThreadMemory tests.
 *
 * Builds a real on-disk sessions directory in a tmp dir, populates
 * it with synthetic thread directories + summary files, then
 * exercises `collectMostRecentPriorThreadSummary` against it. The
 * `RollingWindowConfig` injection lets us point at a fresh
 * `arisHomeDir` per test so cases don't bleed into each other and
 * no test ever touches the real `~/.aris`.
 *
 * Coverage:
 *   1. Empty / missing sessions dir → null
 *   2. Only current thread → null (current is excluded)
 *   3. One prior thread with one rollover → that summary
 *   4. Multiple prior threads → most recent mtime wins
 *   5. Multiple windows in same thread → highest window index wins
 *   6. Stale (>14 days old) summary → filtered out
 *   7. Dotfile / malformed entries → skipped
 *   8. Render produces the expected `<thread_history>` wrapper
 */
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ACTIVE_SUMMARY_FILENAME } from "./ActiveSummary.ts";
import {
  collectMostRecentPriorThreadSummary,
  CROSS_THREAD_RECENCY_DAYS,
  renderPriorThreadSummary,
} from "./CrossThreadMemory.ts";
import { makeRollingWindowConfig, projectKeyFromCwd } from "./RollingWindowMemory.ts";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aris-cross-thread-test-"));
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
  // Set both atime and mtime to the requested value so the test
  // controls "how old" the file looks without depending on
  // wall-clock drift between writeFile and utimes.
  const seconds = opts.mtimeMs / 1000;
  await utimes(filepath, seconds, seconds);
  return filepath;
}

afterEach(async () => {
  // Best-effort cleanup; tmpdir entries are short-lived so failures
  // here don't matter much.
  const { rm } = await import("node:fs/promises");
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("CrossThreadMemory — collectMostRecentPriorThreadSummary", () => {
  it("returns null when sessions dir doesn't exist yet (fresh project)", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const result = await collectMostRecentPriorThreadSummary(
      config,
      "/Users/test/proj",
      "thread-1",
    );
    expect(result).toBeNull();
  });

  it("returns null when only the current thread has summaries", async () => {
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
      text: "## Topics\n- something",
    });
    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current");
    expect(result).toBeNull();
  });

  it("returns the prior thread's summary when one exists", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    await writeSummary({
      home,
      cwd,
      threadId: "thread-prior",
      windowIndex: 1,
      mtimeMs: now - 60_000,
      text: "## Topics\n- prior work",
    });
    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current", {
      nowMs: now,
    });
    expect(result).not.toBeNull();
    expect(result?.threadId).toBe("thread-prior");
    expect(result?.windowIndex).toBe(1);
    expect(result?.summaryText).toContain("prior work");
  });

  it("picks the prior thread with the latest mtime when multiple qualify", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    await writeSummary({
      home,
      cwd,
      threadId: "thread-old",
      windowIndex: 1,
      mtimeMs: now - 5 * 24 * 60 * 60 * 1000, // 5 days ago
      text: "## Topics\n- older work",
    });
    await writeSummary({
      home,
      cwd,
      threadId: "thread-fresh",
      windowIndex: 1,
      mtimeMs: now - 60_000, // 1 minute ago
      text: "## Topics\n- fresher work",
    });
    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current", {
      nowMs: now,
    });
    expect(result?.threadId).toBe("thread-fresh");
    expect(result?.summaryText).toContain("fresher work");
  });

  it("picks the highest window index within a single thread", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    await writeSummary({
      home,
      cwd,
      threadId: "thread-prior",
      windowIndex: 1,
      mtimeMs: now - 2 * 60 * 1000,
      text: "## Topics\n- window 1",
    });
    await writeSummary({
      home,
      cwd,
      threadId: "thread-prior",
      windowIndex: 3,
      mtimeMs: now - 60_000,
      text: "## Topics\n- window 3 (latest)",
    });
    await writeSummary({
      home,
      cwd,
      threadId: "thread-prior",
      windowIndex: 2,
      mtimeMs: now - 90_000,
      text: "## Topics\n- window 2",
    });
    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current", {
      nowMs: now,
    });
    expect(result?.windowIndex).toBe(3);
    expect(result?.summaryText).toContain("window 3 (latest)");
  });

  it("filters out summaries older than CROSS_THREAD_RECENCY_DAYS", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    // Set mtime one minute past the 14-day cutoff — past the boundary.
    const past = now - (CROSS_THREAD_RECENCY_DAYS * 24 * 60 * 60 * 1000 + 60_000);
    await writeSummary({
      home,
      cwd,
      threadId: "thread-stale",
      windowIndex: 1,
      mtimeMs: past,
      text: "## Topics\n- ancient work that should NOT surface",
    });
    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current", {
      nowMs: now,
    });
    expect(result).toBeNull();
  });

  it("skips dotfile / malformed entries in the sessions dir", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();

    // Real thread dir
    await writeSummary({
      home,
      cwd,
      threadId: "thread-real",
      windowIndex: 1,
      mtimeMs: now - 60_000,
      text: "## Topics\n- legit",
    });

    // Dotfile that shouldn't be treated as a thread directory
    const projectKey = projectKeyFromCwd(cwd);
    const sessionsDir = join(home, ".aris", "projects", projectKey, "sessions");
    await mkdir(join(sessionsDir, ".DS_Store"), { recursive: true });

    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current", {
      nowMs: now,
    });
    expect(result?.threadId).toBe("thread-real");
  });

  it("returns null when prior thread exists but has no rolled-over windows", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";

    // Create the thread dir manually with only an active.jsonl —
    // no rollovers means no summary files, nothing to surface.
    const projectKey = projectKeyFromCwd(cwd);
    const threadDir = join(home, ".aris", "projects", projectKey, "sessions", "thread-unrolled");
    await mkdir(threadDir, { recursive: true });
    await writeFile(join(threadDir, "active.jsonl"), "{}\n", "utf8");

    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current");
    expect(result).toBeNull();
  });

  it("does not cross project boundaries", async () => {
    // Two different cwds → two different projectKeys → two different
    // sessions dirs. A summary in project A must not surface when
    // the caller is asking about project B.
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const now = Date.now();
    await writeSummary({
      home,
      cwd: "/Users/test/project-a",
      threadId: "thread-in-a",
      windowIndex: 1,
      mtimeMs: now - 60_000,
      text: "## Topics\n- project A's content",
    });
    const result = await collectMostRecentPriorThreadSummary(
      config,
      "/Users/test/project-b",
      "thread-current",
      { nowMs: now },
    );
    expect(result).toBeNull();
  });
});

describe("CrossThreadMemory — active.summary.md surfacing (Slice Z.3)", () => {
  async function writeActiveSummaryFile(opts: {
    readonly home: string;
    readonly cwd: string;
    readonly threadId: string;
    readonly mtimeMs: number;
    readonly text: string;
  }): Promise<string> {
    const projectKey = projectKeyFromCwd(opts.cwd);
    const dir = join(opts.home, ".aris", "projects", projectKey, "sessions", opts.threadId);
    await mkdir(dir, { recursive: true });
    const filepath = join(dir, ACTIVE_SUMMARY_FILENAME);
    await writeFile(filepath, opts.text, "utf8");
    const seconds = opts.mtimeMs / 1000;
    await utimes(filepath, seconds, seconds);
    return filepath;
  }

  it("surfaces an active.summary.md when a thread has no rollover yet", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    await writeActiveSummaryFile({
      home,
      cwd,
      threadId: "thread-in-flight",
      mtimeMs: now - 60_000,
      text: "## Topics\n- in-flight conversation",
    });
    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current", {
      nowMs: now,
    });
    expect(result).not.toBeNull();
    expect(result?.threadId).toBe("thread-in-flight");
    expect(result?.source).toBe("active");
    expect(result?.windowIndex).toBe(0);
    expect(result?.summaryText).toContain("in-flight conversation");
  });

  it("prefers active.summary.md over older window_NNN.summary.md within the same thread", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    // Older rollover summary in the SAME thread
    await writeSummary({
      home,
      cwd,
      threadId: "thread-mixed",
      windowIndex: 1,
      mtimeMs: now - 5 * 60_000,
      text: "## Topics\n- ancient rollover",
    });
    // Fresher active sidecar in the same thread
    await writeActiveSummaryFile({
      home,
      cwd,
      threadId: "thread-mixed",
      mtimeMs: now - 60_000,
      text: "## Topics\n- fresher in-flight work",
    });
    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current", {
      nowMs: now,
    });
    expect(result?.threadId).toBe("thread-mixed");
    expect(result?.source).toBe("active");
    expect(result?.summaryText).toContain("fresher in-flight work");
  });

  it("prefers window_NNN.summary.md over older active.summary.md within the same thread", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    // Older active sidecar
    await writeActiveSummaryFile({
      home,
      cwd,
      threadId: "thread-mixed",
      mtimeMs: now - 5 * 60_000,
      text: "## Topics\n- old in-flight",
    });
    // Fresher window summary (e.g. thread just rolled over and active was deleted)
    await writeSummary({
      home,
      cwd,
      threadId: "thread-mixed",
      windowIndex: 1,
      mtimeMs: now - 60_000,
      text: "## Topics\n- fresh rollover wins",
    });
    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current", {
      nowMs: now,
    });
    expect(result?.source).toBe("rollover");
    expect(result?.summaryText).toContain("fresh rollover wins");
  });

  it("picks the freshest thread across mixed active + rollover sources", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    // Thread A has a rolled summary 3 minutes old
    await writeSummary({
      home,
      cwd,
      threadId: "thread-a-rolled",
      windowIndex: 2,
      mtimeMs: now - 3 * 60_000,
      text: "## Topics\n- thread A rolled",
    });
    // Thread B has an active summary 1 minute old (newer than A's rolled)
    await writeActiveSummaryFile({
      home,
      cwd,
      threadId: "thread-b-active",
      mtimeMs: now - 60_000,
      text: "## Topics\n- thread B in-flight wins",
    });
    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current", {
      nowMs: now,
    });
    expect(result?.threadId).toBe("thread-b-active");
    expect(result?.source).toBe("active");
  });

  it("filters out a stale active.summary.md past the recency window", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const cwd = "/Users/test/proj";
    const now = Date.now();
    const past = now - (CROSS_THREAD_RECENCY_DAYS * 24 * 60 * 60 * 1000 + 60_000);
    await writeActiveSummaryFile({
      home,
      cwd,
      threadId: "thread-stale-active",
      mtimeMs: past,
      text: "## Topics\n- ancient in-flight, should not surface",
    });
    const result = await collectMostRecentPriorThreadSummary(config, cwd, "thread-current", {
      nowMs: now,
    });
    expect(result).toBeNull();
  });
});

describe("CrossThreadMemory — renderPriorThreadSummary", () => {
  it("wraps a rollover summary with source=rollover attribute", () => {
    const rendered = renderPriorThreadSummary({
      threadId: "thread-xyz",
      source: "rollover",
      windowIndex: 3,
      mtimeMs: Date.parse("2026-05-17T12:00:00.000Z"),
      summaryText: "## Topics\n- something\n",
    });
    expect(rendered).toContain(
      `<thread_history thread_id="thread-xyz" source="rollover" window_index="3" mtime_iso="2026-05-17T12:00:00.000Z">`,
    );
    expect(rendered).toContain("## Topics\n- something");
    expect(rendered).toContain("</thread_history>");
    expect(rendered).not.toContain("\n\n</thread_history>");
  });

  it("wraps an active summary with source=active attribute and windowIndex=0", () => {
    const rendered = renderPriorThreadSummary({
      threadId: "thread-active",
      source: "active",
      windowIndex: 0,
      mtimeMs: Date.parse("2026-05-18T03:30:00.000Z"),
      summaryText: "## Topics\n- in-flight work\n",
    });
    expect(rendered).toContain(
      `<thread_history thread_id="thread-active" source="active" window_index="0" mtime_iso="2026-05-18T03:30:00.000Z">`,
    );
    expect(rendered).toContain("in-flight work");
  });
});
