/**
 * arisThreadsFetch — HTTP helpers for the per-thread CRUD endpoints on
 * `aris_server`'s `/v1/threads/...` surface (Cut C punch-list, Phase 3a).
 *
 * For Aris-provider threads, write actions (rename / archive / unarchive /
 * delete) bypass the orchestration command pipeline and hit `aris_server`
 * directly so the writes land in `aris_memory.db` — the source of truth
 * the sidebar reads from. Other providers continue to dispatch
 * orchestration commands.
 *
 * All endpoints expect `X-Aris-Key` perimeter auth and accept the
 * orchestration UUID as the `{thread_id}` URL segment.
 */

export interface ArisThreadActionOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly threadId: string;
  readonly signal?: AbortSignal;
}

async function executeAction(opts: ArisThreadActionOptions, init: RequestInit): Promise<void> {
  const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
  const url = `${trimmedBase}/v1/threads/${encodeURIComponent(opts.threadId)}${
    init.method === "DELETE" ? "" : ((init as { path?: string }).path ?? "")
  }`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "X-Aris-Key": opts.apiKey,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Aris thread ${init.method} ${res.status}: ${detail.slice(0, 500)}`);
  }
}

/** POST /v1/threads/{thread_id}/rename — body: `{title}`. */
export async function renameArisThread(
  opts: ArisThreadActionOptions & { readonly title: string },
): Promise<void> {
  const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
  const url = `${trimmedBase}/v1/threads/${encodeURIComponent(opts.threadId)}/rename`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Aris-Key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: opts.title }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Aris thread rename ${res.status}: ${detail.slice(0, 500)}`);
  }
}

/** POST /v1/threads/{thread_id}/archive — soft-delete (sets `archived=1`). */
export async function archiveArisThread(opts: ArisThreadActionOptions): Promise<void> {
  const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
  const url = `${trimmedBase}/v1/threads/${encodeURIComponent(opts.threadId)}/archive`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-Aris-Key": opts.apiKey },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Aris thread archive ${res.status}: ${detail.slice(0, 500)}`);
  }
}

/** POST /v1/threads/{thread_id}/unarchive — reverses archive. */
export async function unarchiveArisThread(opts: ArisThreadActionOptions): Promise<void> {
  const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
  const url = `${trimmedBase}/v1/threads/${encodeURIComponent(opts.threadId)}/unarchive`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-Aris-Key": opts.apiKey },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Aris thread unarchive ${res.status}: ${detail.slice(0, 500)}`);
  }
}

/** DELETE /v1/threads/{thread_id} — hard-delete (cascades to messages). */
export async function deleteArisThread(opts: ArisThreadActionOptions): Promise<void> {
  await executeAction(opts, { method: "DELETE" });
}
