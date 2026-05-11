/**
 * useArisCompactionStatus — React hook that observes
 * `aris.compaction.started` / `aris.compaction.completed` events on the
 * dedicated Aris event channel and returns a boolean the chat UI can use
 * to render a "Compacting earlier turns…" indicator.
 *
 * Slice 9.2 background: the Aris server moved compaction to a background
 * task in slice 9.1 so the user-facing turn isn't blocked. The single case
 * where the user *does* notice is when they fire a follow-up message
 * faster than the previous turn's compaction took to run — the next turn
 * has to await the background task before it can build its message list.
 * Without a UI signal that wait looks like the model is hung. The server
 * now emits `aris.compaction.started` immediately before the await and
 * `aris.compaction.completed` once it returns; this hook turns those
 * lifecycle events into a steady boolean for the renderer.
 *
 * Aris-only: other providers don't have this notion of side-call-driven
 * compaction blocks. Returns false for non-Aris threads or when the
 * thread/environment isn't ready.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "./environmentApi";

export interface UseArisCompactionStatusOptions {
  readonly threadId: ThreadId | null | undefined;
  readonly environmentId: EnvironmentId | null | undefined;
  readonly provider: string | null | undefined;
}

export function useArisCompactionStatus(opts: UseArisCompactionStatusOptions): boolean {
  const { threadId, environmentId, provider } = opts;
  const enabled = provider === "aris" && !!threadId && !!environmentId;

  const [isCompacting, setIsCompacting] = useState(false);

  useEffect(() => {
    if (!enabled || !threadId || !environmentId) {
      setIsCompacting(false);
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    // Reset on subscribe — a fresh thread/env can't be mid-compaction
    // until we hear `started`.
    setIsCompacting(false);

    const unsubscribe = api.aris.subscribeEvents({ threadId }, (event) => {
      if (event.type === "aris.compaction.started") {
        setIsCompacting(true);
      } else if (event.type === "aris.compaction.completed") {
        setIsCompacting(false);
      }
    });

    return () => {
      unsubscribe();
      // Defensive: clear state on teardown so a thread switch can't
      // leave a stale `true` flag in place.
      setIsCompacting(false);
    };
  }, [enabled, environmentId, threadId]);

  return isCompacting;
}
