/**
 * StopActiveSummaryHook tests.
 *
 * Stubs the OpenAI client to capture the actual Pro call shape rather
 * than hitting the network. The summary text returned by the stub is
 * what gets written to active.summary.md, so we can assert the
 * end-to-end pipeline without a live cloud.
 *
 * Coverage:
 *   1. No cwd → hook is a no-op (no client lookup, no Pro call)
 *   2. active.jsonl absent → no-op
 *   3. active.jsonl tiny → no-op
 *   4. active.jsonl >= threshold, no prior summary → fires once,
 *      writes active.summary.md with meta comment
 *   5. Prior summary exists, debounce blocks → no-op
 *   6. Prior summary exists, growth crossed threshold → fires
 *   7. Client lookup returns null → no-op (cloud not configured)
 *   8. Bus dispatch path: registering through HookBus + dispatchStop
 *      produces the same observable behavior as calling the handler
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_SUMMARY_FILENAME,
  __resetInFlightTrackerForTest,
  getActiveSummaryPath,
  writeActiveSummary,
} from "./ActiveSummary.ts";
import { makeHookBus } from "./HookBus.ts";
import {
  ensureThreadArchiveDir,
  getActiveWindowPath,
  makeRollingWindowConfig,
} from "./RollingWindowMemory.ts";
import { makeStopActiveSummaryHook } from "./StopActiveSummaryHook.ts";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aris-stop-active-summary-test-"));
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
const TEST_THREAD = "thread-stop-test";

/**
 * Build a minimal OpenAI-shaped stub that records the create()
 * payload and returns a canned summary. The hook + ActiveSummary
 * module only need `chat.completions.create` so we don't have to
 * model the rest of the SDK surface.
 */
function makeStubOpenAI(summaryText: string): {
  client: OpenAI;
  calls: Array<{ model: string; messages: unknown }>;
} {
  const calls: Array<{ model: string; messages: unknown }> = [];
  const create = async (params: { model: string; messages: unknown }) => {
    calls.push({ model: params.model, messages: params.messages });
    return {
      choices: [{ message: { content: summaryText, role: "assistant" } }],
    };
  };
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { client, calls };
}

