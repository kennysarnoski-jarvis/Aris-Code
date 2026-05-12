/**
 * DeepSeekWebSearchTools — Aris's live web search tool, backed by the
 * cloud's `/api/local/web_search` route (Anthropic Claude Haiku +
 * Anthropic's `web_search_20250305` server tool, results returned as
 * a synthesized summary + URL list).
 *
 * Why this file (matches the SEARCH-1..5 / MEM-1..3 / COORD-5
 * conventions): each tool family lives in its own file, and
 * `DeepSeekAgentTools` is the thin composer that concats them.
 *
 * Why bearer auth (not the trusted-caller `/api/local/web/search`
 * Brave route): the bearer-auth `/api/local/web_search` endpoint
 * accepts the same `cloudToken` (DeepSeek `local_api_key`) the chat
 * dispatch already uses — no new credential surface, no cloud-side
 * patching required. The richer Brave-with-extra_snippets endpoint at
 * `/api/local/web/search` exists but currently requires user_id in
 * body (aris_server proxy pattern); plumbing bearer auth through that
 * route is a future cloud-side improvement, not a blocker for v1.
 *
 * Result format: returns Claude's natural-language summary AND a
 * compact ranked URL list. The model can cite URLs directly without a
 * follow-up fetch in most cases — Claude has already extracted the
 * key facts during its server-side search step.
 *
 * Gating: registers only when both `cloudBaseUrl` and `cloudToken` are
 * present. Otherwise returns [] so the composer can unconditionally
 * spread it.
 *
 * @module DeepSeekWebSearchTools
 */
import { tool } from "@openai/agents";
import { z } from "zod";

export interface WebSearchToolContext {
  /** Cloud base URL — e.g. `https://youraris.com`. Trailing slash tolerated. */
  readonly cloudBaseUrl: string;
  /** DeepSeek `local_api_key` — same one that authenticates DS chat dispatch. */
  readonly cloudToken: string;
  /** Optional fetch override (lets tests inject a mock without monkey-patching globalThis.fetch). */
  readonly fetchImpl?: typeof fetch;
}

interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

interface WebSearchResponse {
  readonly ok: boolean;
  readonly summary: string;
  readonly results: ReadonlyArray<WebSearchResult>;
  readonly query: string;
}

/**
 * POST `/api/local/web_search` and return the parsed response.
 * Throws on non-2xx or network errors so the caller can format an
 * error message for DS to see.
 */
async function fetchWebSearch(
  ctx: WebSearchToolContext,
  query: string,
): Promise<WebSearchResponse> {
  const baseUrl = ctx.cloudBaseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/api/local/web_search`;
  const f = ctx.fetchImpl ?? fetch;
  const res = await f(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.cloudToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
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
    throw new Error(`Web search failed: ${detail}`);
  }
  return (await res.json()) as WebSearchResponse;
}

/**
 * Format the cloud's response as a compact human-readable block for DS:
 * the synthesized summary followed by a ranked list of URLs + titles +
 * snippets. Snippets get truncated to 200 chars per result so a
 * 10-result list doesn't blow the token budget.
 */
function formatWebSearchResults(response: WebSearchResponse): string {
  const lines: string[] = [];
  if (response.summary && response.summary.length > 0) {
    lines.push("## Summary");
    lines.push(response.summary.trim());
    lines.push("");
  }
  if (response.results.length === 0) {
    if (lines.length === 0) {
      return `No web results for "${response.query}".`;
    }
    lines.push("(No URL results returned beyond the summary above.)");
    return lines.join("\n");
  }
  lines.push(`## Sources (${response.results.length})`);
  response.results.forEach((r, i) => {
    const snippet = (r.snippet ?? "").replace(/\s+/g, " ").trim();
    const truncated = snippet.length > 200 ? snippet.slice(0, 200) + "…" : snippet;
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (truncated.length > 0) {
      lines.push(`   ${truncated}`);
    }
  });
  return lines.join("\n");
}

/**
 * Build the `web_search` tool. Wrapped in an array to match the
 * `createDeepSeekSearchTools` shape so the composer can spread both
 * uniformly. Returns [] when cloudBaseUrl or cloudToken are absent so
 * unconditional `[...other, ...webSearchTools]` works.
 */
export function createDeepSeekWebSearchTools(ctx: WebSearchToolContext) {
  if (!ctx.cloudBaseUrl || !ctx.cloudToken) {
    return [];
  }

  const webSearch = tool({
    name: "web_search",
    description:
      "Search the live web for current information. Use this when the " +
      "user asks about anything time-sensitive or external — current " +
      "events, recent product releases, prices, dates, news, sports, " +
      "today's information, anything that may have changed since your " +
      "training cutoff, or topics that aren't in the knowledge graph " +
      "(`search_knowledge` / `search_cve` / `search_code`). Returns a " +
      "synthesized summary of findings PLUS a ranked list of source " +
      "URLs with snippets — you can cite the URLs directly in your " +
      "response without any follow-up fetch. Counts against your turn " +
      "budget; use deliberately for queries where current information " +
      "actually matters. For stable engineering / security / framework " +
      "concepts, prefer `search_knowledge` (graph-grounded, faster, " +
      "cheaper).",
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Free-text web search query — natural language, no special " +
            "syntax. Be specific. Examples: 'NHL playoff schedule today', " +
            "'fastapi 0.115 release notes', 'OpenAI GPT-5.3 release date'.",
        ),
    }),
    async execute({ query }) {
      try {
        const response = await fetchWebSearch(ctx, query);
        return formatWebSearchResults(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `web_search failed: ${message}`;
      }
    },
  });

  return [webSearch];
}
