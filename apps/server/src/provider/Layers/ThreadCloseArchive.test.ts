/**
 * Slice Y tests — `archiveActiveWindowOnClose`.
 *
 * Covers the thread-close path that finalizes an un-rolled-over
 * thread's `active.jsonl` into `window_NNN.jsonl` so a future
 * thread's cross-thread scan (Slice X) finds the resulting summary.
 *
 * Coverage:
 *   1. No active.jsonl → archived: false / reason: "no-active-file"
 *   2. Active.jsonl below threshold → archived: false / reason: "below-threshold"
 *   3. Active.jsonl at threshold → archived: true (boundary)
 *   4. Active.jsonl above threshold → archived: true, file renamed
 *   5. Window index picks 1 for a thread with no prior rollovers
 *   6. Window index increments past existing window files
 *   7. Rename leaves active.jsonl gone + archive present (atomic shape)
 *   8. THREAD_CLOSE_MIN_ACTIVE_BYTES is pinned at 2048
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  archiveActiveWindowOnClose,
  getActiveWindowPath,
  getThreadArchiveDir,
  makeRollingWindowConfig,
  THREAD_CLOSE_MIN_ACTIVE_BYTES,
} from "./RollingWindowMemory.ts";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aris-thread-close-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const TEST_CWD = "/Users/test/proj";
const TEST_THREAD = "thread-close-test";

describe("Slice Y — archiveActiveWindowOnClose", () => {
  it("THREAD_CLOSE_MIN_ACTIVE_BYTES is pinned at 2048", () => {
    // The threshold lives across two slices' worth of reasoning
    // (the no-summary-for-trivial-threads call). If it ever slides,
    // trip immediately so the rationale gets revisited.
    expect(THREAD_CLOSE_MIN_ACTIVE_BYTES).toBe(2048);
  });

  it("returns archived:false / no-active-file when active.jsonl doesn't exist", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const result = await archiveActiveWindowOnClose(config, TEST_CWD, TEST_THREAD);
    expect(result.archived).toBe(false);
    if (!result.archived) {
      expect(result.reason).toBe("no-active-file");
      expect(result.currentBytes).toBe(0);
    }
  });

  it("returns archived:false / below-threshold when active.jsonl is tiny", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const threadDir = getThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    await mkdir(threadDir, { recursive: true });
    const activePath = getActiveWindowPath(config, TEST_CWD, TEST_THREAD);
    // 100 bytes — well under 2048
    await writeFile(activePath, "a".repeat(100), "utf8");

    const result = await archiveActiveWindowOnClose(config, TEST_CWD, TEST_THREAD);
    expect(result.archived).toBe(false);
    if (!result.archived) {
      expect(result.reason).toBe("below-threshold");
      expect(result.currentBytes).toBe(100);
    }
    // active.jsonl should still exist (no archive performed)
    const activeStat = await stat(activePath);
    expect(activeStat.size).toBe(100);
  });

  it("archives when active.jsonl is at exactly the threshold", async () => {
    // Boundary test. At exactly THREAD_CLOSE_MIN_ACTIVE_BYTES the
    // function archives — the cutoff is `<`, not `<=`.
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const threadDir = getThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    await mkdir(threadDir, { recursive: true });
    const activePath = getActiveWindowPath(config, TEST_CWD, TEST_THREAD);
    await writeFile(activePath, "x".repeat(THREAD_CLOSE_MIN_ACTIVE_BYTES), "utf8");

    const result = await archiveActiveWindowOnClose(config, TEST_CWD, TEST_THREAD);
    expect(result.archived).toBe(true);
    if (result.archived) {
      expect(result.archivedBytes).toBe(THREAD_CLOSE_MIN_ACTIVE_BYTES);
      expect(result.windowIndex).toBe(1);
    }
  });

  it("archives substantive active.jsonl and renames it to window_001.jsonl", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const threadDir = getThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    await mkdir(threadDir, { recursive: true });
    const activePath = getActiveWindowPath(config, TEST_CWD, TEST_THREAD);
    // 5K of synthetic conversation — well over the 2K threshold
    const payload =
      '{"role":"user","content":"hello","timestamp":"2026-05-18T00:00:00.000Z","messageId":"m1","turnId":"t1"}\n'.repeat(
        50,
      );
    await writeFile(activePath, payload, "utf8");
    const originalBytes = (await stat(activePath)).size;

    const result = await archiveActiveWindowOnClose(config, TEST_CWD, TEST_THREAD);
    expect(result.archived).toBe(true);
    if (result.archived) {
      expect(result.windowIndex).toBe(1);
      expect(result.archivedBytes).toBe(originalBytes);
      expect(result.archivedPath).toContain("window_001.jsonl");
      // Archive file exists with the original content
      const archived = await readFile(result.archivedPath, "utf8");
      expect(archived).toBe(payload);
    }
    // active.jsonl is GONE (rename is a move, not a copy)
    let activeExists = true;
    try {
      await stat(activePath);
    } catch {
      activeExists = false;
    }
    expect(activeExists).toBe(false);
  });

  it("picks the next window index when prior rollovers exist", async () => {
    // If the thread already rolled over to window_001 and window_002,
    // a close-time archive should pick window_003.
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const threadDir = getThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    await mkdir(threadDir, { recursive: true });
    await writeFile(join(threadDir, "window_001.jsonl"), "first window\n", "utf8");
    await writeFile(join(threadDir, "window_002.jsonl"), "second window\n", "utf8");
    const activePath = getActiveWindowPath(config, TEST_CWD, TEST_THREAD);
    await writeFile(activePath, "z".repeat(THREAD_CLOSE_MIN_ACTIVE_BYTES + 1), "utf8");

    const result = await archiveActiveWindowOnClose(config, TEST_CWD, TEST_THREAD);
    expect(result.archived).toBe(true);
    if (result.archived) {
      expect(result.windowIndex).toBe(3);
      expect(result.archivedPath).toContain("window_003.jsonl");
    }
  });

  it("returns below-threshold for active.jsonl one byte under the cutoff", async () => {
    // Inverse boundary: 2047 bytes is one short of the threshold,
    // should NOT archive. Together with the at-threshold test above
    // this pins the exact boundary.
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const threadDir = getThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    await mkdir(threadDir, { recursive: true });
    const activePath = getActiveWindowPath(config, TEST_CWD, TEST_THREAD);
    await writeFile(activePath, "y".repeat(THREAD_CLOSE_MIN_ACTIVE_BYTES - 1), "utf8");

    const result = await archiveActiveWindowOnClose(config, TEST_CWD, TEST_THREAD);
    expect(result.archived).toBe(false);
    if (!result.archived) {
      expect(result.reason).toBe("below-threshold");
      expect(result.currentBytes).toBe(THREAD_CLOSE_MIN_ACTIVE_BYTES - 1);
    }
  });
});