/** Wait until the background generation finishes (or timeout). */
async function waitForSummaryFile(path: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await stat(path);
      return;
    } catch {
      // not yet written
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Summary file did not appear at ${path} within ${timeoutMs}ms`);
}

/** Wait a bit then assert the file is still absent. */
async function expectFileStaysAbsent(path: string, settleMs = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  let exists = true;
  try {
    await stat(path);
  } catch {
    exists = false;
  }
  expect(exists).toBe(false);
}

function makeActiveJsonl(turns: number, content: string): string {
  const lines: string[] = [];
  for (let i = 0; i < turns; i += 1) {
    lines.push(
      JSON.stringify({
        role: "user",
        content,
        timestamp: "2026-05-18T00:00:00.000Z",
        messageId: `m${i}u`,
        turnId: `t${i}`,
      }),
    );
    lines.push(
      JSON.stringify({
        role: "assistant",
        content,
        timestamp: "2026-05-18T00:00:01.000Z",
        messageId: `m${i}a`,
        turnId: `t${i}`,
      }),
    );
  }
  return lines.join("\n") + "\n";
}

describe("StopActiveSummaryHook — handler direct invocation", () => {
  it("is a no-op when ctx.cwd is undefined (no client lookup, no Pro call)", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const { client, calls } = makeStubOpenAI("## Topics\n- stub");
    const lookupCalled: number[] = [];
    const hook = makeStopActiveSummaryHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => {
        lookupCalled.push(1);
        return client;
      },
    });
    await hook.handler({
      event: "Stop",
      threadId: TEST_THREAD,
      cwd: undefined,
      turnIndex: 0,
    });
    expect(lookupCalled).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when active.jsonl doesn't exist", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    const { client, calls } = makeStubOpenAI("## Topics\n- stub");
    const hook = makeStopActiveSummaryHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => client,
    });
    await hook.handler({
      event: "Stop",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      turnIndex: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when active.jsonl is below threshold", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    await writeFile(
      getActiveWindowPath(config, TEST_CWD, TEST_THREAD),
      makeActiveJsonl(1, "small"),
      "utf8",
    );
    const { client, calls } = makeStubOpenAI("## Topics\n- stub");
    const hook = makeStopActiveSummaryHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => client,
    });
    await hook.handler({
      event: "Stop",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      turnIndex: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it("fires Pro call + writes active.summary.md when active.jsonl crosses threshold", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    // Write enough content to clear the 2KB threshold
    const big = makeActiveJsonl(30, "x".repeat(200));
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), big, "utf8");
    const { client, calls } = makeStubOpenAI(
      "## Topics\n- big conversation\n## Decisions made\n- decided X",
    );
    const hook = makeStopActiveSummaryHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => client,
    });
    await hook.handler({
      event: "Stop",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      turnIndex: 0,
    });

    // Wait for the background write
    const summaryPath = getActiveSummaryPath(config, TEST_CWD, TEST_THREAD);
    await waitForSummaryFile(summaryPath);

    // Stub got called exactly once with the V4-Pro model
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("deepseek-v4-pro");

    // File contains the meta comment + the stub's summary body
    const written = await readFile(summaryPath, "utf8");
    expect(written.startsWith("<!-- aris-active-summary-meta: ")).toBe(true);
    expect(written).toContain("big conversation");
    expect(written).toContain("decided X");
  });

  it("is a no-op when prior summary exists and active.jsonl hasn't grown enough", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    const big = makeActiveJsonl(30, "x".repeat(200));
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), big, "utf8");
    // Record a prior summary that matches the current size exactly
    const currentSize = big.length;
    await writeActiveSummary(
      getActiveSummaryPath(config, TEST_CWD, TEST_THREAD),
      "## Topics\n- prior",
      { sizeAtGeneration: currentSize, generatedAtIso: "2026-05-18T00:00:00.000Z" },
    );

    const { client, calls } = makeStubOpenAI("## Topics\n- new stub");
    const hook = makeStopActiveSummaryHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => client,
    });
    await hook.handler({
      event: "Stop",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      turnIndex: 1,
    });
    // No new Pro call
    expect(calls).toHaveLength(0);
    // File still contains the prior content
    const written = await readFile(getActiveSummaryPath(config, TEST_CWD, TEST_THREAD), "utf8");
    expect(written).toContain("- prior");
  });

  it("is a no-op when client lookup returns null (cloud not configured)", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    const big = makeActiveJsonl(30, "x".repeat(200));
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), big, "utf8");
    const hook = makeStopActiveSummaryHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => null,
    });
    await hook.handler({
      event: "Stop",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      turnIndex: 0,
    });
    // Summary file should not appear
    await expectFileStaysAbsent(getActiveSummaryPath(config, TEST_CWD, TEST_THREAD));
  });
});

describe("StopActiveSummaryHook — composed via HookBus", () => {
  it("bus.dispatchStop fires the hook and produces the summary file", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    const big = makeActiveJsonl(30, "x".repeat(200));
    await writeFile(getActiveWindowPath(config, TEST_CWD, TEST_THREAD), big, "utf8");
    const { client, calls } = makeStubOpenAI("## Topics\n- bus-routed summary");
    const bus = makeHookBus();
    bus.register(
      makeStopActiveSummaryHook({
        rollingWindowConfig: config,
        lookupOpenAIClient: async () => client,
      }),
    );
    await bus.dispatchStop({
      event: "Stop",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      turnIndex: 0,
    });
    const summaryPath = getActiveSummaryPath(config, TEST_CWD, TEST_THREAD);
    await waitForSummaryFile(summaryPath);
    expect(calls).toHaveLength(1);
    const written = await readFile(summaryPath, "utf8");
    expect(written).toContain("bus-routed summary");
  });

  it("summary file lives at the expected on-disk path (active.summary.md inside thread dir)", async () => {
    const home = await makeTempHome();
    const config = makeRollingWindowConfig(home);
    await ensureThreadArchiveDir(config, TEST_CWD, TEST_THREAD);
    // Real JSONL — readActiveWindowForSummary parses each line so an
    // unstructured byte-blob would get dropped and the generator
    // would error out with "no parseable messages".
    await writeFile(
      getActiveWindowPath(config, TEST_CWD, TEST_THREAD),
      makeActiveJsonl(30, "x".repeat(200)),
      "utf8",
    );
    const { client } = makeStubOpenAI("## Topics\n- located");
    const hook = makeStopActiveSummaryHook({
      rollingWindowConfig: config,
      lookupOpenAIClient: async () => client,
    });
    await hook.handler({
      event: "Stop",
      threadId: TEST_THREAD,
      cwd: TEST_CWD,
      turnIndex: 0,
    });
    const summaryPath = getActiveSummaryPath(config, TEST_CWD, TEST_THREAD);
    await waitForSummaryFile(summaryPath);
    expect(summaryPath.endsWith(`/${ACTIVE_SUMMARY_FILENAME}`)).toBe(true);
  });
});
