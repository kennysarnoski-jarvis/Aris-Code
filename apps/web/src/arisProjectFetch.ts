/**
 * arisProjectFetch — resolve the Aris `project_id` for a given root directory
 * via `POST /v1/projects/find-or-create` on aris_server.
 *
 * Idempotent on the server side (find-or-create), so multiple callers asking
 * about the same cwd in parallel is safe — apps/server's ArisAdapter does the
 * same lookup once per session and the web client now does it independently
 * for memory-graph project-scoping.
 *
 * CORS on the Aris server is wide open (allow_origins="*"), so the renderer
 * calls localhost:8001 directly using the signed-in user's session key as
 * the `X-Aris-Key` header — same shape as arisMemoryFetch / arisHistoryFetch.
 */

export interface FetchArisProjectIdOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

/**
 * POST /v1/projects/find-or-create with `{ root_dir: cwd }` → `project.id`.
 * Throws on transport failure, non-2xx, or a malformed response that doesn't
 * carry a positive integer id.
 */
export async function fetchArisProjectId(opts: FetchArisProjectIdOptions): Promise<number> {
  const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
  const url = `${trimmedBase}/v1/projects/find-or-create`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Aris-Key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ root_dir: opts.cwd }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Aris project lookup ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = (await res.json()) as { project?: { id?: number } };
  const id = data.project?.id;
  if (typeof id !== "number" || id < 1) {
    throw new Error("Aris project lookup returned no project id");
  }
  return id;
}
