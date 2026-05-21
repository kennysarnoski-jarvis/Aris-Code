/**
 * Slice E.1 contract-schema tests.
 *
 * Pins the H-2B + H-2C fixes at the schema decoder level so a future
 * refactor that loosens either gate trips here before the weakened
 * behavior ships to the wire.
 *
 *   - H-2B (PROVIDER_SEND_TURN_MAX_INPUT_CHARS on turn-start `text`):
 *     both `ThreadTurnStartCommand.message.text` and the orchestrator-
 *     internal `ClientThreadTurnStartCommand.message.text` were
 *     unbounded `Schema.String` pre-Slice-E, opening an OOM path
 *     during JSON parse on multi-GB payloads. Now they share the
 *     120K-char cap with `ProviderSendTurnInput`.
 *
 *   - H-2C (`SafeRecordKey` at every `Schema.Record` site): blocks
 *     `__proto__`, `constructor`, and `prototype` from appearing as
 *     keys. Without this, a `{"__proto__": {...}}` answers payload
 *     decodes cleanly, and the moment any downstream consumer spreads
 *     it (`{ ...defaults, ...answers }`) Object.prototype is polluted
 *     for the whole Node runtime.
 *
 * `ClientThreadTurnStartCommand` is module-private — we test its
 * sibling `ThreadTurnStartCommand` directly and trust the
 * identically-shaped client variant follows along via the same fix
 * (a typecheck regression on either would surface in the suite).
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderUserInputAnswers,
  SafeRecordKey,
  ThreadTurnStartCommand,
} from "@t3tools/contracts";

describe("Slice E.1 — H-2B: turn-start message.text is capped", () => {
  const baseCommand = {
    type: "thread.turn.start" as const,
    commandId: "cmd_test_e1_b",
    threadId: "thread_test",
    message: {
      messageId: "msg_test",
      role: "user" as const,
      text: "hello world",
      attachments: [] as ReadonlyArray<unknown>,
    },
    createdAt: "2026-05-16T15:00:00.000Z",
  };

  const decode = Schema.decodeUnknownSync(ThreadTurnStartCommand);

  it("the cap is 120_000 chars", () => {
    // Direct value pin. Same cap as ProviderSendTurnInput — keeps the
    // limit consistent everywhere a user message enters the system. If
    // a future refactor narrows the orchestrator cap below the provider
    // cap, callers that the provider would accept would be rejected
    // here. Trip immediately so the inconsistency surfaces.
    expect(PROVIDER_SEND_TURN_MAX_INPUT_CHARS).toBe(120_000);
  });

  it("accepts text at exactly the cap", () => {
    const atCap = "a".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    const result = decode({
      ...baseCommand,
      message: { ...baseCommand.message, text: atCap },
    });
    expect(result.message.text.length).toBe(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
  });

  it("rejects text one char past the cap", () => {
    // The canonical OOM shape — bytes past the cap. We don't materialize
    // the multi-GB payload directly (would OOM the test runner), but the
    // boundary is the load-bearing check: if cap+1 is rejected, the
    // server never gets the chance to parse cap+1B either.
    const overCap = "a".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1);
    expect(() =>
      decode({
        ...baseCommand,
        message: { ...baseCommand.message, text: overCap },
      }),
    ).toThrow();
  });

  it("accepts a small legitimate text (regression check)", () => {
    // Sanity — the cap doesn't accidentally over-narrow such that
    // normal-size user turns fail.
    const small = "make the README header bold";
    const result = decode({
      ...baseCommand,
      message: { ...baseCommand.message, text: small },
    });
    expect(result.message.text).toBe(small);
  });
});

describe("Slice E.1 — H-2C: SafeRecordKey blocks prototype-magic names", () => {
  const decodeKey = Schema.decodeUnknownSync(SafeRecordKey);

  it("accepts a normal key", () => {
    expect(decodeKey("foo")).toBe("foo");
  });

  it("accepts an empty string key", () => {
    // Edge case — empty string is a legal record key in JS / JSON, and
    // not a prototype-pollution vector. The filter must not reject it.
    expect(decodeKey("")).toBe("");
  });

  for (const forbidden of ["__proto__", "constructor", "prototype"]) {
    it(`rejects \`${forbidden}\` as a record key`, () => {
      // Direct guard pin. If any one of these three becomes legal again,
      // the prototype-pollution attack surface from H-2C reopens.
      expect(() => decodeKey(forbidden)).toThrow();
    });
  }
});

describe("Slice E.1 — H-2C: ProviderUserInputAnswers rejects polluted payloads", () => {
  const decode = Schema.decodeUnknownSync(ProviderUserInputAnswers);

  it("accepts a normal answers map", () => {
    const result = decode({ question_1: "yes", question_2: 42 });
    expect(result.question_1).toBe("yes");
    expect(result.question_2).toBe(42);
  });

  it("rejects `__proto__` as an answer key (JSON.parse vector)", () => {
    // Critical: object-literal syntax `{ __proto__: X }` is special-
    // cased by the JS parser as the prototype setter, NOT as an own
    // property — so the literal form doesn't reproduce the attack at
    // all (Object.keys returns []). The real wire input is JSON.parse
    // output, where `__proto__` IS a real own property. That's what
    // we need to reject, and that's what `JSON.parse` constructs here.
    const polluted = JSON.parse('{"__proto__": {"isAdmin": true}}') as unknown;
    expect(() => decode(polluted)).toThrow();
  });

  it("rejects `constructor` as an answer key", () => {
    // Second-order escalation vector — `obj.constructor.prototype` is
    // the long path to the same pollution outcome via downstream code
    // that calls `new answers.constructor()`.
    const polluted = JSON.parse('{"constructor": {"prototype": {"polluted": true}}}') as unknown;
    expect(() => decode(polluted)).toThrow();
  });

  it("rejects `prototype` as an answer key", () => {
    const polluted = JSON.parse('{"prototype": {"polluted": true}}') as unknown;
    expect(() => decode(polluted)).toThrow();
  });
});
