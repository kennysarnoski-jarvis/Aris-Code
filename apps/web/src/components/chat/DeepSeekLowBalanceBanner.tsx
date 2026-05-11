/**
 * DeepSeekLowBalanceBanner — informational banner above the chat
 * composer that warns the user when their Aris (DeepSeek-keyed) cloud
 * balance is running low.
 *
 * Why this exists (BAL-4 / 2026-05-10):
 *   The header balance pill already shows the current balance, but a
 *   long coordinator turn with multiple workers can burn through small
 *   balances quickly. Surfacing a persistent banner once the balance
 *   crosses the low-balance threshold gives the user a chance to top
 *   up before they get cut off mid-turn.
 *
 * Trigger conditions (all must hold):
 *   - DeepSeek provider is enabled in settings
 *   - cloudBaseUrl + cloudToken are present (i.e. activated)
 *   - Balance has been fetched at least once (`balanceCents !== null`)
 *   - Balance is at or below `LOW_BALANCE_THRESHOLD_CENTS` (50¢)
 *
 * Enforcement boundary:
 *   This banner is INFORMATIONAL ONLY. It does not block dispatch,
 *   change provider state, or modify settings. Hard enforcement at
 *   $0 lives cloud-side (rejecting requests when the wallet is
 *   depleted) — outside this codebase. The banner only nudges the
 *   user toward youraris.com to top up.
 *
 * Dismissal:
 *   The banner is NOT dismissible by design — making it dismissible
 *   would let users silence the warning and still get cut off. It
 *   self-clears the moment the next balance fetch lands above the
 *   threshold.
 *
 * @module DeepSeekLowBalanceBanner
 */
import { memo } from "react";
import { CoinsIcon } from "lucide-react";

import { useSettings } from "../../hooks/useSettings";
import { useDeepSeekBalance } from "../../lib/deepseekBalanceState";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

/** Balance threshold (cents) at which the low-balance banner appears. */
const LOW_BALANCE_THRESHOLD_CENTS = 50;

function formatBalance(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const DeepSeekLowBalanceBanner = memo(function DeepSeekLowBalanceBanner() {
  const { enabled, cloudBaseUrl, cloudToken } = useSettings((s) => s.providers.deepseek);
  const { balanceCents } = useDeepSeekBalance();

  // Only render once we have a real balance reading AND the provider
  // is fully wired up. Pre-activation users have no balance yet, and
  // disabled-DeepSeek users don't see the pill either — so the banner
  // shouldn't surface to them.
  const isReady = enabled && cloudBaseUrl.length > 0 && cloudToken.length > 0;
  if (!isReady) return null;
  if (balanceCents === null) return null;
  if (balanceCents > LOW_BALANCE_THRESHOLD_CENTS) return null;

  const isDepleted = balanceCents <= 0;
  const formatted = formatBalance(Math.max(0, balanceCents));
  const title = isDepleted ? "Aris balance depleted" : "Aris balance low";
  const description = isDepleted
    ? "You're out of tokens. Top up at youraris.com to keep using Aris — new turns may be rejected by the cloud until your balance is positive."
    : `Only ${formatted} remaining. A long coordinator turn could finish your balance — top up at youraris.com to avoid getting cut off mid-session.`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={isDepleted ? "error" : "warning"}>
        <CoinsIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </Alert>
    </div>
  );
});
