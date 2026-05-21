/**
 * Slice C contract-schema tests.
 *
 * Pins the H8 + H9 fixes at the schema decoder level so a future
 * refactor that loosens either default trips here first, before the
 * weaker behavior ships to the wire.
 *
 *   - H8 (DEFAULT_RUNTIME_MODE): the safe default for any schema that
 *     uses `withDecodingDefault(DEFAULT_RUNTIME_MODE)` must be the
 *     MOST-restrictive mode (`approval-required`). Pre-Slice-C it was
 *     `"full-access"` — silent privilege escalation on any caller that
 *     omitted the field.
 *
 *   - H9 (PROJECT_WRITE_FILE_MAX_CHARS): `ProjectWriteFileInput.contents`
 *     must reject payloads beyond the cap to prevent memory/disk
 *     exhaustion via multi-GB strings.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  DEFAULT_RUNTIME_MODE,
  PROJECT_WRITE_FILE_MAX_CHARS,
  ProjectWriteFileInput,
  ThreadCreatedPayload,
  ThreadTurnStartCommand,
  ThreadTurnStartRequestedPayload,
} from "@t3tools/contracts";

describe("Slice C — H8: DEFAULT_RUNTIME_MODE is the safe default", () => {
  it("the constant value is 'approval-required' (most-restrictive mode)", () => {
    // Direct value pin. If a future refactor sets this back to
    // `"full-access"` or to any less-restrictive mode, the audit's
    // H8 finding regresses. Trip immediately.
    expect(DEFAULT_RUNTIME_MODE).toBe("approval-required");
  });

  it("ThreadTurnStartCommand decodes omitted runtimeMode as approval-required", () => {
    // The client wire schema. Pre-Slice-C, a client that omitted
    // runtimeMode would silently get `full-access`. Now it gets the
    // safe default. Callers that want elevated access must set the
    // field explicitly.
    const decode = Schema.decodeUnknownSync(ThreadTurnStartCommand);
    const result = decode({
      type: "thread.turn.start",
      commandId: "cmd_test_approval_default",
      threadId: "thread_test",
      message: {
        messageId: "msg_test",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-05-16T15:00:00.000Z",
    });
    expect(result.runtimeMode).toBe("approval-required");
  });

  it("ThreadTurnStartCommand preserves an explicit runtimeMode override", () => {
    // Explicit values must NOT be overwritten by the default. The
    // change is purely "default for omission"; existing callers that
    // set the field explicitly are unaffected.
    const decode = Schema.decodeUnknownSync(ThreadTurnStartCommand);
    const result = decode({
      type: "thread.turn.start",
      commandId: "cmd_test_explicit_full",
      threadId: "thread_test",
      message: {
        messageId: "msg_test",
        role: "user",
        text: "hello",
        attachments: [],
      },
      runtimeMode: "full-access",
      createdAt: "2026-05-16T15:00:00.000Z",
    });
    expect(result.runtimeMode).toBe("full-access");
  });

  it("ThreadCreatedPayload decodes omitted runtimeMode as approval-required", () => {
    // Server-emitted payload — same defense as the command. If the
    // server ever omits runtimeMode when synthesizing this event,
    // downstream consumers see the safe default rather than full access.
    const decode = Schema.decodeUnknownSync(ThreadCreatedPayload);
    const result = decode({
      threadId: "thread_test",
      projectId: "project_test",
      title: "Test thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      branch: null,
      worktreePath: null,
      createdAt: "2026-05-16T15:00:00.000Z",
      updatedAt: "2026-05-16T15:00:00.000Z",
    });
    expect(result.runtimeMode).toBe("approval-required");
  });

  it("ThreadTurnStartRequestedPayload decodes omitted runtimeMode as approval-required", () => {
    const decode = Schema.decodeUnknownSync(ThreadTurnStartRequestedPayload);
    const result = decode({
      threadId: "thread_test",
      messageId: "msg_test",
      createdAt: "2026-05-16T15:00:00.000Z",
    });
    expect(result.runtimeMode).toBe("approval-required");
  });
});

describe("Slice C — H9: ProjectWriteFileInput caps content size", () => {
  const decode = Schema.decodeUnknownSync(ProjectWriteFileInput);

  it("the cap is 10_000_000 chars (~20 MB UTF-16)", () => {
    // Direct value pin. 5× PROJECT_READ_FILE_MAX_CHARS — generous
    // enough for legitimate large files / paste operations, narrow
    // enough to reject the multi-GB DoS payload class.
    expect(PROJECT_WRITE_FILE_MAX_CHARS).toBe(10_000_000);
  });

  it("accepts a write payload at the cap exactly", () => {
    // Boundary check — content of length === cap is accepted. The
    // first byte past the cap is rejected (next test). If the
    // boundary slides, both tests trip and the diagnosis is clear.
    const atCap = "x".repeat(PROJECT_WRITE_FILE_MAX_CHARS);
    const result = decode({
      cwd: "/tmp/test",
      relativePath: "test.txt",
      contents: atCap,
    });
    expect(result.contents.length).toBe(PROJECT_WRITE_FILE_MAX_CHARS);
  });

  it("rejects a write payload one byte past the cap", () => {
    // The canonical DoS shape — a few bytes past the cap. We don't
    // simulate the multi-GB payload directly (would OOM the test
    // runner), but the boundary is what matters: if cap+1 is
    // rejected, cap+1B is also rejected by the same schema check.
    const overCap = "x".repeat(PROJECT_WRITE_FILE_MAX_CHARS + 1);
    expect(() =>
      decode({
        cwd: "/tmp/test",
        relativePath: "test.txt",
        contents: overCap,
      }),
    ).toThrow();
  });

  it("accepts a small legitimate write payload (regression check)", () => {
    // Sanity — the cap doesn't accidentally over-narrow such that
    // normal-size writes fail.
    const small = "console.log('hello, world');\n";
    const result = decode({
      cwd: "/tmp/test",
      relativePath: "test.ts",
      contents: small,
    });
    expect(result.contents).toBe(small);
  });
});
