/**
 * useArisMemoryGraph — React hook that fetches the Aris memory graph from
 * the ArisLLM backend, exposes optimistic upsert, and refetches on
 * provider/user/project change OR when the active turn emits a
 * `aris.memory.changed` event (i.e. the model called a graph-mutating
 * memory tool — upsert_memory_node, add_memory_edge, etc).
 *
 * Mirrors useArisThreadHistory's pattern: enabled only when provider is
 * "aris" and we have a baseUrl + userId. Fetch-key guard prevents stale
 * results from racing in after a switch. Event-driven refetch keeps the
 * sidebar in sync with what the model just saved without a manual reload.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { readEnvironmentApi } from "./environmentApi";
import {
  type ArisMemoryEdge,
  type ArisMemoryGraph,
  type ArisMemoryNode,
  type ArisMemoryType,
  deleteArisMemoryNode,
  fetchArisMemoryGraph,
  upsertArisMemoryNode,
} from "./arisMemoryFetch";

export interface UseArisMemoryGraphOptions {
  readonly provider: string | null;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly projectId?: number;
  /**
   * When provided alongside `threadId`, the hook subscribes to the Aris
   * event channel for that thread and refetches whenever an
   * `aris.memory.changed` event fires (emitted once per turn after any
   * graph-mutating memory tool runs server-side). Optional so other
   * surfaces that don't have a thread context (e.g. settings preview)
   * can still use the hook without auto-refresh.
   */
  readonly environmentId?: EnvironmentId | null;
  readonly threadId?: ThreadId | null;
}

export interface UpsertNodeArgs {
  readonly type: ArisMemoryType;
  readonly label: string;
  readonly description?: string;
  readonly content: string;
  readonly projectId?: number | null;
}

export interface DeleteNodeArgs {
  readonly type: ArisMemoryType;
  readonly label: string;
  readonly projectId?: number | null;
}

export interface UseArisMemoryGraphResult {
  /** `null` until the first fetch resolves (or when the hook is disabled). */
  readonly nodes: ReadonlyArray<ArisMemoryNode> | null;
  readonly edges: ReadonlyArray<ArisMemoryEdge> | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
  /**
   * Upsert a single node. On success, triggers a refetch so the rendered
   * graph reflects the write (and picks up any server-side normalization
   * like trimmed whitespace). Returns the server's ack for `synced_to_cloud`.
   * Throws on transport failure.
   */
  readonly upsert: (args: UpsertNodeArgs) => Promise<{ syncedToCloud: boolean }>;
  /**
   * Delete a single node by (type, label). On success — including
   * the "already gone" 404 case — triggers a refetch so the row drops
   * out of the rendered graph. Returns `notFound: true` when the server
   * said the row didn't exist; the UI can use that to soften messaging
   * but still treat it as a successful outcome. Throws on transport
   * failure or 5xx.
   */
  readonly deleteNode: (
    args: DeleteNodeArgs,
  ) => Promise<{ deletedEdges: number; notFound: boolean }>;
}

export function useArisMemoryGraph(opts: UseArisMemoryGraphOptions): UseArisMemoryGraphResult {
  const { provider, baseUrl, apiKey, projectId, environmentId, threadId } = opts;
  const enabled =
    provider === "aris" && !!baseUrl && typeof apiKey === "string" && apiKey.length > 0;

  const [graph, setGraph] = useState<ArisMemoryGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchTick, setRefetchTick] = useState(0);

  // Fetch-key guard — drop stale results if auth/provider/project changed
  // mid-flight, or if a refetch superseded the in-flight call.
  const fetchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      fetchKeyRef.current = null;
      setGraph(null);
      setLoading(false);
      setError(null);
      return;
    }

    const fetchKey = `${apiKey}:${projectId ?? "_"}:${refetchTick}`;
    fetchKeyRef.current = fetchKey;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchArisMemoryGraph({
      baseUrl,
      apiKey,
      ...(projectId !== undefined ? { projectId } : {}),
      signal: controller.signal,
    })
      .then((result) => {
        if (fetchKeyRef.current !== fetchKey) return;
        setGraph(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (fetchKeyRef.current !== fetchKey) return;
        const detail = err instanceof Error ? err.message : String(err);
        setError(detail);
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [enabled, baseUrl, apiKey, projectId, refetchTick]);

  const refetch = useCallback(() => {
    setRefetchTick((n) => n + 1);
  }, []);

  // Subscribe to the Aris event channel and refetch whenever the server
  // signals a graph mutation just landed (`aris.memory.changed`, emitted
  // once per turn before [DONE] when any graph-mutating memory tool ran).
  // This is what makes "Aris, save where we are" → sidebar updates without
  // the user switching tabs / threads / projects to force a refetch.
  useEffect(() => {
    if (!enabled || !environmentId || !threadId) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }
    const unsubscribe = api.aris.subscribeEvents({ threadId }, (event) => {
      if (event.type === "aris.memory.changed") {
        setRefetchTick((n) => n + 1);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [enabled, environmentId, threadId]);

  const upsert = useCallback(
    async (args: UpsertNodeArgs): Promise<{ syncedToCloud: boolean }> => {
      if (!enabled) {
        throw new Error("Aris memory graph not enabled — provider/apiKey missing");
      }
      const ack = await upsertArisMemoryNode({
        baseUrl,
        apiKey,
        type: args.type,
        label: args.label,
        content: args.content,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
      });
      // Refetch so the UI reflects the write immediately.
      setRefetchTick((n) => n + 1);
      return { syncedToCloud: ack.synced_to_cloud };
    },
    [enabled, baseUrl, apiKey],
  );

  const deleteNode = useCallback(
    async (args: DeleteNodeArgs): Promise<{ deletedEdges: number; notFound: boolean }> => {
      if (!enabled) {
        throw new Error("Aris memory graph not enabled — provider/apiKey missing");
      }
      const ack = await deleteArisMemoryNode({
        baseUrl,
        apiKey,
        type: args.type,
        label: args.label,
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
      });
      // Refetch so the row drops out of the rendered graph.
      setRefetchTick((n) => n + 1);
      return { deletedEdges: ack.deletedEdges, notFound: ack.notFound };
    },
    [enabled, baseUrl, apiKey],
  );

  return {
    nodes: graph?.nodes ?? null,
    edges: graph?.edges ?? null,
    loading,
    error,
    refetch,
    upsert,
    deleteNode,
  };
}
