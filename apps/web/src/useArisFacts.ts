/**
 * useArisFacts — React hook that surfaces the user-global facts store
 * (`~/.aris/facts.jsonl`) to the right-sidebar Memory panel.
 *
 * Data flow:
 *   1. On mount, calls `aris.readFacts({})` via the EnvironmentApi to
 *      fetch the current snapshot from disk.
 *   2. Subscribes to the per-thread aris event stream and re-fetches
 *      whenever an `aris.tool.completed` for `upsert_memory_node` /
 *      `delete_memory_node` arrives — those are the only paths that
 *      can mutate facts.jsonl in this app. We re-fetch (vs. patching
 *      state from the event) so we always reflect the canonical
 *      on-disk state, not a derivation from event order.
 *
 * Always-visible: facts are user-global, applying across every
 * project / provider. The hook itself doesn't gate on provider — the
 * panel can decide whether to render based on its own criteria.
 *
 * Event subscription requires an environment + thread (the aris event
 * channel is per-thread). When the panel mounts without an active
 * thread, the initial snapshot still renders; we just won't get live
 * refreshes until the user opens a thread. That's fine — the next
 * snapshot read picks up any drift.
 *
 * @module useArisFacts
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { ArisFact, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { readEnvironmentApi } from "./environmentApi";

export interface UseArisFactsOptions {
  readonly threadId: ThreadId | null;
  readonly environmentId: EnvironmentId | null;
}

export interface UseArisFactsResult {
  readonly facts: ReadonlyArray<ArisFact>;
  readonly isLoading: boolean;
  readonly errorMessage: string | null;
  /** Force a manual refetch (rare; mostly used for retry-on-error UX). */
  readonly refetch: () => void;
}

const EMPTY_FACTS: ReadonlyArray<ArisFact> = [];

export function useArisFacts(opts: UseArisFactsOptions): UseArisFactsResult {
  const { threadId, environmentId } = opts;
  const [facts, setFacts] = useState<ReadonlyArray<ArisFact>>(EMPTY_FACTS);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Lets the event-driven refetch reuse the same fetcher the initial
  // load uses, without restarting the subscribe effect on every render.
  // We keep the latest environmentId in a ref so the callback closure
  // always reads the current value without being re-created.
  const environmentIdRef = useRef<EnvironmentId | null>(environmentId);
  environmentIdRef.current = environmentId;

  const fetchFacts = useCallback(async () => {
    const envId = environmentIdRef.current;
    if (!envId) return;
    const api = readEnvironmentApi(envId);
    if (!api) return;
    setIsLoading(true);
    try {
      const result = await api.aris.readFacts({});
      setFacts(result.facts);
      setErrorMessage(null);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setErrorMessage(detail);
      // Keep prior facts on error — the panel renders last-known state
      // and shows the error inline. Wiping on error would feel like
      // memory loss, which is the opposite of the panel's purpose.
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial snapshot + refetch on environment change.
  useEffect(() => {
    if (!environmentId) {
      setFacts(EMPTY_FACTS);
      setErrorMessage(null);
      return;
    }
    void fetchFacts();
  }, [environmentId, fetchFacts]);

  // Live refresh on memory-mutating tool completions. Listens via the
  // per-thread aris event channel; no-op when there's no active thread
  // (the snapshot is still rendered from the initial load).
  useEffect(() => {
    if (!threadId || !environmentId) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;

    const unsubscribe = api.aris.subscribeEvents({ threadId }, (event) => {
      if (event.type !== "aris.tool.completed") return;
      const preview = event.payload.resultPreview ?? "";
      // The result preview for upsert/delete contains the tool name in
      // its leading line ("Saved fact ...", "Deleted fact ..."), but
      // the cheapest match is on the tool name itself, which the event
      // payload carries via the matching aris.tool.started. We don't
      // have name on completed events directly (callId only), so we
      // heuristic on preview text — same approach the todos panel uses.
      // False matches are practically impossible; the strings are
      // specific to FactsMemory's render output.
      // DeepSeekFactsTool returns strings like "Fact saved (type=user,
      // label=name).\n\nCurrent facts:\n\n..." for upsert, and
      // "Fact deleted (type=...)" for delete. We match the leading
      // verb phrases to detect the mutation; the "Current facts:"
      // section serves the model, the panel re-fetches from disk
      // independently so it sees the canonical state.
      if (preview.startsWith("Fact saved") || preview.startsWith("Fact deleted")) {
        void fetchFacts();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [threadId, environmentId, fetchFacts]);

  return {
    facts,
    isLoading,
    errorMessage,
    refetch: () => void fetchFacts(),
  };
}
