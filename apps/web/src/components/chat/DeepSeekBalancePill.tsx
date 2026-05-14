/**
 * DeepSeekBalancePill — header pill that shows the user's Aris
 * (DeepSeek-keyed) token balance and refreshes it on a quiet timer.
 *
 * Why this exists (Slice 33j):
 *   Aris (DeepSeek wholesale) is the only token-pay provider in Aris
 *   Code. Codex / Claude either run on local infra or carry their own
 *   auth — none of them debit a per-message balance the user can
 *   deplete. The pill makes that running cost visible at a glance so
 *   the user doesn't run out of tokens mid-turn.
 *
 * Visibility:
 *   Renders `null` when DeepSeek is disabled OR not yet activated
 *   (no `cloudToken` cached). The slot just disappears from the
 *   header — there's nothing actionable to surface until the user
 *   pastes a subscription_key in Settings.
 *
 * State source (BAL-3 / 2026-05-10):
 *   The balance value, polling, and refresh logic now live in
 *   `lib/deepseekBalanceState.ts` so the low-balance banner above the
 *   composer can read the same value without re-fetching. This file
 *   is now purely presentational — it consumes `useDeepSeekBalance()`
 *   and dispatches `refreshDeepSeekBalance()` on click.
 *
 * @module DeepSeekBalancePill
 */
import { memo } from "react";
import { CoinsIcon } from "lucide-react";

import { useSettings } from "../../hooks/useSettings";
import { refreshDeepSeekBalance, useDeepSeekBalance } from "../../lib/deepseekBalanceState";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

function formatBalance(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Color tier the badge inherits — visual urgency based on remaining
 * balance. Thresholds picked to give the user roughly a session of
 * lead time before "red zone" kicks in.
 */
function balanceTierClass(cents: number | null): string {
  if (cents === null) return "text-muted-foreground";
  if (cents < 100) return "text-destructive"; // < $1 — top up now
  if (cents < 500) return "text-amber-600 dark:text-amber-400"; // < $5 — getting low
  return "text-foreground"; // healthy
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "just now";
  const seconds = Math.max(1, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export const DeepSeekBalancePill = memo(function DeepSeekBalancePill() {
  const { enabled, cloudBaseUrl, cloudToken } = useSettings((s) => s.providers.deepseek);
  const state = useDeepSeekBalance();

  // Hide the pill entirely when there's nothing to show — dispatch is
  // gated by the settings card upstream, so there's no value in
  // showing "—" forever.
  if (!enabled || !cloudBaseUrl || !cloudToken) {
    return null;
  }

  const displayBalance = state.balanceCents !== null ? formatBalance(state.balanceCents) : "—";
  const tierClass = balanceTierClass(state.balanceCents);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 cursor-default gap-1 px-2 py-0.5 text-xs font-medium tabular-nums",
              tierClass,
            )}
            onClick={() => {
              void refreshDeepSeekBalance();
            }}
            aria-label="Aris token balance — click to refresh"
          >
            <CoinsIcon className="size-3" aria-hidden="true" />
            {displayBalance}
          </Badge>
        }
      />
      <TooltipPopup side="bottom" className="max-w-xs">
        <div className="space-y-1 text-sm">
          <div className="font-medium">Aris balance</div>
          <div className="text-muted-foreground">
            {state.balanceCents !== null ? `${displayBalance} remaining` : "Fetching balance…"}
          </div>
          {state.email ? <div className="text-muted-foreground">Account: {state.email}</div> : null}
          {state.lastFetchedAt ? (
            <div className="text-muted-foreground">
              Updated {formatRelative(state.lastFetchedAt)}. Click to refresh.
            </div>
          ) : (
            <div className="text-muted-foreground">Click to refresh.</div>
          )}
          {state.errorMessage ? <div className="text-destructive">{state.errorMessage}</div> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
});
