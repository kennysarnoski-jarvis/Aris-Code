/**
 * deepseekBalanceState — single source of truth for the user's Aris
 * (DeepSeek-keyed) cloud balance.
 *
 * Why this module exists (BAL-2 / 2026-05-10):
 *   The balance pill in the chat header AND the low-balance banner above
 *   the composer both need to render off the same balance value. Without
 *   a shared atom, each consumer would run its own 60s poller against
 *   `/api/local/deepseek/balance`, duplicating network calls and
 *   producing momentarily-divergent UI. Lifting state into an Effect
 *   atom (matching the `gitStatusState.ts` pattern) gives both consumers
 *   a single value to subscribe to and a single poller to drive.
 *
 * Lifecycle:
 *   - `useDeepSeekBalance()` mounts → `watchDeepSeekBalance()` starts
 *     polling if it isn't already (refcount-managed). Returns the
 *     current atom value via `useAtomValue`.
 *   - Last subscriber unmounts → poll timer is cleared.
 *   - Settings change (enabled/cloudBaseUrl/cloudToken) → `watch` is
 *     re-entered with the new auth context; the polled fetch picks up
 *     the new credentials on the next tick. Disabled or missing
 *     credentials reset the atom to `INITIAL_STATE`.
 *
 * Failure modes (mirrored from the original pill implementation):
 *   - 401 → token revoked/stale; atom resets to INITIAL_STATE with the
 *     server's error message attached. User must re-activate via
 *     Settings.
 *   - Other non-2xx → keep the last-known balance (don't visually
 *     thrash on transient blips); attach the error message.
 *   - Network error → same as non-2xx (preserve last-known).
 *
 * Manual refresh:
 *   - `refreshDeepSeekBalance()` is a non-hook async function exposed
 *     for the click-to-refresh affordance on the balance pill. It
 *     reuses the in-flight fetch if one is already running so quick
 *     double-clicks don't fan out into multiple concurrent requests.
 *
 * @module deepseekBalanceState
 */
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { useSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";

const POLL_INTERVAL_MS = 60_000;

export interface DeepSeekBalanceState {
  /** Cents (e.g. 18665 → "$186.65"). null until first successful fetch. */
  readonly balanceCents: number | null;
  /** Email cloud reported alongside the balance — surfaced in tooltip. */
  readonly email: string | null;
  /** ISO timestamp of the last successful fetch — drives the "Updated …" line. */
  readonly lastFetchedAt: string | null;
  /** Most recent error message (auth failure, network, etc.). null when clear. */
  readonly errorMessage: string | null;
}

const INITIAL_STATE: DeepSeekBalanceState = {
  balanceCents: null,
  email: null,
  lastFetchedAt: null,
  errorMessage: null,
};

const balanceAtom = Atom.make<DeepSeekBalanceState>(INITIAL_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("deepseek:balance"),
);

interface AuthContext {
  readonly enabled: boolean;
  readonly cloudBaseUrl: string;
  readonly cloudToken: string;
}

// Module-scoped current auth — the polling loop reads from here on each
// tick so settings updates take effect on the very next poll without
// having to tear down/restart the timer.
let currentAuth: AuthContext | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;
let inFlight: Promise<void> | null = null;

function readBalance(): DeepSeekBalanceState {
  return appAtomRegistry.get(balanceAtom);
}

function writeBalance(next: DeepSeekBalanceState): void {
  appAtomRegistry.set(balanceAtom, next);
}

function updateBalance(updater: (prev: DeepSeekBalanceState) => DeepSeekBalanceState): void {
  writeBalance(updater(readBalance()));
}

async function performFetch(auth: AuthContext): Promise<void> {
  if (!auth.enabled || auth.cloudBaseUrl.length === 0 || auth.cloudToken.length === 0) {
    return;
  }
  try {
    const baseUrl = auth.cloudBaseUrl.replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/api/local/deepseek/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${auth.cloudToken}` },
    });
    if (!res.ok) {
      let detail = `Balance fetch failed (${res.status})`;
      try {
        const body = (await res.json()) as { detail?: unknown };
        if (typeof body?.detail === "string" && body.detail.length > 0) {
          detail = body.detail;
        }
      } catch {
        // non-JSON body; fall through with the status-based message
      }
      // Auth failure → wipe the atom: the cached balance is misleading
      // once the token's gone bad. Other failures keep the last-known
      // value so transient network blips don't visually thrash the pill.
      updateBalance((prev) =>
        res.status === 401
          ? { ...INITIAL_STATE, errorMessage: detail }
          : { ...prev, errorMessage: detail },
      );
      return;
    }
    const data = (await res.json()) as {
      ok?: boolean;
      balance_cents?: number;
      email?: string;
    };
    if (typeof data?.balance_cents !== "number") {
      updateBalance((prev) => ({ ...prev, errorMessage: "Cloud returned no balance_cents" }));
      return;
    }
    writeBalance({
      balanceCents: data.balance_cents,
      email: typeof data.email === "string" ? data.email : null,
      lastFetchedAt: new Date().toISOString(),
      errorMessage: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    updateBalance((prev) => ({ ...prev, errorMessage: message }));
  }
}

/**
 * Force a balance refresh against the current auth context. Returns the
 * in-flight promise if one is already running so back-to-back manual
 * refreshes (e.g. from the pill's click-to-refresh) coalesce.
 */
export function refreshDeepSeekBalance(): Promise<void> {
  if (inFlight) return inFlight;
  if (!currentAuth) return Promise.resolve();
  const auth = currentAuth;
  const promise = performFetch(auth).finally(() => {
    inFlight = null;
  });
  inFlight = promise;
  return promise;
}

function startPollingIfNeeded(): void {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    void refreshDeepSeekBalance();
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Subscribe to balance updates with the given auth context. Returns an
 * unsubscribe function. While at least one subscriber is active, a 60s
 * poll runs against `/api/local/deepseek/balance`. The most recent auth
 * context wins — settings updates take effect on the next poll tick
 * without restarting the timer.
 */
export function watchDeepSeekBalance(auth: AuthContext): () => void {
  const credentialsLost =
    !auth.enabled || auth.cloudBaseUrl.length === 0 || auth.cloudToken.length === 0;

  if (credentialsLost) {
    // No credentials → make sure the atom is clear so any subscribed
    // consumer renders the empty state. We still increment the refcount
    // so the unsubscribe call balances correctly; the pollTimer just
    // stays a no-op until credentials come back.
    currentAuth = null;
    if (readBalance().balanceCents !== null || readBalance().errorMessage !== null) {
      writeBalance(INITIAL_STATE);
    }
  } else {
    currentAuth = auth;
    // Kick off an immediate fetch on subscription; subsequent polls are
    // driven by the timer started below.
    void refreshDeepSeekBalance();
    startPollingIfNeeded();
  }

  refCount += 1;
  return () => {
    refCount -= 1;
    if (refCount <= 0) {
      refCount = 0;
      stopPolling();
      currentAuth = null;
      // Reset balance state so a stale value doesn't surface to the next
      // mount before the first fetch lands.
      if (readBalance().balanceCents !== null || readBalance().errorMessage !== null) {
        writeBalance(INITIAL_STATE);
      }
    }
  };
}

/**
 * React hook that reads the current balance state. Subscribes to the
 * shared atom and (re)registers polling whenever the user's DeepSeek
 * settings change.
 */
export function useDeepSeekBalance(): DeepSeekBalanceState {
  const { enabled, cloudBaseUrl, cloudToken } = useSettings((s) => s.providers.deepseek);

  useEffect(() => {
    return watchDeepSeekBalance({ enabled, cloudBaseUrl, cloudToken });
  }, [enabled, cloudBaseUrl, cloudToken]);

  return useAtomValue(balanceAtom);
}

/** Test helper — wipes module state. Not exported from the package barrel. */
export function resetDeepSeekBalanceStateForTests(): void {
  stopPolling();
  refCount = 0;
  inFlight = null;
  currentAuth = null;
  writeBalance(INITIAL_STATE);
}
