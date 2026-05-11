/**
 * useArisPendingApprovals — React hook that derives the pending-approval
 * list for an active Aris thread by consuming `aris.approval.*` events
 * from the dedicated Aris event channel (Cut C, slice 3e-iii-b-ii).
 *
 * Source: `EnvironmentApi["aris"]["subscribeEvents"]` → routes through
 * the WS `aris.subscribeEvents` RPC method to apps/server's
 * `ArisEventBus.streamForThread`.
 *
 * Lifecycle:
 *   - `aris.approval.requested` → add an entry to the pending Map
 *   - `aris.approval.resolved`  → remove the entry from the Map
 *
 * Reset triggers (full state clear):
 *   - threadId change
 *   - environmentId change
 *   - provider switching to/from "aris"
 *
 * Output shape mirrors `PendingApproval` from `session-logic.ts` so the
 * existing approval-card renderer doesn't need to branch on source —
 * `ChatView`'s `pendingApprovals` memo just swaps which array it reads
 * from based on the active thread's provider.
 */
import { useEffect, useMemo, useState } from "react";

import type { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { readEnvironmentApi } from "./environmentApi";
import type { PendingApproval } from "./session-logic";

interface ArisPendingApprovalState {
  readonly approvalId: ApprovalRequestId;
  readonly toolName: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface UseArisPendingApprovalsOptions {
  readonly threadId: ThreadId | null;
  readonly environmentId: EnvironmentId | null;
  readonly provider: string | null;
}

export interface UseArisPendingApprovalsResult {
  /**
   * Returned as a mutable `PendingApproval[]` (not `ReadonlyArray`) to match
   * the existing `derivePendingApprovals` signature so callers can pass it
   * straight into components that haven't yet adopted readonly props.
   */
  readonly pendingApprovals: PendingApproval[];
}

const EMPTY_PENDING: PendingApproval[] = [];

function inferRequestKind(toolName: string): PendingApproval["requestKind"] {
  if (toolName === "bash") return "command";
  if (toolName === "write_file" || toolName === "edit_file") return "file-change";
  // read_file / list_directory / grep / glob / anything else read-shaped
  return "file-read";
}

function synthesizePendingApproval(state: ArisPendingApprovalState): PendingApproval {
  const entry: PendingApproval = {
    requestId: state.approvalId,
    requestKind: inferRequestKind(state.toolName),
    createdAt: state.createdAt,
  };
  if (state.summary && state.summary.length > 0) {
    entry.detail = state.summary;
  }
  return entry;
}

export function useArisPendingApprovals(
  opts: UseArisPendingApprovalsOptions,
): UseArisPendingApprovalsResult {
  const { threadId, environmentId, provider } = opts;
  // DeepSeek shares ArisEventBus and emits the same `aris.approval.*`
  // events from DeepSeekAdapter's approval gateway (#22). Without DS
  // in this allowlist, approval prompts never surface in the UI for
  // DS threads and the runner blocks indefinitely on the awaited
  // Deferred. Mirror the gating in `useArisSessionStatus` /
  // `useArisToolEvents`.
  const enabled = (provider === "aris" || provider === "deepseek") && !!threadId && !!environmentId;

  const [pendingById, setPendingById] = useState<
    ReadonlyMap<ApprovalRequestId, ArisPendingApprovalState>
  >(() => new Map());

  useEffect(() => {
    if (!enabled || !threadId || !environmentId) {
      setPendingById(new Map());
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    setPendingById(new Map());

    const unsubscribe = api.aris.subscribeEvents({ threadId }, (event) => {
      if (event.type === "aris.approval.requested") {
        const next: ArisPendingApprovalState = {
          approvalId: event.payload.approvalId,
          toolName: event.payload.toolName,
          summary: event.payload.summary,
          createdAt: event.createdAt,
        };
        setPendingById((prev) => {
          const updated = new Map(prev);
          updated.set(event.payload.approvalId, next);
          return updated;
        });
        return;
      }
      if (event.type === "aris.approval.resolved") {
        setPendingById((prev) => {
          if (!prev.has(event.payload.approvalId)) return prev;
          const updated = new Map(prev);
          updated.delete(event.payload.approvalId);
          return updated;
        });
        return;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [enabled, environmentId, threadId]);

  const pendingApprovals = useMemo<PendingApproval[]>(() => {
    if (!enabled) return EMPTY_PENDING;
    return Array.from(pendingById.values()).map(synthesizePendingApproval);
  }, [enabled, pendingById]);

  return { pendingApprovals };
}
