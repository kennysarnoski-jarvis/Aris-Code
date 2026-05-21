/**
 * DeepSeekToolCallLog tests.
 *
 * The whole point of Slice A's H12 fix is that args content CANNOT
 * leak into stderr because the formatters don't accept it. These
 * tests pin that invariant in place with both shape assertions AND
 * content-redaction checks against secret-shaped fixtures. If a
 * future refactor adds an `args` field back to either formatter,
 * these tests trip immediately.
 */
import { describe, expect, it } from "vitest";

import { formatRunnerToolCallLog, formatWorkerToolCallLog } from "./DeepSeekToolCallLog.ts";

// Secret-shaped fixture used across redaction assertions. If any of
// these substrings show up in the formatter output, the test fails —
// proving the formatter never had a chance to see the args content
// in the first place (the signature doesn't accept it).
const FAKE_API_KEY = "sk-test-1234567890abcdef";
const FAKE_BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.fake.token";
const FAKE_ENV_LINE = `OPENAI_API_KEY=${FAKE_API_KEY}`;

describe("formatWorkerToolCallLog (Slice A — H12)", () => {
  it("produces the expected shape with tag, tool name, callId, argsBytes", () => {
    const output = formatWorkerToolCallLog({
      tag: "[worker 'audit-foo']",
      toolName: "read_file",
      callId: "call_42",
      argsBytes: 512,
    });
    expect(output).toBe(
      "[worker 'audit-foo'] tool_call: name=read_file callId=call_42 argsBytes=512",
    );
  });

  it("includes argsBytes for shape diagnostics", () => {
    // The byte count is the load-bearing diagnostic — it lets a
    // future operator correlate "the model emitted a 5MB args blob"
    // with a context-window spike without ever seeing the content.
    const output = formatWorkerToolCallLog({
      tag: "[worker 'test']",
      toolName: "write_file",
      callId: "call_1",
      argsBytes: 5_242_880,
    });
    expect(output).toContain("argsBytes=5242880");
  });

  it("does NOT include the literal substring 'args=' (only argsBytes=)", () => {
    // Pre-Slice-A the log line ended with `args=<JSON.stringify(...)>`.
    // The redacted shape drops the bare `args=` substring entirely.
    // This is the regression check that catches a future refactor
    // that accidentally re-adds the field.
    const output = formatWorkerToolCallLog({
      tag: "[worker 't']",
      toolName: "bash",
      callId: "call_x",
      argsBytes: 99,
    });
    expect(output).not.toMatch(/\bargs=/);
    // argsBytes= is fine (different field) — explicitly assert that
    // to make the negative-match intent obvious to a future reader.
    expect(output).toContain("argsBytes=99");
  });

  it("has no field that accepts args content (compile-time check via structural typing)", () => {
    // This test verifies the type signature blocks args content
    // structurally. The cast forces TypeScript to admit there's no
    // `args` field on the input type; if a future change adds one,
    // this test still compiles but the absence assertion fails.
    const input = {
      tag: "[worker 'r']",
      toolName: "grep",
      callId: "call_a",
      argsBytes: 10,
    };
    // Attempt to sneak args into the input via an extra-fields object.
    // TypeScript's excess-property check would reject this at compile
    // time, so we have to cast — but the formatter ignores unknown
    // fields and produces a clean output regardless.
    const extraFieldsAttempt = {
      ...input,
      args: FAKE_ENV_LINE,
      argsPreview: FAKE_API_KEY,
    } as unknown as Parameters<typeof formatWorkerToolCallLog>[0];
    const output = formatWorkerToolCallLog(extraFieldsAttempt);
    expect(output).not.toContain(FAKE_API_KEY);
    expect(output).not.toContain(FAKE_ENV_LINE);
    expect(output).not.toContain(FAKE_BEARER);
  });
});

