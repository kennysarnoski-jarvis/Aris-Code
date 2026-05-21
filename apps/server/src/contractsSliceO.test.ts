/**
 * Slice O contract tests — Round 4 M4-3 (cwd containment).
 *
 * Pins the new `WorkspacePathString` schema and its three application
 * sites so a future refactor that loosens the cap or removes the NUL
 * filter trips here before the regression ships. Cap value is pinned
 * directly so a sneaky bump (4096 → 65536) also trips.
 *
 *   - `WORKSPACE_PATH_MAX_LENGTH = 4096` (POSIX `PATH_MAX`).
 *   - NUL bytes (`\0`) rejected — defense-in-depth against any fs
 *     runtime that doesn't barf on them (Node usually does; future
 *     ports may not).
 *
 * Sites pinned:
 *   - `ArisArchiveReadInput.cwd` — user-controlled wire input that
 *     feeds `RollingWindowMemory.projectKeyFromCwd` → on-disk path.
 *     The load-bearing one — pre-Slice-O this accepted any
 *     `Schema.String` including 10MB blobs.
 *   - `ProviderSessionStartInput.cwd` — second user-controlled wire
 *     input variant.
 *   - `ProviderSession.cwd` — server-emitted but flows back through
 *     projection rehydration; same guard for symmetry.
 *
 * We exercise the boundary (at-cap accepted, past-cap rejected) for
 * the load-bearing site, and a NUL-byte rejection at each site so a
 * per-site typo (forgot to use WorkspacePathString) shows up cleanly.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ArisArchiveReadInput,
  ProviderSession,
  ProviderSessionStartInput,
  WORKSPACE_PATH_MAX_LENGTH,
} from "@t3tools/contracts";

describe("Slice O — M4-3: WORKSPACE_PATH_MAX_LENGTH cap pinned", () => {
  it("WORKSPACE_PATH_MAX_LENGTH is 4096 (POSIX PATH_MAX)", () => {
    // Matches the OS-level limit so the schema cap aligns with the
    // filesystem layer. If this widens unbounded, the cap class
    // loses its purpose.
    expect(WORKSPACE_PATH_MAX_LENGTH).toBe(4096);
  });
});

describe("Slice O — M4-3: ArisArchiveReadInput.cwd cap + NUL filter", () => {
  const decode = Schema.decodeUnknownSync(ArisArchiveReadInput);

  const base = {
    threadId: "thread-1",
    cwd: "/Users/kenny/Projects/t3code",
  };

  it("accepts a normal cwd (regression check)", () => {
    const result = decode(base);
    expect(result.cwd).toBe("/Users/kenny/Projects/t3code");
  });

  it("accepts cwd at exactly the cap", () => {
    // Boundary check. Past-cap is rejected below — together they
    // pin the exact cap rather than "somewhere in this neighborhood".
    const atCap = "/" + "x".repeat(WORKSPACE_PATH_MAX_LENGTH - 1);
    expect(atCap.length).toBe(WORKSPACE_PATH_MAX_LENGTH);
    const result = decode({ ...base, cwd: atCap });
    expect(result.cwd.length).toBe(WORKSPACE_PATH_MAX_LENGTH);
  });

  it("rejects cwd one char past the cap", () => {
    const past = "/" + "x".repeat(WORKSPACE_PATH_MAX_LENGTH);
    expect(past.length).toBe(WORKSPACE_PATH_MAX_LENGTH + 1);
    expect(() => decode({ ...base, cwd: past })).toThrow();
  });

  it("rejects cwd containing a NUL byte", () => {
    // The NUL filter is defense-in-depth. Node's fs.* usually throws
    // on NUL in paths but the behavior is platform-quirky and a
    // future runtime port might not. Reject at the schema so the
    // dangerous shape never lands in the runtime.
    const nul = "/Users/kenny/Projects/t3code\0/etc/passwd";
    expect(() => decode({ ...base, cwd: nul })).toThrow();
  });

  it("rejects empty cwd (TrimmedNonEmpty composes with cap + NUL filter)", () => {
    // Confirm the existing non-empty guard didn't get dropped when
    // WorkspacePathString was composed — all three checks must hold.
    expect(() => decode({ ...base, cwd: "" })).toThrow();
  });
});

describe("Slice O — M4-3: ProviderSessionStartInput.cwd NUL filter", () => {
  const decode = Schema.decodeUnknownSync(ProviderSessionStartInput);

  const base = {
    threadId: "thread-1",
    runtimeMode: "approval-required" as const,
  };

  it("accepts a normal cwd (regression check)", () => {
    const result = decode({ ...base, cwd: "/Users/kenny/Projects/t3code" });
    expect(result.cwd).toBe("/Users/kenny/Projects/t3code");
  });

  it("accepts an omitted cwd (field is optional)", () => {
    const result = decode(base);
    expect(result.cwd).toBeUndefined();
  });

  it("rejects cwd containing a NUL byte", () => {
    expect(() => decode({ ...base, cwd: "/Users/kenny/Projects/t3code\0/etc/passwd" })).toThrow();
  });
});

describe("Slice O — M4-3: ProviderSession.cwd NUL filter", () => {
  const decode = Schema.decodeUnknownSync(ProviderSession);

  const base = {
    provider: "aris" as const,
    status: "ready" as const,
    runtimeMode: "approval-required" as const,
    threadId: "thread-1",
    createdAt: "2026-05-17T17:00:00.000Z",
    updatedAt: "2026-05-17T17:00:00.000Z",
  };

  it("accepts a normal cwd (regression check)", () => {
    const result = decode({ ...base, cwd: "/Users/kenny/Projects/t3code" });
    expect(result.cwd).toBe("/Users/kenny/Projects/t3code");
  });

  it("rejects cwd containing a NUL byte", () => {
    expect(() => decode({ ...base, cwd: "/Users/kenny/Projects/t3code\0/etc/passwd" })).toThrow();
  });
});
