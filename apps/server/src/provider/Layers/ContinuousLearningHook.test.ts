/**
 * ContinuousLearningHook tests — observation write path, secret scrub,
 * file rotation, Stop marker.
 *
 * Strategy: point the hook at a tmpdir via the `observationsPath`
 * option, invoke its handler with a synthetic context, assert on the
 * JSONL on disk. Pure helpers (`scrubSecrets`, `stringifyAndTruncate`)
 * stay disk-free.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  makeContinuousLearningPostToolUseHook,
  makeContinuousLearningStopHook,
  scrubSecrets,
  stringifyAndTruncate,
} from "./ContinuousLearningHook.ts";

// ---------------------------------------------------------------------------
// scrubSecrets — pure regex scrubber
// ---------------------------------------------------------------------------

describe("scrubSecrets", () => {
  it("redacts api_key=value patterns", () => {
    const input = "Using api_key=sk-1234567890abcdef in the request";
    const scrubbed = scrubSecrets(input);
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).not.toContain("sk-1234567890abcdef");
    expect(scrubbed).toContain("api_key");
  });

  it("redacts token: value patterns", () => {
    const input = 'token: "abcDEF12345678"';
    const scrubbed = scrubSecrets(input);
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).not.toContain("abcDEF12345678");
  });

  it("redacts Authorization Bearer schemes", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload";
    const scrubbed = scrubSecrets(input);
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).toContain("Bearer ");
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload");
  });

  it("leaves non-secret content alone", () => {
    const input = "Just a normal sentence with no credentials.";
    expect(scrubSecrets(input)).toBe(input);
  });

  it("redacts password=value", () => {
    const input = "password=hunter2isnotsecure";
    const scrubbed = scrubSecrets(input);
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).not.toContain("hunter2isnotsecure");
  });

  it("redacts multiple secrets in the same string", () => {
    const input = "api_key=sk-1234567890 and token=abcdefgh12345";
    const scrubbed = scrubSecrets(input);
    expect(scrubbed).not.toContain("sk-1234567890");
    expect(scrubbed).not.toContain("abcdefgh12345");
    const redactedCount = (scrubbed.match(/\[REDACTED\]/g) ?? []).length;
    expect(redactedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// stringifyAndTruncate — pure serialization
// ---------------------------------------------------------------------------

describe("stringifyAndTruncate", () => {
  it("returns the empty string for undefined", () => {
    expect(stringifyAndTruncate(undefined)).toBe("");
  });

  it("returns strings verbatim up to the limit", () => {
    expect(stringifyAndTruncate("hello")).toBe("hello");
  });

  it("truncates strings beyond the limit", () => {
    expect(stringifyAndTruncate("a".repeat(100), 10)).toBe("aaaaaaaaaa");
  });

  it("JSON-stringifies objects", () => {
    expect(stringifyAndTruncate({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  it("truncates JSON-stringified objects", () => {
    const obj = { a: "x".repeat(100) };
    const result = stringifyAndTruncate(obj, 20);
    expect(result.length).toBe(20);
  });

  it("handles values that can't be JSON-stringified", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    // Should not throw — falls back to String() representation.
    expect(() => stringifyAndTruncate(circular)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PostToolUse hook — disk write
// ---------------------------------------------------------------------------

describe("makeContinuousLearningPostToolUseHook", () => {
  let tmpRoot: string;
  let logPath: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aris-cl-"));
    logPath = path.join(tmpRoot, "observations.jsonl");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("appends a tool_complete observation on PostToolUse", async () => {
    const hook = makeContinuousLearningPostToolUseHook({
      observationsPath: () => logPath,
    });
    await hook.handler({
      event: "PostToolUse",
      threadId: "thread-abc",
      cwd: "/work/project",
      toolName: "read_file",
      args: { path: "src/foo.ts" },
      result: "file contents here",
    });
    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const observation = JSON.parse(lines[0]!);
    expect(observation.event).toBe("tool_complete");
    expect(observation.tool).toBe("read_file");
    expect(observation.session).toBe("thread-abc");
    expect(observation.input).toBe('{"path":"src/foo.ts"}');
    expect(observation.output).toBe("file contents here");
    expect(observation.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("scrubs secrets from input and output before persisting", async () => {
    const hook = makeContinuousLearningPostToolUseHook({
      observationsPath: () => logPath,
    });
    await hook.handler({
      event: "PostToolUse",
      threadId: "thread-1",
      cwd: undefined,
      toolName: "bash",
      args: { command: "curl -H 'Authorization: Bearer eyJabcdef12345678'" },
      result: "api_key=sk-supersecret9876543210",
    });
    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("eyJabcdef12345678");
    expect(content).not.toContain("sk-supersecret9876543210");
  });

  it("truncates oversized input + output to the configured limit", async () => {
    const hook = makeContinuousLearningPostToolUseHook({
      observationsPath: () => logPath,
      truncateLimit: 30,
    });
    await hook.handler({
      event: "PostToolUse",
      threadId: "thread-1",
      cwd: undefined,
      toolName: "echo",
      args: { text: "x".repeat(1000) },
      result: "y".repeat(1000),
    });
    const content = await fs.readFile(logPath, "utf-8");
    const observation = JSON.parse(content.trim());
    expect(observation.input.length).toBeLessThanOrEqual(30);
    expect(observation.output.length).toBeLessThanOrEqual(30);
  });

  it("appends multiple observations as separate JSONL lines", async () => {
    const hook = makeContinuousLearningPostToolUseHook({
      observationsPath: () => logPath,
    });
    for (let i = 0; i < 3; i++) {
      await hook.handler({
        event: "PostToolUse",
        threadId: "t1",
        cwd: undefined,
        toolName: `tool-${i}`,
        args: { i },
        result: `r-${i}`,
      });
    }
    const lines = (await fs.readFile(logPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    const tools = lines.map((l) => JSON.parse(l).tool);
    expect(tools).toEqual(["tool-0", "tool-1", "tool-2"]);
  });

  it("creates the parent directory when the path is nested", async () => {
    const nestedPath = path.join(tmpRoot, "deeply", "nested", "observations.jsonl");
    const hook = makeContinuousLearningPostToolUseHook({
      observationsPath: () => nestedPath,
    });
    await hook.handler({
      event: "PostToolUse",
      threadId: "t1",
      cwd: undefined,
      toolName: "noop",
      args: {},
      result: "ok",
    });
    const exists = await fs.stat(nestedPath).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(true);
  });

  it("rotates the file into observations.archive/ at the size threshold", async () => {
    const hook = makeContinuousLearningPostToolUseHook({
      observationsPath: () => logPath,
      maxFileSizeBytes: 100, // trip on the first write of any reasonable observation
    });
    // First write: file is empty so no rotation, but content goes in.
    await hook.handler({
      event: "PostToolUse",
      threadId: "t1",
      cwd: undefined,
      toolName: "filler",
      args: { x: "a".repeat(200) },
      result: "ok",
    });
    // Second write should rotate before appending.
    await hook.handler({
      event: "PostToolUse",
      threadId: "t1",
      cwd: undefined,
      toolName: "after-rotate",
      args: {},
      result: "ok",
    });
    const archiveDir = path.join(tmpRoot, "observations.archive");
    const archived = await fs.readdir(archiveDir);
    expect(archived.length).toBeGreaterThanOrEqual(1);
    expect(archived[0]).toMatch(/^observations-/);
    // The active file now only contains the after-rotate observation.
    const active = (await fs.readFile(logPath, "utf-8")).trim().split("\n");
    expect(active).toHaveLength(1);
    expect(JSON.parse(active[0]!).tool).toBe("after-rotate");
  });

  it("swallows I/O errors so observation never blocks the model", async () => {
    // Point the hook at a path under a non-existent device (read-only
    // location) via a path that the test environment can't write to.
    // Simplest: make the parent directory unwritable.
    const hook = makeContinuousLearningPostToolUseHook({
      // observationsPath returns an absurd path that mkdir will fail on
      // (illegal chars on most platforms). The handler should still
      // resolve without throwing.
      observationsPath: () => "/\0invalid/observations.jsonl",
    });
    await expect(
      hook.handler({
        event: "PostToolUse",
        threadId: "t1",
        cwd: undefined,
        toolName: "noop",
        args: {},
        result: "ok",
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stop hook — turn-boundary marker
// ---------------------------------------------------------------------------

describe("makeContinuousLearningStopHook", () => {
  let tmpRoot: string;
  let logPath: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aris-cl-"));
    logPath = path.join(tmpRoot, "observations.jsonl");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes a stop marker carrying the turn index", async () => {
    const hook = makeContinuousLearningStopHook({
      observationsPath: () => logPath,
    });
    await hook.handler({
      event: "Stop",
      threadId: "thread-abc",
      cwd: "/work/project",
      turnIndex: 7,
    });
    const content = await fs.readFile(logPath, "utf-8");
    const marker = JSON.parse(content.trim());
    expect(marker.event).toBe("stop");
    expect(marker.session).toBe("thread-abc");
    expect(marker.turn_index).toBe(7);
    expect(marker.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("appends after existing observations rather than overwriting", async () => {
    // Pre-seed the file with an observation line.
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, '{"event":"tool_complete","tool":"foo"}\n');

    const hook = makeContinuousLearningStopHook({
      observationsPath: () => logPath,
    });
    await hook.handler({
      event: "Stop",
      threadId: "t1",
      cwd: undefined,
      turnIndex: 0,
    });
    const lines = (await fs.readFile(logPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).event).toBe("tool_complete");
    expect(JSON.parse(lines[1]!).event).toBe("stop");
  });

  it("returns proper hook spec metadata", () => {
    const hook = makeContinuousLearningStopHook();
    expect(hook.event).toBe("Stop");
    expect(hook.name).toBe("continuous-learning-stop");
    expect(hook.priority).toBe(200);
  });
});
