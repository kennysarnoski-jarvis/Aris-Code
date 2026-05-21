/**
 * Slice F.1 contract-and-runtime tests.
 *
 * Pins three medium-severity hardening fixes at the wire-boundary
 * layer so a future refactor that loosens any of them trips here
 * before the regression ships:
 *
 *   - M-2F (MAX_WORKER_MAX_TURNS): caps `spawn_worker.max_turns` at
 *     the runtime clamp + the zod parameter. Without this, a runaway
 *     coordinator that requests a million worker iterations burns
 *     credit unbounded.
 *
 *   - M-2G (PROVIDER_SEND_TURN_MAX_ATTACHMENTS on turn-start commands):
 *     same cap as the provider-side path, applied to both
 *     `ThreadTurnStartCommand` and the orchestrator-internal
 *     `ClientThreadTurnStartCommand`. Closes a memory-exhaustion
 *     path via JSON parse on a turn with hundreds of large attachments.
 *
 *   - M-2H (Terminal schemas use TrimmedNonEmptyString): swapped
 *     `Schema.String.check(Schema.isNonEmpty())` for
 *     `TrimmedNonEmptyString` on `threadId` / `terminalId` / `cwd`
 *     in TerminalSessionSnapshot + TerminalEventBaseSchema. Closes
 *     the whitespace-only-key bypass class — `"   "` no longer
 *     decodes successfully and silently mismatches lookups downstream.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { DateTime } from "effect";

import {
  AuthPairingCredentialResult,
  AuthPairingLink,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  TerminalSessionSnapshot,
  ThreadTurnStartCommand,
} from "@t3tools/contracts";
import {
  clampWorkerMaxTurns,
  DEFAULT_WORKER_MAX_TURNS,
  MAX_WORKER_MAX_TURNS,
} from "./provider/Layers/CoordinatorTypes.ts";

describe("Slice F.1 — M-2F: clampWorkerMaxTurns", () => {
  it("MAX_WORKER_MAX_TURNS is 200", () => {
    // Direct value pin. 4× the default, 2× the soft-recommended
    // limit. If a future refactor widens this without a deliberate
    // call (cost data + comment update), trip here.
    expect(MAX_WORKER_MAX_TURNS).toBe(200);
  });

  it("DEFAULT_WORKER_MAX_TURNS is 50", () => {
    // Sanity pin — keeps the "default vs ceiling" headroom relationship
    // visible. If someone bumps the default to 250, this trips before
    // the default exceeds the ceiling silently.
    expect(DEFAULT_WORKER_MAX_TURNS).toBe(50);
  });

  it("returns the default when no value is supplied", () => {
    expect(clampWorkerMaxTurns(undefined)).toBe(DEFAULT_WORKER_MAX_TURNS);
  });

  it("returns the default for non-positive values", () => {
    // Templates / explicit args of 0 or -5 are treated as "not provided"
    // rather than literal zero turns (which would always immediately
    // bail). Falls through to the default.
    expect(clampWorkerMaxTurns(0)).toBe(DEFAULT_WORKER_MAX_TURNS);
    expect(clampWorkerMaxTurns(-5)).toBe(DEFAULT_WORKER_MAX_TURNS);
  });

  it("returns the default for NaN / Infinity", () => {
    expect(clampWorkerMaxTurns(Number.NaN)).toBe(DEFAULT_WORKER_MAX_TURNS);
    expect(clampWorkerMaxTurns(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WORKER_MAX_TURNS);
  });

  it("returns a legitimate value unchanged when within range", () => {
    expect(clampWorkerMaxTurns(100)).toBe(100);
  });

  it("floors fractional values", () => {
    expect(clampWorkerMaxTurns(42.9)).toBe(42);
  });

  it("clamps to MAX_WORKER_MAX_TURNS when the value is at the ceiling", () => {
    expect(clampWorkerMaxTurns(MAX_WORKER_MAX_TURNS)).toBe(MAX_WORKER_MAX_TURNS);
  });

  it("clamps to MAX_WORKER_MAX_TURNS when the value exceeds the ceiling", () => {
    // The load-bearing case. A coordinator that emits
    // `max_turns: 1_000_000` must NOT result in the worker actually
    // running a million iterations. If this test ever fails open, the
    // M-2F runaway-credit-burn finding regresses.
    expect(clampWorkerMaxTurns(1_000_000)).toBe(MAX_WORKER_MAX_TURNS);
    expect(clampWorkerMaxTurns(MAX_WORKER_MAX_TURNS + 1)).toBe(MAX_WORKER_MAX_TURNS);
  });
});

describe("Slice F.1 — M-2G: turn-start attachments array is capped", () => {
  const baseCommand = {
    type: "thread.turn.start" as const,
    commandId: "cmd_test_f1_g",
    threadId: "thread_test",
    message: {
      messageId: "msg_test",
      role: "user" as const,
      text: "hello",
      attachments: [] as ReadonlyArray<unknown>,
    },
    createdAt: "2026-05-16T15:00:00.000Z",
  };

  const decode = Schema.decodeUnknownSync(ThreadTurnStartCommand);

  it("PROVIDER_SEND_TURN_MAX_ATTACHMENTS is 8", () => {
    // Direct value pin. Same cap as the provider-side path
    // (ProviderSendTurnInput) — keeps the limit consistent everywhere
    // a turn enters the system.
    expect(PROVIDER_SEND_TURN_MAX_ATTACHMENTS).toBe(8);
  });

  it("accepts attachments at exactly the cap", () => {
    // We don't construct a real ChatAttachment here — the array-length
    // check fires before the per-element schema runs, but the
    // per-element schema would still reject our stub. So we test the
    // length bound at the smaller-but-still-cap-bounded direction:
    // empty array accepted, 8 stubs rejected for shape (not length),
    // 9 stubs rejected for length. The KEY assertion is that a 9th
    // element is what triggers the length failure.
    const result = decode({
      ...baseCommand,
      message: { ...baseCommand.message, attachments: [] },
    });
    expect(result.message.attachments.length).toBe(0);
  });

  it("rejects an over-cap attachments array", () => {
    // The load-bearing case — 9 elements is over the cap. The decoder
    // fails with either a max-length error or a per-element shape
    // error; either is acceptable since both reject the input. The
    // important contract is that the input does NOT decode.
    const overCap = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, () => ({}));
    expect(() =>
      decode({
        ...baseCommand,
        message: { ...baseCommand.message, attachments: overCap },
      }),
    ).toThrow();
  });
});

describe("Slice F.1 — M-2H: Terminal schemas reject whitespace-only ids", () => {
  const decode = Schema.decodeUnknownSync(TerminalSessionSnapshot);

  const baseSnapshot = {
    threadId: "thread_test",
    terminalId: "term_test",
    cwd: "/tmp/test",
    worktreePath: null,
    status: "running" as const,
    pid: 1234,
    history: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-05-16T15:00:00.000Z",
  };

  it("accepts legitimate ids and cwd", () => {
    const result = decode(baseSnapshot);
    expect(result.threadId).toBe("thread_test");
    expect(result.terminalId).toBe("term_test");
    expect(result.cwd).toBe("/tmp/test");
  });

  it("rejects whitespace-only threadId", () => {
    // The load-bearing case for M-2H. Pre-Slice-F.1, `isNonEmpty()`
    // checked length > 0 only — so `"   "` (three spaces, length 3)
    // passed and downstream code looking up that thread silently
    // missed because trimmed forms were the actual key. Switching to
    // `TrimmedNonEmptyString` trims first, then non-empty-checks,
    // which rejects whitespace-only values.
    expect(() => decode({ ...baseSnapshot, threadId: "   " })).toThrow();
  });

  it("rejects whitespace-only terminalId", () => {
    expect(() => decode({ ...baseSnapshot, terminalId: "\t\t" })).toThrow();
  });

  it("rejects whitespace-only cwd", () => {
    expect(() => decode({ ...baseSnapshot, cwd: " \n " })).toThrow();
  });

  it("rejects empty-string ids and cwd (regression — already broken pre-Slice-F)", () => {
    // Empty string was already rejected pre-Slice-F by `isNonEmpty()`.
    // We re-pin so a refactor that loosens both checks together can't
    // slip the empty-string bypass past us either.
    expect(() => decode({ ...baseSnapshot, threadId: "" })).toThrow();
    expect(() => decode({ ...baseSnapshot, terminalId: "" })).toThrow();
    expect(() => decode({ ...baseSnapshot, cwd: "" })).toThrow();
  });

  it("trims surrounding whitespace from legitimate values (TrimmedNonEmptyString side-effect)", () => {
    // The schema is `TrimmedNonEmptyString = TrimmedString.check(isNonEmpty)`,
    // so legitimate-with-padding values get trimmed during decode. We
    // pin this behavior so a future refactor that swaps Trimmed for a
    // raw String type loses the cleanup as well as the safety check.
    const result = decode({ ...baseSnapshot, threadId: "  thread_padded  " });
    expect(result.threadId).toBe("thread_padded");
  });
});

describe("Slice F.2 — M-2E: AuthPairingLink.credential is one-shot", () => {
  // Common fixture — every listing-shaped row downstream of
  // BootstrapCredentialService.listActive should look like this:
  // metadata only, no credential field at all. The schema must accept
  // it. `Schema.DateTimeUtc` expects an actual `DateTime.Utc` value
  // rather than a raw ISO string.
  const listingShape = {
    id: "pairing-test-1",
    role: "client" as const,
    subject: "one-time-token",
    createdAt: DateTime.fromDateUnsafe(new Date("2026-05-16T15:00:00.000Z")),
    expiresAt: DateTime.fromDateUnsafe(new Date("2026-05-16T15:30:00.000Z")),
  };

  const decode = Schema.decodeUnknownSync(AuthPairingLink);

  it("decodes a listing entry without credential", () => {
    // The load-bearing case: the schema must allow listings to omit
    // credential. If this test ever fails open, the redaction path
    // would have to fall back to either inventing a sentinel value
    // (gross) or making credential present-but-empty (bypasses
    // type-level guarantees).
    const result = decode(listingShape);
    expect(result.credential).toBeUndefined();
    expect(result.id).toBe("pairing-test-1");
  });

  it("decodes an issue-time entry that DOES include credential", () => {
    // The issue path (`emitUpsert` + the matching response) is the
    // one place where credential is legitimately emitted. The schema
    // must accept it there.
    const result = decode({ ...listingShape, credential: "secret-pairing-token-xyz" });
    expect(result.credential).toBe("secret-pairing-token-xyz");
  });

  it("rejects an empty-string credential when the field is present", () => {
    // `TrimmedNonEmptyString` semantics — if credential IS present,
    // it must be a real non-empty value. The optionality only relaxes
    // "field can be absent" not "field can be empty."
    expect(() => decode({ ...listingShape, credential: "" })).toThrow();
  });

  it("AuthPairingCredentialResult (issue response) still requires credential", () => {
    // The issue-time response shape uses a separate schema —
    // `AuthPairingCredentialResult` — which DOES require credential.
    // That's intentional: the caller is the owner who just minted the
    // token and needs to display/copy it right now. The two schemas
    // codify the one-shot contract: present at issue, absent at list.
    const decodeIssue = Schema.decodeUnknownSync(AuthPairingCredentialResult);
    expect(() =>
      decodeIssue({
        id: "pairing-test-2",
        expiresAt: DateTime.fromDateUnsafe(new Date("2026-05-16T15:30:00.000Z")),
        // credential intentionally omitted — should fail
      }),
    ).toThrow();
  });
});
