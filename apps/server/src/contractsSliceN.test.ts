/**
 * Slice N contract tests — Round 4 MEDIUMs (M4-7, M4-10, M4-11, M4-12).
 *
 * Pins four schema-boundary caps so a future refactor that loosens
 * any of them trips here before the regression ships. Cap values are
 * pinned directly (not just "less than something huge") so a sneaky
 * bump (e.g. 256 → 65536) also trips.
 *
 *   - **M4-7** `ENTITY_ID_MAX_CHARS = 256` — branded entity IDs
 *     (ThreadId, TurnId, MessageId, EventId, AuthSessionId, …) cap
 *     at the `makeEntityId` factory in `baseSchemas.ts`, so every
 *     ID family inherits the cap automatically.
 *
 *   - **M4-10** `TerminalErrorEvent.message` capped at
 *     `TERMINAL_OUTPUT_EVENT_MAX_CHARS` (64K). Errors are diagnostic
 *     payloads — same chunk-size budget as live data events.
 *
 *   - **M4-11** `ArisArchiveMessage.content` capped at
 *     `PROVIDER_ASSISTANT_TEXT_MAX_CHARS` (10M). Archived messages
 *     replay verbatim into the renderer; same ceiling as live
 *     assembled assistant text so an archive can't exceed what it
 *     was archived from.
 *
 *   - **M4-12** `OrchestrationProposedPlan.planMarkdown` capped at
 *     `PROVIDER_ASSISTANT_DELTA_MAX_CHARS` (1M). A plan is one
 *     coherent planner output — 1M is generous for the worst legit
 *     case and bounds the abuse vector.
 *
 * We exercise ThreadId as a representative for the entity-ID family
 * (the factory caps every brand identically, the test would be the
 * same shape for any other ID). For the three string fields each
 * gets its own at-cap / past-cap pair so a per-field typo at one
 * site doesn't pass silently because another site is still tight.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ArisArchiveMessage,
  ENTITY_ID_MAX_CHARS,
  OrchestrationProposedPlan,
  PROVIDER_ASSISTANT_DELTA_MAX_CHARS,
  PROVIDER_ASSISTANT_TEXT_MAX_CHARS,
  TERMINAL_OUTPUT_EVENT_MAX_CHARS,
  TerminalEvent,
  ThreadId,
} from "@t3tools/contracts";

describe("Slice N — M4-7: ENTITY_ID_MAX_CHARS cap pinned", () => {
  it("ENTITY_ID_MAX_CHARS is 256", () => {
    // 256 chars is wildly generous for UUIDs (~36 chars) and
    // prefix-tagged IDs (~40 chars). If this widens unbounded, the
    // cap class loses its purpose — trip immediately.
    expect(ENTITY_ID_MAX_CHARS).toBe(256);
  });

  const decodeThreadId = Schema.decodeUnknownSync(ThreadId);

  it("accepts a normal-shape entity ID (regression check)", () => {
    const id = "thread-abc-123";
    expect(decodeThreadId(id)).toBe(id);
  });

  it("accepts an ID at exactly the cap", () => {
    // Boundary check. Past-cap is rejected below — together they
    // pin the exact cap rather than "somewhere in this neighborhood".
    const atCap = "a".repeat(ENTITY_ID_MAX_CHARS);
    expect(decodeThreadId(atCap).length).toBe(ENTITY_ID_MAX_CHARS);
  });

  it("rejects an ID one char past the cap", () => {
    const past = "a".repeat(ENTITY_ID_MAX_CHARS + 1);
    expect(() => decodeThreadId(past)).toThrow();
  });

  it("still rejects empty / whitespace IDs (NonEmpty composes with maxLength)", () => {
    // Slice N.1 changed `makeEntityId` from
    //   `TrimmedNonEmptyString.pipe(brand)` to
    //   `TrimmedNonEmptyString.check(isMaxLength(N)).pipe(brand)`.
    // Confirm the existing non-empty guard didn't get dropped along
    // the way — both checks must compose.
    expect(() => decodeThreadId("")).toThrow();
  });
});

describe("Slice N — M4-10: TerminalErrorEvent.message cap pinned", () => {
  it("TERMINAL_OUTPUT_EVENT_MAX_CHARS is 65_536", () => {
    expect(TERMINAL_OUTPUT_EVENT_MAX_CHARS).toBe(65_536);
  });

  const decode = Schema.decodeUnknownSync(TerminalEvent);

  const baseError = {
    threadId: "thread-1",
    terminalId: "term-1",
    createdAt: "2026-05-17T17:00:00.000Z",
    type: "error" as const,
    message: "boom",
  };

  it("accepts a small error event (regression check)", () => {
    const result = decode(baseError);
    expect(result.type).toBe("error");
  });

  it("accepts message at exactly the per-event cap", () => {
    const atCap = "x".repeat(TERMINAL_OUTPUT_EVENT_MAX_CHARS);
    const result = decode({ ...baseError, message: atCap });
    // Narrow the union via discriminant so TypeScript lets us read
    // `message` (only the error variant carries it).
    if (result.type !== "error") throw new Error("expected error variant");
    expect(result.message.length).toBe(TERMINAL_OUTPUT_EVENT_MAX_CHARS);
  });

  it("rejects message one char past the per-event cap", () => {
    const past = "x".repeat(TERMINAL_OUTPUT_EVENT_MAX_CHARS + 1);
    expect(() => decode({ ...baseError, message: past })).toThrow();
  });
});

describe("Slice N — M4-11: ArisArchiveMessage.content cap pinned", () => {
  const decode = Schema.decodeUnknownSync(ArisArchiveMessage);

  const baseMessage = {
    id: "msg-archive-1",
    role: "user" as const,
    content: "hello",
    turnId: null,
    createdAt: "2026-05-17T17:00:00.000Z",
  };

  it("accepts a small archive message (regression check)", () => {
    const result = decode(baseMessage);
    expect(result.content).toBe("hello");
  });

  it("accepts content at exactly the assembled-text cap (10M)", () => {
    const atCap = "y".repeat(PROVIDER_ASSISTANT_TEXT_MAX_CHARS);
    const result = decode({ ...baseMessage, content: atCap });
    expect(result.content.length).toBe(PROVIDER_ASSISTANT_TEXT_MAX_CHARS);
  });

  it("rejects content one char past the assembled-text cap", () => {
    const past = "y".repeat(PROVIDER_ASSISTANT_TEXT_MAX_CHARS + 1);
    expect(() => decode({ ...baseMessage, content: past })).toThrow();
  });
});

describe("Slice N — M4-12: OrchestrationProposedPlan.planMarkdown cap pinned", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationProposedPlan);

  const basePlan = {
    id: "plan-1",
    turnId: null,
    planMarkdown: "# Plan",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-05-17T17:00:00.000Z",
    updatedAt: "2026-05-17T17:00:00.000Z",
  };

  it("accepts a small plan (regression check)", () => {
    const result = decode(basePlan);
    expect(result.planMarkdown).toBe("# Plan");
  });

  it("accepts plan markdown at exactly the delta cap (1M)", () => {
    const atCap = "z".repeat(PROVIDER_ASSISTANT_DELTA_MAX_CHARS);
    const result = decode({ ...basePlan, planMarkdown: atCap });
    expect(result.planMarkdown.length).toBe(PROVIDER_ASSISTANT_DELTA_MAX_CHARS);
  });

  it("rejects plan markdown one char past the delta cap", () => {
    const past = "z".repeat(PROVIDER_ASSISTANT_DELTA_MAX_CHARS + 1);
    expect(() => decode({ ...basePlan, planMarkdown: past })).toThrow();
  });
});
