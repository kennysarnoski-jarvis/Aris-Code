/**
 * ActiveSummary tests — exercise the storage layer and the
 * debounce/should-generate logic. Pro-call paths are not invoked
 * here (no mocking the OpenAI client); those land in the hook test
 * file via a stub client. This file pins:
 *
 *   1. Path resolution mirrors active.jsonl's location
 *   2. writeActiveSummary atomically prepends the meta comment
 *   3. readActiveSummary parses meta + body correctly, returns null
 *      when file absent
 *   4. parseActiveSummaryMeta handles legacy / malformed cases
 *   5. deleteActiveSummary is idempotent (no error if absent)
 *   6. shouldGenerateActiveSummary: no-active-file / below-threshold
 *      / first-time-generate / growth-debounce / legacy-no-meta
 *   7. In-flight tracker primitives behave (peek + reset for tests)
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_SUMMARY_FILENAME,
  ACTIVE_SUMMARY_MIN_BYTES,
  ACTIVE_SUMMARY_RESUMMARIZE_BYTES,
  __getInFlightSizeForTest,
  __resetInFlightTrackerForTest,
  deleteActiveSummary,
  getActiveSummaryPath,
  parseActiveSummaryMeta,
  readActiveSummary,
  shouldGenerateActiveSummary,
  writeActiveSummary,
} from "./ActiveSummary.ts";
import {
  ensureThreadArchiveDir,
  getActiveWindowPath,
  getThreadArchiveDir,
  makeRollingWindowConfig,
} from "./RollingWindowMemory.ts";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aris-active-summary-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

beforeEach(() => {
  __resetInFlightTrackerForTest();
});

const TEST_CWD = "/Users/test/proj";
const TEST_THREAD = "active-summary-test";

describe("ActiveSummary — paths", () => {
  it("active summary path lives next to active.jsonl in the same thread dir", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const summaryPath = getActiveSummaryPath(config, TEST_CWD, TEST_THREAD);
    const activePath = getActiveWindowPath(config, TEST_CWD, TEST_THREAD);
    const threadDir = getThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    expect(summaryPath).toBe(join(threadDir, ACTIVE_SUMMARY_FILENAME));
    // Sanity: summary + active.jsonl share the same parent directory
    expect(summaryPath.startsWith(threadDir + "/")).toBe(true);
    expect(activePath.startsWith(threadDir + "/")).toBe(true);
  });
});

describe("ActiveSummary — meta parsing", () => {
  it("parses a well-formed meta comment", () => {
    const text =
      '<!-- aris-active-summary-meta: {"sizeAtGeneration":4096,"generatedAtIso":"2026-05-18T12:00:00.000Z"} -->\n## Topics\n- stuff\n';
    const meta = parseActiveSummaryMeta(text);
    expect(meta).not.toBeNull();
    expect(meta?.sizeAtGeneration).toBe(4096);
    expect(meta?.generatedAtIso).toBe("2026-05-18T12:00:00.000Z");
  });

  it("returns null when the file has no meta comment (legacy)", () => {
    const text = "## Topics\n- some content\n";
    expect(parseActiveSummaryMeta(text)).toBeNull();
  });

  it("returns null when meta JSON is malformed", () => {
    const text = "<!-- aris-active-summary-meta: {not-json} -->\n## Topics\n";
    expect(parseActiveSummaryMeta(text)).toBeNull();
  });

  it("returns null when meta lacks required fields", () => {
    const text = '<!-- aris-active-summary-meta: {"sizeAtGeneration":4096} -->\n## Topics\n';
    expect(parseActiveSummaryMeta(text)).toBeNull();
  });

  it("handles empty file (no newline)", () => {
    expect(parseActiveSummaryMeta("")).toBeNull();
  });
});

describe("ActiveSummary — write + read roundtrip", () => {
  it("writeActiveSummary prepends meta comment and round-trips via readActiveSummary", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    const path = getActiveSummaryPath(config, TEST_CWD, TEST_THREAD);
    await writeActiveSummary(path, "## Topics\n- ran some tests", {
      sizeAtGeneration: 8192,
      generatedAtIso: "2026-05-18T01:23:45.000Z",
    });

    // File starts with meta comment
    const raw = await readFile(path, "utf8");
    expect(raw.startsWith("<!-- aris-active-summary-meta: ")).toBe(true);
    expect(raw).toContain('"sizeAtGeneration":8192');
    expect(raw).toContain('"generatedAtIso":"2026-05-18T01:23:45.000Z"');
    expect(raw).toContain("## Topics\n- ran some tests");

    // Round-trip via reader
    const round = await readActiveSummary(config, TEST_CWD, TEST_THREAD);
    expect(round).not.toBeNull();
    expect(round?.meta?.sizeAtGeneration).toBe(8192);
    expect(round?.meta?.generatedAtIso).toBe("2026-05-18T01:23:45.000Z");
    expect(round?.text).toContain("## Topics\n- ran some tests");
  });

  it("readActiveSummary returns null when file absent", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const result = await readActiveSummary(config, TEST_CWD, TEST_THREAD);
    expect(result).toBeNull();
  });

  it("readActiveSummary returns text + null meta for legacy files without meta comment", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    const path = getActiveSummaryPath(config, TEST_CWD, TEST_THREAD);
    await writeFile(path, "## Topics\n- legacy content\n", "utf8");
    const result = await readActiveSummary(config, TEST_CWD, TEST_THREAD);
    expect(result).not.toBeNull();
    expect(result?.text).toContain("legacy content");
    expect(result?.meta).toBeNull();
  });
});

describe("ActiveSummary — delete", () => {
  it("deleteActiveSummary removes the file", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    const path = getActiveSummaryPath(config, TEST_CWD, TEST_THREAD);
    await writeActiveSummary(path, "## Topics\n- x", {
      sizeAtGeneration: 100,
      generatedAtIso: "2026-05-18T00:00:00.000Z",
    });
    await deleteActiveSummary(config, TEST_CWD, TEST_THREAD);
    let exists = true;
    try {
      await stat(path);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("deleteActiveSummary is a no-op when the file is absent", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    // Should not throw
    await deleteActiveSummary(config, TEST_CWD, TEST_THREAD);
  });
});

describe("ActiveSummary — shouldGenerateActiveSummary", () => {
  it("returns no-active-file when active.jsonl doesn't exist", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const result = await shouldGenerateActiveSummary(config, TEST_CWD, TEST_THREAD);
    expect(result.shouldGenerate).toBe(false);
    if (!result.shouldGenerate) {
      expect(result.reason).toBe("no-active-file");
    }
  });

  it("returns below-threshold when active.jsonl is tiny", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), "a".repeat(100), "utf8");
    const result = await shouldGenerateActiveSummary(config, TEST_CWD, TEST_THREAD);
    expect(result.shouldGenerate).toBe(false);
    if (!result.shouldGenerate) {
      expect(result.reason).toBe("below-threshold");
    }
  });

  it("returns shouldGenerate:true when active.jsonl crosses the threshold and no summary exists", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    await writeFile(
      getActiveWindowPath(config, TEST_CWD, TEST_THREAD),
      "x".repeat(ACTIVE_SUMMARY_MIN_BYTES),
      "utf8",
    );
    const result = await shouldGenerateActiveSummary(config, TEST_CWD, TEST_THREAD);
    expect(result.shouldGenerate).toBe(true);
    if (result.shouldGenerate) {
      expect(result.currentBytes).toBe(ACTIVE_SUMMARY_MIN_BYTES);
    }
  });

  it("returns no-significant-growth when summary exists and active.jsonl hasn't grown enough", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    // Active.jsonl at 4096 bytes
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), "x".repeat(4096), "utf8");
    // Summary recorded at sizeAtGeneration=4096, only 0 bytes of growth
    await writeActiveSummary(
      getActiveSummaryPath(config, TEST_CWD, TEST_THREAD),
      "## Topics\n- prior",
      { sizeAtGeneration: 4096, generatedAtIso: "2026-05-18T00:00:00.000Z" },
    );
    const result = await shouldGenerateActiveSummary(config, TEST_CWD, TEST_THREAD);
    expect(result.shouldGenerate).toBe(false);
    if (!result.shouldGenerate) {
      expect(result.reason).toBe("no-significant-growth");
    }
  });

  it("returns shouldGenerate:true when active.jsonl has grown by >= ACTIVE_SUMMARY_RESUMMARIZE_BYTES since last summary", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    // Active.jsonl at 8192 bytes
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), "x".repeat(8192), "utf8");
    // Summary recorded at sizeAtGeneration=4096 — grew by 4096 (>= 2048)
    await writeActiveSummary(
      getActiveSummaryPath(config, TEST_CWD, TEST_THREAD),
      "## Topics\n- prior",
      { sizeAtGeneration: 4096, generatedAtIso: "2026-05-18T00:00:00.000Z" },
    );
    const result = await shouldGenerateActiveSummary(config, TEST_CWD, TEST_THREAD);
    expect(result.shouldGenerate).toBe(true);
    if (result.shouldGenerate) {
      expect(result.currentBytes).toBe(8192);
    }
  });

  it("returns shouldGenerate:true for legacy summary file without meta (one-time upgrade)", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), "x".repeat(4096), "utf8");
    // Pre-meta file: no comment line
    await writeFile(
      getActiveSummaryPath(config, TEST_CWD, TEST_THREAD),
      "## Topics\n- legacy without meta\n",
      "utf8",
    );
    const result = await shouldGenerateActiveSummary(config, TEST_CWD, TEST_THREAD);
    expect(result.shouldGenerate).toBe(true);
  });

  it("debounce threshold is exactly ACTIVE_SUMMARY_RESUMMARIZE_BYTES (inclusive)", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    const baseline = 4096;
    // Grew by exactly the resummarize threshold → should regenerate
    await writeFile(
      getActiveWindowPath(config, TEST_CWD, TEST_THREAD),
      "x".repeat(baseline + ACTIVE_SUMMARY_RESUMMARIZE_BYTES),
      "utf8",
    );
    await writeActiveSummary(
      getActiveSummaryPath(config, TEST_CWD, TEST_THREAD),
      "## Topics\n- prior",
      { sizeAtGeneration: baseline, generatedAtIso: "2026-05-18T00:00:00.000Z" },
    );
    const result = await shouldGenerateActiveSummary(config, TEST_CWD, TEST_THREAD);
    expect(result.shouldGenerate).toBe(true);
  });
});

describe("ActiveSummary — in-flight tracker primitives", () => {
  it("starts empty and __reset clears it", () => {
    expect(__getInFlightSizeForTest()).toBe(0);
    __resetInFlightTrackerForTest();
    expect(__getInFlightSizeForTest()).toBe(0);
  });
});
