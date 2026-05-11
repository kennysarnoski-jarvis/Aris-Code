/**
 * useArisProjectId — resolves the Aris `project_id` for a given cwd by
 * calling `POST /v1/projects/find-or-create` on aris_server. Surfaces the
 * resolved id to the renderer so surfaces like MemorySidebar can request
 * the hybrid (globals + this-project) memory slice from
 * `GET /v1/memory/graph?project_id=N` and avoid showing rows from other
 * projects.
 *
 * Mirrors the read pattern of useArisMemoryGraph: enabled only when
 * provider is "aris" and we have a baseUrl + apiKey + cwd. Fetch-key
 * guard prevents a stale lookup result from racing in after a thread /
 * project switch.
 *
 * Returns:
 *   - `null` while disabled, missing inputs, lookup in flight after a
 *     change, or on lookup failure (sidebar then falls back to the
 *     unscoped graph — no worse than pre-hybrid behavior).
 *   - a positive integer once the lookup has resolved successfully.
 */
import { useEffect, useRef, useState } from "react";

import { fetchArisProjectId } from "./arisProjectFetch";

export interface UseArisProjectIdOptions {
  readonly provider: string | null | undefined;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly cwd: string | null | undefined;
}

export function useArisProjectId(opts: UseArisProjectIdOptions): number | null {
  const { provider, baseUrl, apiKey, cwd } = opts;
  const enabled =
    provider === "aris" &&
    !!baseUrl &&
    typeof apiKey === "string" &&
    apiKey.length > 0 &&
    typeof cwd === "string" &&
    cwd.length > 0;

  const [projectId, setProjectId] = useState<number | null>(null);

  // Fetch-key guard — drop stale results if auth/cwd changed mid-flight.
  const fetchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !cwd) {
      fetchKeyRef.current = null;
      setProjectId(null);
      return;
    }

    const fetchKey = `${apiKey}:${cwd}`;
    fetchKeyRef.current = fetchKey;
    const controller = new AbortController();

    fetchArisProjectId({
      baseUrl,
      apiKey,
      cwd,
      signal: controller.signal,
    })
      .then((id) => {
        if (fetchKeyRef.current !== fetchKey) return;
        setProjectId(id);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (fetchKeyRef.current !== fetchKey) return;
        // Stay null on failure. The sidebar then renders the unscoped
        // graph (everything) which is the same behavior we had before
        // hybrid scoping shipped. No regression, just no improvement
        // until the lookup recovers on the next render cycle.
        setProjectId(null);
      });

    return () => {
      controller.abort();
    };
  }, [enabled, baseUrl, apiKey, cwd]);

  return projectId;
}
