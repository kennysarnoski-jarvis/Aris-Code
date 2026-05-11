/**
 * DeepSeekSearchTools — Aris's KG search tools (search_knowledge,
 * search_cve, search_code), backed by the cloud's `/api/local/search/*`
 * routes which run the 3-pass pipeline (TSV/GIN keyword + pgvector
 * HNSW semantic + GAT graph rescore) against the Lightsail-hosted
 * `arisllm` Postgres.
 *
 * Why a separate file (matches MEM-1/2/3 + COORD-5 conventions):
 * each tool family lives in its own file, and `DeepSeekAgentTools` is
 * the thin composer that concats them. Keeps tool definitions small
 * and lets future search variants land here without touching the
 * memory tools.
 *
 * Auth: uses the same `cloudToken` (DeepSeek `local_api_key`) that
 * `/api/local/deepseek/v1/chat/completions` already requires. No new
 * credential surface — the user's existing DS activation covers
 * search too.
 *
 * Result formatting: each tool returns a compact TEXT block (not raw
 * JSON) so DS can reason over the results without parsing structured
 * data. Format mirrors what the POD-era `aris_server.py` returned to
 * Aris when she had access to the same KG.
 *
 * Gating: registers only when both `cloudBaseUrl` and `cloudToken` are
 * present. Without them the tools would 401 on every call, so it's
 * cleaner to omit them entirely and let DS know via tool absence
 * rather than failing tool calls.
 *
 * @module DeepSeekSearchTools
 */
import { tool } from "@openai/agents";
import { z } from "zod";

export interface SearchToolContext {
  /** Cloud base URL — e.g. `https://youraris.com`. Trailing slash tolerated. */
  readonly cloudBaseUrl: string;
  /** DeepSeek `local_api_key` — same one that authenticates DS chat dispatch. */
  readonly cloudToken: string;
  /** Optional fetch override (lets tests inject a mock without monkey-patching globalThis.fetch). */
  readonly fetchImpl?: typeof fetch;
}

/** Compact result row used in formatted tool output. */
interface SearchResultRow {
  readonly hash: string;
  readonly label: string;
  readonly category: string;
  readonly description?: string | null;
  readonly score: number;
  readonly gat_score?: number;
  readonly keyword_score?: number;
}

interface SearchResponse {
  readonly query: string;
  readonly count: number;
  readonly elapsed_ms: number;
  readonly gat_used: boolean;
  readonly results: ReadonlyArray<SearchResultRow>;
}

/**
 * Hit a `/api/local/search/<kind>` route on the cloud and return the
 * parsed response. Throws on non-2xx or network errors so the caller
 * can format an error message for DS to see.
 */
async function fetchSearch(
  ctx: SearchToolContext,
  kind: "knowledge" | "cve" | "code",
  query: string,
  limit: number,
): Promise<SearchResponse> {
  const baseUrl = ctx.cloudBaseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/api/local/search/${kind}?query=${encodeURIComponent(query)}&limit=${limit}`;
  const f = ctx.fetchImpl ?? fetch;
  const res = await f(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${ctx.cloudToken}` },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === "string" && body.detail.length > 0) {
        detail = body.detail;
      }
    } catch {
      // non-JSON body; fall through with status-based detail
    }
    throw new Error(`Search failed: ${detail}`);
  }
  return (await res.json()) as SearchResponse;
}

/**
 * Format a search response as a compact human-readable block for DS.
 * Truncates description to 200 chars per result so a 10-result list
 * doesn't blow the token budget.
 */
