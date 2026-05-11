/**
 * useArisProjectThreads — React hook that fetches the user's Aris-provider
 * thread list directly from `aris_server` via `GET /v1/threads`, bypassing
 * state.sqlite's `projection_threads` entirely (Cut C, slice 3e-iv-d-i).
 *
 * The fetch uses the same `X-Aris-Key` perimeter auth as every other Aris
 * HTTP call from the web app. Returns `null` until the first fetch resolves
 * (or when the hook is disabled), then a synthesized `SidebarThreadSummary[]`
 * shaped exactly like the orchestration-projection rows the sidebar already
 * consumes — so the sidebar's existing grouping / sorting / archived-filter
 * logic doesn't change.
 *
 * Refetches whenever:
 *   - provider flips to "aris" (session init)
 *   - baseUrl / apiKey change (sign-in / sign-out)
 *   - `refetch()` is called (caller-driven, e.g. on turn settle)
 *
 * SLICE 3e-iv-d-i SCOPE: pure additive — this hook isn't wired into the
 * sidebar yet (that's 3e-iv-d-ii). Available for the cutover work to
 * consume; in the meantime it mirrors the additive-first pattern used
 * across the rest of Cut C.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type EnvironmentId,
  type OrchestrationLatestTurn,
  type ProjectId,
  type ProviderInteractionMode,
  ThreadId,
} from "@t3tools/contracts";

import { useArisSidebarRefreshStore } from "./arisSidebarRefreshStore";
import type { SidebarThreadSummary, ThreadSession } from "./types";

interface ArisThreadRow {
  readonly threadId: string;
  readonly conversationId: number;
  readonly projectId: number | null;
  readonly title: string;
  readonly archived: boolean;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string | null;
}

interface ArisThreadsResponse {
  readonly threads: ReadonlyArray<ArisThreadRow>;
}

export interface UseArisProjectThreadsOptions {
  readonly provider: string | null;
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * Aris-server numeric project id. When omitted, fetches every Aris thread
   * the user owns regardless of project (good for the "show me everything"
   * view); when supplied, scopes the fetch with `?project_id=N`.
   */
  readonly arisProjectId?: number;
  /** t3code-side environment to stamp on each synthesized row. */
  readonly environmentId: EnvironmentId | null;
  /** t3code-side project to stamp on each synthesized row. */
  readonly projectId: ProjectId | null;
}

export interface UseArisProjectThreadsResult {
  /** `null` until the first fetch resolves (or when the hook is disabled). */
  readonly threads: SidebarThreadSummary[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

const ARIS_INTERACTION_MODE: ProviderInteractionMode = "default";

function synthesizeSidebarSummary(
  row: ArisThreadRow,
  ctx: { environmentId: EnvironmentId; projectId: ProjectId },
): SidebarThreadSummary {
  const session: ThreadSession = {
    provider: "aris",
    // Sidebar status for an Aris thread comes from the live bus
    // (`useArisSessionStatus`) when the thread is the active one.
    // For non-active rows we just present a neutral "ready" snapshot —
    // the in-thread renderer derives the real-time state.
    status: "ready",
    createdAt: row.createdAt,
    updatedAt: row.lastActiveAt ?? row.createdAt,
    orchestrationStatus: "ready",
  };

  // No latest-turn timing in the `/v1/threads` projection — that comes
  // from the live bus. Keeping `latestTurn: null` in the sidebar summary
  // is correct: sort-by-recency uses `updatedAt` / `latestUserMessageAt`
  // which we DO populate.
  const latestTurn: OrchestrationLatestTurn | null = null;

  return {
    id: ThreadId.make(row.threadId),
    environmentId: ctx.environmentId,
    projectId: ctx.projectId,
    title: row.title,
    interactionMode: ARIS_INTERACTION_MODE,
    session,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
    updatedAt: row.lastActiveAt ?? row.createdAt,
    latestTurn,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: row.lastActiveAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

async function fetchArisThreads(opts: {
  baseUrl: string;
  apiKey: string;
  arisProjectId?: number;
  signal?: AbortSignal;
}): Promise<ArisThreadsResponse> {
  const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
  const url = new URL(`${trimmedBase}/v1/threads`);
  if (opts.arisProjectId !== undefined) {
    url.searchParams.set("project_id", String(opts.arisProjectId));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "X-Aris-Key": opts.apiKey },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Aris threads fetch ${res.status}: ${detail.slice(0, 500)}`);
  }
  return (await res.json()) as ArisThreadsResponse;
}

export function useArisProjectThreads(
  opts: UseArisProjectThreadsOptions,
): UseArisProjectThreadsResult {
  const { provider, baseUrl, apiKey, arisProjectId, environmentId, projectId } = opts;
  const enabled =
    provider === "aris" &&
    !!baseUrl &&
    typeof apiKey === "string" &&
    apiKey.length > 0 &&
    !!environmentId &&
    !!projectId;

  const [threads, setThreads] = useState<SidebarThreadSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchTick, setRefetchTick] = useState(0);
  // Cross-component refresh signal — anything that mutates Aris threads
  // (rename/delete handlers, future turn-settle hook) increments the
  // global tick and we refetch (Cut C punch list, Phase 3b).
  const externalTick = useArisSidebarRefreshStore((s) => s.tick);

  // Fetch-key guard — if the user signs out / switches provider mid-fetch,
  // drop late-arriving results so we don't render stale rows.
  const fetchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !environmentId || !projectId) {
      fetchKeyRef.current = null;
      setThreads(null);
      setLoading(false);
      setError(null);
      return;
    }

    const key = `${environmentId}:${projectId}:${arisProjectId ?? "all"}:${apiKey}`;
    fetchKeyRef.current = key;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchArisThreads({
      baseUrl,
      apiKey,
      ...(arisProjectId !== undefined ? { arisProjectId } : {}),
      signal: controller.signal,
    })
      .then((response) => {
        if (fetchKeyRef.current !== key) return;
        const synthesized = response.threads.map((row) =>
          synthesizeSidebarSummary(row, { environmentId, projectId }),
        );
        setThreads(synthesized);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (fetchKeyRef.current !== key) return;
        const detail = err instanceof Error ? err.message : String(err);
        setError(detail);
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [
    enabled,
    baseUrl,
    apiKey,
    arisProjectId,
    environmentId,
    projectId,
    refetchTick,
    externalTick,
  ]);

  const refetch = useCallback(() => {
    setRefetchTick((n) => n + 1);
  }, []);

  return useMemo(() => ({ threads, loading, error, refetch }), [threads, loading, error, refetch]);
}
