/**
 * SessionEndArchiveHook tests.
 *
 * Same stub OpenAI client pattern as the StopActiveSummaryHook tests
 * so we can assert what happens on a real session-end without hitting
 * the cloud. The destructive archive (Slice Y's
 * archiveActiveWindowOnClose) is the load-bearing piece; the rollover
 * summary call is verified at the stub-call level.
 *
 * Coverage:
 *   1. No cwd → no-op
 *   2. active.jsonl absent → no-op, no Pro call
 *   3. active.jsonl below threshold → no archive, no Pro call,
 *      active.summary.md (if present) NOT deleted
 *   4. active.jsonl over threshold → archive happens, Pro call fires,
 *      active.summary.md gets deleted
 *   5. Cloud config missing → archive STILL happens (filesystem
 *      operations don't depend on cloud), Pro call doesn't fire,
 *      active.summary.md still deleted (window summary will eventually
 *      take its place; we don't leave both around)
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVE_SUMMARY_MIN_BYTES,
  getActiveSummaryPath,
  writeActiveSummary,
} from "./ActiveSummary.ts";
import {
  ensureThreadArchiveDir,
  getActiveWindowPath,
  getThreadArchiveDir,
  makeRollingWindowConfig,
} from "./RollingWindowMemory.ts";
import { makeSessionEndArchiveHook } from "./SessionEndArchiveHook.ts";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aris-session-end-archive-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function makeStubOpenAI(summaryText: string): {
  client: OpenAI;
  calls: Array<{ model: string }>;
} {
  const calls: Array<{ model: string }> = [];
  const create = async (params: { model: string }) => {
    calls.push({ model: params.model });
    return {
      choices: [{ message: { content: summaryText, role: "assistant" } }],
    };
  };
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { client, calls };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForArchiveFile(path: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fileExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Archive file did not appear at ${path} within ${timeoutMs}ms`);
}

const TEST_CWD = "/Users/test/proj";
const TEST_THREAD = "thread-session-end-test";

describe("SessionEndArchiveHook", () => {
  it("is a no-op when ctx.cwd is undefined", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const { client, calls } = makeStubOpenAI("## Topics\n- stub");
    const hook = makeSessionEndArchiveHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => client,
    });
    await hook.handler({
      event: "SessionEnd",
      threadId: TEST_THREAD,
      cwd: undefined,
      reason: "user_closed",
    });
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when active.jsonl doesn't exist", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const { client, calls } = makeStubOpenAI("## Topics\n- stub");
    const hook = makeSessionEndArchiveHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => client,
    });
    await hook.handler({
      event: "SessionEnd",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      reason: "user_closed",
    });
    expect(calls).toHaveLength(0);
  });

  it("does not archive (and does not delete active.summary.md) when active.jsonl below threshold", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), "a".repeat(100), "utf8");
    // Pre-existing sidecar — should be preserved since archive doesn't fire
    await writeActiveSummary(
      getActiveSummaryPath(config, TEST_CWD, TEST_THREAD),
      "## Topics\n- legacy sidecar",
      { sizeAtGeneration: 50, generatedAtIso: "2026-05-18T00:00:00.000Z" },
    );

    const { client, calls } = makeStubOpenAI("## Topics\n- stub");
    const hook = makeSessionEndArchiveHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => client,
    });
    await hook.handler({
      event: "SessionEnd",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      reason: "user_closed",
    });
    expect(calls).toHaveLength(0);
    // active.jsonl stays put (below threshold == nothing was archived)
    expect(await fileExists(getActiveWindowPath(config, TEST_CWD, TEST_THREAD))).toBe(true);
    // Sidecar still there
    expect(await fileExists(getActiveSummaryPath(config, TEST_CWD, TEST_THREAD))).toBe(true);
  });

  it("archives, fires Pro rollover summary, and deletes active.summary.md when over threshold", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    const big = "z".repeat(ACTIVE_SUMMARY_MIN_BYTES + 500);
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), big, "utf8");
    // Pre-existing sidecar — should be deleted after archive
    await writeActiveSummary(
      getActiveSummaryPath(config, TEST_CWD, TEST_THREAD),
      "## Topics\n- about-to-be-superseded",
      { sizeAtGeneration: 50, generatedAtIso: "2026-05-18T00:00:00.000Z" },
    );

    const { client, calls } = makeStubOpenAI("## Topics\n- archived summary content");
    const hook = makeSessionEndArchiveHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => client,
    });
    await hook.handler({
      event: "SessionEnd",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      reason: "user_closed",
    });

    const archivedPath = join(
      getThreadArchiveDir(config, TEST_CWD, TEST_THREAD),
      "window_001.jsonl",
    );
    await waitForArchiveFile(archivedPath);

    // active.jsonl renamed away
    expect(await fileExists(getActiveWindowPath(config, TEST_CWD, TEST_THREAD))).toBe(false);
    // active.summary.md deleted
    expect(await fileExists(getActiveSummaryPath(config, TEST_CWD, TEST_THREAD))).toBe(false);

    // Wait for the rollover summary file to appear
    const windowSummaryPath = join(
      getThreadArchiveDir(config, TEST_CWD, TEST_THREAD),
      "window_001.summary.md",
    );
    const summaryStart = Date.now();
    while (Date.now() - summaryStart < 1000) {
      if (await fileExists(windowSummaryPath)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const summary = await readFile(windowSummaryPath, "utf8");
    expect(summary).toContain("archived summary content");

    // Pro got called once for the rollover
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("deepseek-v4-pro");
  });

  it("still archives + deletes sidecar when cloud config is missing (rollover summary just doesn't fire)", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    const big = "z".repeat(ACTIVE_SUMMARY_MIN_BYTES + 500);
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), big, "utf8");
    await writeActiveSummary(
      getActiveSummaryPath(config, TEST_CWD, TEST_THREAD),
      "## Topics\n- old sidecar",
      { sizeAtGeneration: 50, generatedAtIso: "2026-05-18T00:00:00.000Z" },
    );

    const hook = makeSessionEndArchiveHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => null,
    });
    await hook.handler({
      event: "SessionEnd",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      reason: "shutdown",
    });

    // active.jsonl moved; active.summary.md gone; window_001.jsonl present
    const archivedPath = join(
      getThreadArchiveDir(config, TEST_CWD, TEST_THREAD),
      "window_001.jsonl",
    );
    expect(await fileExists(archivedPath)).toBe(true);
    expect(await fileExists(getActiveWindowPath(config, TEST_CWD, TEST_THREAD))).toBe(false);
    expect(await fileExists(getActiveSummaryPath(config, TEST_CWD, TEST_THREAD))).toBe(false);
    // No window summary was written (no client)
    const windowSummaryPath = join(
      getThreadArchiveDir(config, TEST_CWD, TEST_THREAD),
      "window_001.summary.md",
    );
    // Settle a beat to be sure no async background write lands
    await new Promise((r) => setTimeout(r, 50));
    expect(await fileExists(windowSummaryPath)).toBe(false);
  });
});