function formatSearchResults(kind: string, response: SearchResponse): string {
  if (response.count === 0) {
    return `No ${kind} concepts found for "${response.query}".`;
  }
  const lines: string[] = [
    `Found ${response.count} ${kind} concept${response.count === 1 ? "" : "s"} matching "${response.query}" ` +
      `(${response.elapsed_ms}ms${response.gat_used ? ", GAT-reranked" : ""}):`,
    "",
  ];
  response.results.forEach((r, i) => {
    const desc = (r.description ?? "").replace(/\s+/g, " ").trim();
    const truncated = desc.length > 200 ? desc.slice(0, 200) + "…" : desc;
    const scoreStr = `score=${r.score.toFixed(3)}`;
    const gatStr = r.gat_score !== undefined ? ` gat=${r.gat_score.toFixed(3)}` : "";
    lines.push(`${i + 1}. [${r.category}] ${r.label} (${scoreStr}${gatStr})`);
    if (truncated.length > 0) {
      lines.push(`   ${truncated}`);
    }
  });
  return lines.join("\n");
}

/**
 * Build the three KG search tools (search_knowledge, search_cve,
 * search_code) and return them as an array. Returns an empty array
 * when cloudBaseUrl or cloudToken are absent so the composer can
 * unconditionally `[...other, ...searchTools]`.
 */
export function createDeepSeekSearchTools(ctx: SearchToolContext) {
  if (!ctx.cloudBaseUrl || !ctx.cloudToken) {
    return [];
  }

  const searchKnowledge = tool({
    name: "search_knowledge",
    description:
      "Search the knowledge graph for concepts about security, architecture, " +
      "frameworks, algorithms, protocols, databases, concurrency, performance, " +
      "devops, testing, languages, AI/ML, blockchain, design patterns, " +
      "vulnerabilities, exploits, mitigations, and similar engineering topics. " +
      "Use this when the user asks 'how do I…', 'what's the best way to…', " +
      "'what are the tradeoffs of…' style questions about technical concepts. " +
      "Returns a ranked list of concepts with descriptions, blended from " +
      "keyword + semantic + graph-attention rescoring.",
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .describe("Free-text search query — natural language, no special syntax."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .nullable()
        .optional()
        .describe("Max results to return (1-20). Default 10."),
    }),
    async execute({ query, limit }) {
      const effectiveLimit = limit ?? 10;
      try {
        const response = await fetchSearch(ctx, "knowledge", query, effectiveLimit);
        return formatSearchResults("knowledge", response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `search_knowledge failed: ${message}`;
      }
    },
  });

  const searchCve = tool({
    name: "search_cve",
    description:
      "Search the knowledge graph for specific CVEs, GitHub security " +
      "advisories, package vulnerabilities, and framework release notes. Use " +
      "this when the user asks about a specific CVE id, recent vulnerabilities " +
      "in a library/framework, or any 'is X affected by Y vulnerability' " +
      "question. Returns ranked CVE/advisory entries with descriptions.",
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Free-text query OR specific CVE id (e.g. 'CVE-2024-1234' or " +
            "'react-router-dom path traversal').",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .nullable()
        .optional()
        .describe("Max results to return (1-20). Default 10."),
    }),
    async execute({ query, limit }) {
      const effectiveLimit = limit ?? 10;
      try {
        const response = await fetchSearch(ctx, "cve", query, effectiveLimit);
        return formatSearchResults("CVE", response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `search_cve failed: ${message}`;
      }
    },
  });

  const searchCode = tool({
    name: "search_code",
    description:
      "Search the knowledge graph for code structures — structs, enums, " +
      "traits, interfaces, type aliases, code examples, smart contracts, " +
      "functions, classes. Use this when the user asks for an example of " +
      "how a specific construct is used, or for reference implementations. " +
      "Returns ranked code-bearing concepts. The actual code is in the " +
      "result description (truncated for brevity).",
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .describe("Free-text query describing the code construct or pattern you want."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .nullable()
        .optional()
        .describe("Max results to return (1-20). Default 10."),
    }),
    async execute({ query, limit }) {
      const effectiveLimit = limit ?? 10;
      try {
        const response = await fetchSearch(ctx, "code", query, effectiveLimit);
        return formatSearchResults("code", response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `search_code failed: ${message}`;
      }
    },
  });

  return [searchKnowledge, searchCve, searchCode];
}
