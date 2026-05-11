/**
 * arisMemoryFetch — read/write the Aris memory graph from the ArisLLM
 * backend (aris_memory.db locally + cloud MySQL passthrough).
 *
 * Powers the persistent right-side Memory card in Aris Code. CORS on the
 * Aris server is wide open (allow_origins="*"), so the browser calls
 * localhost:8001 directly using the signed-in user's session key as the
 * `X-Aris-Key` header — same shape as arisHistoryFetch.
 */

/**
 * One of the four V1 memdir types — enforced server-side. The UI groups
 * memories under these headings and uses them to drive type-specific
 * affordances (e.g. project-scoped indicators for `project` type).
 */
export type ArisMemoryType = "user" | "feedback" | "project" | "reference";

export interface ArisMemoryNode {
  readonly id: number;
  readonly user_id: number;
  readonly project_id: number | null;
  readonly type: ArisMemoryType;
  readonly label: string;
  /** One-line hook used to decide if a memory is relevant — populated by
   * the model on save. May be null on legacy rows that pre-date slice 1. */
  readonly description: string | null;
  readonly content: string | null;
  readonly cloud_id: string | null;
  readonly synced_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ArisMemoryEdge {
  readonly id: number;
  readonly source_id: number;
  readonly target_id: number;
  readonly relation: string;
  readonly weight: number;
  readonly created_at: string;
  readonly source_label: string;
  readonly target_label: string;
}

export interface ArisMemoryGraph {
  readonly nodes: ReadonlyArray<ArisMemoryNode>;
  readonly edges: ReadonlyArray<ArisMemoryEdge>;
}

export interface FetchArisMemoryGraphOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly projectId?: number;
  readonly signal?: AbortSignal;
}

export interface UpsertArisMemoryNodeOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly type: ArisMemoryType;
  readonly label: string;
  readonly description?: string;
  readonly content: string;
  readonly projectId?: number | null;
  readonly signal?: AbortSignal;
}

export interface UpsertArisMemoryNodeResult {
  readonly ok: boolean;
  readonly synced_to_cloud: boolean;
}

/**
 * GET /v1/memory/graph → ArisMemoryGraph.
 *
 * Local sqlite mirror only — no cloud round-trip per call. The mirror
 * stays fresh via lazy cloud sync at first read per process lifetime
 * (server-side `sync_memory_from_cloud`) and write-through on every upsert.
 */
export async function fetchArisMemoryGraph(
  opts: FetchArisMemoryGraphOptions,
): Promise<ArisMemoryGraph> {
  const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
  const url = new URL(`${trimmedBase}/v1/memory/graph`);
  if (typeof opts.projectId === "number") {
    url.searchParams.set("project_id", String(opts.projectId));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "X-Aris-Key": opts.apiKey },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Aris memory graph fetch ${res.status}: ${detail.slice(0, 500)}`);
  }

  return (await res.json()) as ArisMemoryGraph;
}

/**
 * POST /v1/memory/node → upsert a single node.
 *
 * Identity = (user_id, project_id, type, label) — re-saving the same
 * (type, label) overwrites the description and content. Mirrors the
 * model tool's `upsert_memory_node` behavior exactly. Server best-effort
 * syncs to cloud via /graph/save and reports `synced_to_cloud` in the
 * response.
 */
export async function upsertArisMemoryNode(
  opts: UpsertArisMemoryNodeOptions,
): Promise<UpsertArisMemoryNodeResult> {
  const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
  const url = `${trimmedBase}/v1/memory/node`;

  const body: {
    type: ArisMemoryType;
    label: string;
    description?: string;
    content: string;
    project_id?: number | null;
  } = {
    type: opts.type,
    label: opts.label,
    content: opts.content,
  };
  if (opts.description !== undefined) {
    body.description = opts.description;
  }
  if (opts.projectId !== undefined) {
    body.project_id = opts.projectId;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Aris-Key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Aris memory upsert ${res.status}: ${detail.slice(0, 500)}`);
  }

  return (await res.json()) as UpsertArisMemoryNodeResult;
}

export interface DeleteArisMemoryNodeOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly type: ArisMemoryType;
  readonly label: string;
  readonly projectId?: number | null;
  readonly signal?: AbortSignal;
}

export interface DeleteArisMemoryNodeResult {
  /** Always true on a 2xx or 404 — the row is gone after the call. */
  readonly ok: true;
  readonly deletedEdges: number;
  /** True when the server returned 404 — caller can show "already gone". */
  readonly notFound: boolean;
}

/**
 * DELETE /v1/memory/node?type=…&label=…&project_id=… → ack.
 *
 * Cloud-first delete with local sweep behind it. From the caller's
 * perspective both 200 and 404 are success outcomes — the row is gone
 * either way — so we normalize them into one shape with `notFound`
 * distinguishing the two. Genuine errors (5xx, transport) throw.
 */
export async function deleteArisMemoryNode(
  opts: DeleteArisMemoryNodeOptions,
): Promise<DeleteArisMemoryNodeResult> {
  const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
  const url = new URL(`${trimmedBase}/v1/memory/node`);
  url.searchParams.set("type", opts.type);
  url.searchParams.set("label", opts.label);
  if (typeof opts.projectId === "number") {
    url.searchParams.set("project_id", String(opts.projectId));
  }

  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: { "X-Aris-Key": opts.apiKey },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (res.status === 404) {
    return { ok: true, deletedEdges: 0, notFound: true };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Aris memory delete ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = (await res.json()) as { ok: boolean; deleted_edges: number };
  return {
    ok: true,
    deletedEdges: typeof data.deleted_edges === "number" ? data.deleted_edges : 0,
    notFound: false,
  };
}
