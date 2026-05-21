/**
 * Slice J.5 — `checkWebSocketOrigin` + `tryAcquireWsConnectionSlot` tests.
 *
 * Pins the M3-3 (connection cap) + M3-5 (Origin allowlist) gates at
 * the unit level so a future refactor that loosens either trips here.
 *
 *   - `checkWebSocketOrigin` rejects cross-origin upgrades, accepts
 *     same-host / localhost / file:// / missing-Origin.
 *
 *   - `tryAcquireWsConnectionSlot` allows up to `MAX_CONCURRENT_WS_CONNECTIONS`
 *     simultaneous reservations and rejects after that. Releases
 *     return slots to the pool. Double-release is idempotent.
 */
import { afterEach, describe, expect, it } from "vitest";

import { AuthError } from "./auth/Services/ServerAuth.ts";
import {
  __resetWsConnectionCountForTests,
  checkWebSocketOrigin,
  tryAcquireWsConnectionSlot,
} from "./ws.ts";

describe("Slice J.5 — M3-5: checkWebSocketOrigin", () => {
  it("accepts when Origin header is missing (Electron renderer common case)", () => {
    expect(checkWebSocketOrigin({ origin: undefined, host: "localhost:3000" })).toBeNull();
  });

  it("accepts file:// origin (Electron production renderer)", () => {
    expect(
      checkWebSocketOrigin({ origin: "file:///Users/kenny/app.html", host: "localhost:3000" }),
    ).toBeNull();
  });

  it("accepts same-host origin", () => {
    // The standard same-origin case. Browser tab on http://localhost:3000
    // upgrading to ws://localhost:3000/ws — Origin host matches Host
    // header.
    expect(
      checkWebSocketOrigin({ origin: "http://localhost:3000", host: "localhost:3000" }),
    ).toBeNull();
  });

  it("accepts localhost origin even when host doesn't match (dev case)", () => {
    // Vite dev server at :5173 connecting to server at :3000 — the
    // hostnames match (localhost) but the ports differ, so the strict
    // same-host check would fail. The dev convenience branch
    // permits any localhost variant.
    expect(
      checkWebSocketOrigin({ origin: "http://localhost:5173", host: "localhost:3000" }),
    ).toBeNull();
    expect(
      checkWebSocketOrigin({ origin: "http://127.0.0.1:5173", host: "localhost:3000" }),
    ).toBeNull();
  });

  it("rejects a cross-origin browser tab (the CSWSH vector)", () => {
    // The load-bearing test. An attacker page at evil.com that
    // tries to upgrade WS to the user's local server must be rejected
    // by Origin BEFORE auth runs. Pre-Slice-J this would have hit
    // the cookie-authed WS handler and ridden the user's session.
    const result = checkWebSocketOrigin({
      origin: "https://evil.com",
      host: "localhost:3000",
    });
    expect(result).toBeInstanceOf(AuthError);
    expect(result?.status).toBe(403);
    expect(result?.message).toMatch(/cross-origin/i);
  });

  it("rejects a malformed Origin header", () => {
    const result = checkWebSocketOrigin({
      origin: "not a real url",
      host: "localhost:3000",
    });
    expect(result).toBeInstanceOf(AuthError);
    expect(result?.status).toBe(403);
    expect(result?.message).toMatch(/malformed/i);
  });
});

describe("Slice J.5 — M3-3: tryAcquireWsConnectionSlot", () => {
  afterEach(() => {
    // Counter is module-level; reset between tests so cap exhaustion
    // doesn't leak across cases.
    __resetWsConnectionCountForTests();
  });

  it("acquires a slot when below the cap", () => {
    const slot = tryAcquireWsConnectionSlot();
    expect(slot.acquired).toBe(true);
    slot.release();
  });

  it("rejects once the cap is exhausted", () => {
    // Acquire MAX_CONCURRENT_WS_CONNECTIONS slots. The next one fails.
    // (Cap is internal; we exhaust by trying many times until first
    // rejection. 50 attempts is well past any reasonable cap.)
    const slots = [];
    for (let i = 0; i < 50; i += 1) {
      const slot = tryAcquireWsConnectionSlot();
      if (!slot.acquired) {
        expect(i).toBeGreaterThan(0);
        // Release everything we acquired.
        for (const s of slots) s.release();
        return;
      }
      slots.push(slot);
    }
    // If we got here, the cap is >= 50 — unexpected; the cap is
    // documented at 10. Clean up and fail.
    for (const s of slots) s.release();
    throw new Error("WS connection cap appears to be > 50 — expected lower bound");
  });

  it("release returns the slot to the pool", () => {
    // Acquire and release in a loop — should always succeed.
    for (let i = 0; i < 5; i += 1) {
      const slot = tryAcquireWsConnectionSlot();
      expect(slot.acquired).toBe(true);
      slot.release();
    }
  });

  it("double-release is idempotent (no underflow)", () => {
    // If a future refactor accidentally double-releases the same
    // slot, the counter must not go negative — that would let the
    // server accept beyond the cap on subsequent acquires.
    const slot = tryAcquireWsConnectionSlot();
    expect(slot.acquired).toBe(true);
    slot.release();
    slot.release(); // second call should be a no-op
    // Verify counter is back to zero by acquiring all slots and
    // confirming the cap is the documented value.
    const slots = [];
    let count = 0;
    while (count < 50) {
      const s = tryAcquireWsConnectionSlot();
      if (!s.acquired) break;
      slots.push(s);
      count += 1;
    }
    expect(count).toBe(10); // MAX_CONCURRENT_WS_CONNECTIONS
    for (const s of slots) s.release();
  });
});