describe("formatRunnerToolCallLog (Slice A — H12)", () => {
  it("produces the success-branch shape when parseError is omitted", () => {
    const output = formatRunnerToolCallLog({
      toolName: "edit_file",
      callId: "call_99",
      argsBytes: 1024,
    });
    expect(output).toBe(
      "[DeepSeekAgentRunner] tool_call_item: name=edit_file callId=call_99 argsBytes=1024",
    );
  });

  it("produces the success-branch shape when parseError is null", () => {
    const output = formatRunnerToolCallLog({
      toolName: "read_file",
      callId: "call_1",
      argsBytes: 256,
      parseError: null,
    });
    // null parseError should produce identical output to omitting it.
    expect(output).toBe(
      "[DeepSeekAgentRunner] tool_call_item: name=read_file callId=call_1 argsBytes=256",
    );
  });

  it("produces the parse-failure-branch shape when parseError is a non-empty string", () => {
    const output = formatRunnerToolCallLog({
      toolName: "bash",
      callId: "call_7",
      argsBytes: 80,
      parseError: "parsed value is not an object: number",
    });
    expect(output).toBe(
      "[DeepSeekAgentRunner] tool_call_item: name=bash callId=call_7 argsBytes=80 " +
        "JSON_PARSE_FAILED=parsed value is not an object: number",
    );
  });

  it("treats an empty-string parseError as the success branch (defensive)", () => {
    // Defensive normalization — an empty string is functionally
    // equivalent to "no parse error". Avoids emitting a useless
    // `JSON_PARSE_FAILED=` tail.
    const output = formatRunnerToolCallLog({
      toolName: "glob",
      callId: "call_0",
      argsBytes: 32,
      parseError: "",
    });
    expect(output).not.toContain("JSON_PARSE_FAILED");
    expect(output).toBe(
      "[DeepSeekAgentRunner] tool_call_item: name=glob callId=call_0 argsBytes=32",
    );
  });

  it("never emits literal `args=` content even in the parse-failure branch", () => {
    // Pre-Slice-A the parse-failure branch leaked `argsPreview=...`.
    // The redacted shape replaces it with the error message only.
    const output = formatRunnerToolCallLog({
      toolName: "write_file",
      callId: "call_3",
      argsBytes: 4096,
      parseError: "unexpected EOF",
    });
    expect(output).not.toMatch(/\bargs=/);
    expect(output).not.toMatch(/\bargsPreview=/);
    expect(output).toContain("JSON_PARSE_FAILED=unexpected EOF");
  });

  it("does not leak secret-shaped content even when extra fields are forced via cast", () => {
    // Same structural-typing argument as the worker formatter — the
    // input type has no `args` / `argsPreview` / `argsRaw` fields, so
    // the formatter never reads them. Cast-forcing extras still
    // produces a clean output.
    const extras = {
      toolName: "edit_file",
      callId: "call_x",
      argsBytes: 50,
      args: FAKE_ENV_LINE,
      argsPreview: FAKE_API_KEY,
      argsRaw: FAKE_BEARER,
    } as unknown as Parameters<typeof formatRunnerToolCallLog>[0];
    const output = formatRunnerToolCallLog(extras);
    expect(output).not.toContain(FAKE_API_KEY);
    expect(output).not.toContain(FAKE_ENV_LINE);
    expect(output).not.toContain(FAKE_BEARER);
  });

  it("the parseError message stays in the log (server-generated, no user data)", () => {
    // Sanity check that the redaction did NOT strip the legitimate
    // diagnostic. Parse-error messages come from JSON.parse failures
    // and the code's own validation logic — both server-generated,
    // neither carries args content from the model.
    const errorMessage = "Unexpected token } at position 42";
    const output = formatRunnerToolCallLog({
      toolName: "bash",
      callId: "call_pe",
      argsBytes: 100,
      parseError: errorMessage,
    });
    expect(output).toContain(`JSON_PARSE_FAILED=${errorMessage}`);
  });
});
