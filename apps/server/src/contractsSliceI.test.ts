/**
 * Slice I contract tests.
 *
 * Pins the H3-7 fix at the schema decoder level so a future refactor
 * that loosens any of the 11 assistant-text caps trips here before the
 * regression ships. Cap values are pinned directly so a sneaky bump
 * (e.g. someone widening 10M → 1B) also trips.
 *
 *   - `PROVIDER_ASSISTANT_DELTA_MAX_CHARS = 1_000_000` — streaming
 *     chunks (deltas).
 *   - `PROVIDER_ASSISTANT_TEXT_MAX_CHARS = 10_000_000` — assembled
 *     final-state fields (full messages, complete reasoning blocks,
 *     unified diffs).
 *
 * We exercise two representative schemas — one for each cap class —
 * rather than all 11 sites (the constants are shared, the patterns
 * are identical, and a typo at one site shows up at the cap-pin
 * test). The asymmetric-cap test confirms the two constants stay
 * distinct.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  PROVIDER_ASSISTANT_DELTA_MAX_CHARS,
  PROVIDER_ASSISTANT_TEXT_MAX_CHARS,
  OrchestrationMessage,
} from "@t3tools/contracts";

describe("Slice I — H3-7: assistant-text caps pinned", () => {
  it("PROVIDER_ASSISTANT_DELTA_MAX_CHARS is 1_000_000", () => {
    // 1M chars per streaming chunk. If this widens unbounded, the cap
    // class loses its meaning. Trip immediately.
    expect(PROVIDER_ASSISTANT_DELTA_MAX_CHARS).toBe(1_000_000);
  });

  it("PROVIDER_ASSISTANT_TEXT_MAX_CHARS is 10_000_000", () => {
    // 10M chars per assembled field. Matches PROJECT_WRITE_FILE_MAX_CHARS
    // so "max realistic content payload" stays one number across the
    // codebase.
    expect(PROVIDER_ASSISTANT_TEXT_MAX_CHARS).toBe(10_000_000);
  });

  it("delta cap < text cap (asymmetric on purpose)", () => {
    // Streaming chunks should cap tighter than assembled fields —
    // legitimate deltas are tiny, big deltas are pathological. If
    // they ever equalize, the per-chunk-vs-per-message distinction
    // is gone.
    expect(PROVIDER_ASSISTANT_DELTA_MAX_CHARS).toBeLessThan(PROVIDER_ASSISTANT_TEXT_MAX_CHARS);
  });
});

describe("Slice I — H3-7: OrchestrationMessage.text honors the assembled cap", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationMessage);

  const baseMessage = {
    id: "msg_test",
    role: "assistant" as const,
    text: "hello",
    turnId: null,
    streaming: false,
    createdAt: "2026-05-16T15:00:00.000Z",
    updatedAt: "2026-05-16T15:00:00.000Z",
  };

  it("accepts a small assistant message (regression check)", () => {
    const result = decode(baseMessage);
    expect(result.text).toBe("hello");
  });

  it("accepts text at exactly the assembled-text cap", () => {
    // Boundary check. The first byte past the cap is rejected
    // (next test). If the boundary slides up or down, both tests
    // trip and the diagnosis is clear.
    const atCap = "x".repeat(PROVIDER_ASSISTANT_TEXT_MAX_CHARS);
    const result = decode({ ...baseMessage, text: atCap });
    expect(result.text.length).toBe(PROVIDER_ASSISTANT_TEXT_MAX_CHARS);
  });

  it("rejects text one char past the assembled-text cap", () => {
    // The canonical OOM shape — a multi-GB assistant response from
    // a buggy / compromised provider. We don't materialize the
    // pathological payload (would OOM the test runner), but the
    // boundary is the load-bearing check: cap+1 rejected ⇒ cap+1B
    // rejected by the same schema check.
    const overCap = "x".repeat(PROVIDER_ASSISTANT_TEXT_MAX_CHARS + 1);
    expect(() => decode({ ...baseMessage, text: overCap })).toThrow();
  });
});
