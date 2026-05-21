/**
 * Slice E.2 / H-2A — `checkWebSocketUpgradePolicy` tests.
 *
 * Pins the owner-only WS RPC gate at the unit level so a future
 * refactor that broadens the policy (or accidentally drops the check
 * altogether) trips here before the regression ships. The actual
 * policy lives in `ws.ts` as a pure helper — `checkWebSocketUpgradePolicy`
 * — so we can exercise it without spinning up the full HTTP / RPC /
 * service-graph stack.
 *
 * Threat model recap: a client-role session is created when an owner
 * issues a pairing link of role "client" via the HTTP API or the
 * desktop's ConnectionsSettings UI. Pre-Slice-E.2, that session could
 * open the WebSocket and call every RPC method (file writes, terminal
 * exec, settings mutation, git ops, dispatch). The fix locks the WS
 * RPC channel to owner-role sessions only; clients are HTTP-only.
 * These tests pin both halves of that contract.
 */
import { describe, expect, it } from "vitest";

import { AuthError } from "./auth/Services/ServerAuth.ts";
import { checkWebSocketUpgradePolicy } from "./ws.ts";

describe("Slice E.2 — H-2A: checkWebSocketUpgradePolicy", () => {
  it("allows an owner session to open the WS (returns null)", () => {
    // The expected path — single-user / single-device Aris Code: the
    // local owner session opens the WS to talk to its own server.
    const result = checkWebSocketUpgradePolicy({ role: "owner" });
    expect(result).toBeNull();
  });

  it("rejects a client session with a 403 AuthError", () => {
    // The H-2A attack surface: a pairing-link client session must not
    // be able to open a bidirectional RPC pipe to the server. Status
    // 403 to mirror the HTTP layer's `authenticateOwnerSession` gate.
    const result = checkWebSocketUpgradePolicy({ role: "client" });
    expect(result).toBeInstanceOf(AuthError);
    expect(result?.status).toBe(403);
    expect(result?.message).toMatch(/client sessions cannot establish/i);
    expect(result?.message).toMatch(/owner-only/i);
  });

  it("returns a fresh AuthError instance per call (no shared mutable state)", () => {
    // The gate must be referentially clean — if it ever returned a
    // memoized error, an Effect runtime that tagged the error with
    // request metadata would leak metadata across connections. Cheap
    // identity check pins the contract.
    const a = checkWebSocketUpgradePolicy({ role: "client" });
    const b = checkWebSocketUpgradePolicy({ role: "client" });
    expect(a).not.toBe(b);
  });
});
