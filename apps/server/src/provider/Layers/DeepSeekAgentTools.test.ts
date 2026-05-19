/**
 * DeepSeekAgentTools tests.
 *
 * The implementation wraps `createArisAgentTools` (the 7 model-agnostic
 * file/shell tools — see ArisAgentTools header) and concatenates the
 * 3 DS-only archive tools (RW-6: list_archives, search_archives,
 * read_archive_range). These tests guard against:
 *
 *   1. The underlying base-tools symbol getting renamed without the
 *      wrapper following along (would break DeepSeek's adapter at
 *      runtime).
 *
 *   2. The tool array shape changing in a way that drops or renames
 *      tools (would break DeepSeek dispatches even though Aris's
 *      tests still pass).
 *
 *   3. Archive tools showing up when they shouldn't (no cwd → no
 *      archive directory → archive tools would just error).
 *
 * We don't re-test executor logic — that lives behind
 * `executeArisClientTool` (base tools) and the archive helpers in
 * `RollingWindowMemory` / this module. We just verify the SDK-shaped
 * tools come out with the expected names so DeepSeek's agentic loop
 * has the surface it needs.
 */
import { describe, expect, it } from "vitest";

import { createDeepSeekAgentTools } from "./DeepSeekAgentTools.ts";
import { makeFactsConfig } from "./FactsMemory.ts";
import { makeRollingWindowConfig } from "./RollingWindowMemory.ts";

const BASE_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "grep",
  "glob",
  "list_directory",
] as const;

const ARCHIVE_TOOL_NAMES = ["list_archives", "search_archives", "read_archive_range"] as const;

const SCRATCHPAD_TOOL_NAMES = ["update_scratchpad"] as const;
const TODOS_TOOL_NAMES = ["manage_todos"] as const;
const FACTS_TOOL_NAMES = ["upsert_memory_node", "delete_memory_node"] as const;
// Search tools (3) and web_search tool (1) are included in the composer
// result whenever `cloudBaseUrl + cloudToken` are present — they hit the
// cloud's `/api/local/search/*` and `/api/local/web_search` routes for
// the KG + GAT pipeline and Anthropic-backed web search. Listed here
// alongside the other tool families so the parentTools-order assertion
// in the first test matches the composer's actual emit order:
//   base, archive, scratchpad, todos, facts, search, web_search,
//   session_scratchpad, spawn_worker.
const SEARCH_TOOL_NAMES = ["search_knowledge", "search_cve", "search_code"] as const;
const WEB_SEARCH_TOOL_NAMES = ["web_search"] as const;
const SESSION_SCRATCHPAD_TOOL_NAMES = [
  "read_session_scratchpad",
  "append_session_scratchpad",
] as const;
const COORD_TOOL_NAMES = ["spawn_worker"] as const;

const COORD_DEPS = {
  cloudBaseUrl: "https://example.test",
  cloudToken: "test-bearer",
  defaultModelName: "deepseek-v4-pro",
  parentTurnId: "turn_test_xyz",
} as const;

const factsConfig = makeFactsConfig("/tmp");
const rollingWindowConfig = makeRollingWindowConfig("/tmp");

describe("createDeepSeekAgentTools", () => {
  it("returns base, archive, scratchpad, todos, facts, session-scratchpad, then spawn_worker when all deps present", () => {
    const tools = createDeepSeekAgentTools({
      factsConfig,
      rollingWindowConfig,
      cwd: "/tmp",
      threadId: "thread_test_001",
      ...COORD_DEPS,
    });
    const names = tools.map((t) => (t as unknown as { name: string }).name);
    expect(names).toEqual([
      ...BASE_TOOL_NAMES,
      ...ARCHIVE_TOOL_NAMES,
      ...SCRATCHPAD_TOOL_NAMES,
      ...TODOS_TOOL_NAMES,
      ...FACTS_TOOL_NAMES,
      ...SEARCH_TOOL_NAMES,
      ...WEB_SEARCH_TOOL_NAMES,
      ...SESSION_SCRATCHPAD_TOOL_NAMES,
      ...COORD_TOOL_NAMES,
    ]);
  });

  it("omits spawn_worker, session-scratchpad, search, AND web_search tools when cloud creds + parentTurnId are absent", () => {
    // Search + web_search both require cloudBaseUrl + cloudToken to
    // construct (they hit cloud routes with bearer auth). Session-
    // scratchpad requires parentTurnId. spawn_worker requires all of the
    // above plus defaultModelName via the AgentTool composer gate. So
    // when COORD_DEPS is omitted entirely, the result is just base +
    // archive + scratchpad + todos + facts.
    const tools = createDeepSeekAgentTools({
      factsConfig,
      rollingWindowConfig,
      cwd: "/tmp",
      threadId: "thread_test_002",
    });
    const names = tools.map((t) => (t as unknown as { name: string }).name);
    expect(names).not.toContain("spawn_worker");
    expect(names).not.toContain("read_session_scratchpad");
    expect(names).not.toContain("append_session_scratchpad");
    expect(names).not.toContain("search_knowledge");
    expect(names).not.toContain("web_search");
    expect(names).toEqual([
      ...BASE_TOOL_NAMES,
      ...ARCHIVE_TOOL_NAMES,
      ...SCRATCHPAD_TOOL_NAMES,
      ...TODOS_TOOL_NAMES,
      ...FACTS_TOOL_NAMES,
    ]);
  });

  it("accepts an optional AbortSignal alongside cwd + threadId + creds", () => {
    const ac = new AbortController();
    const tools = createDeepSeekAgentTools({
      factsConfig,
      rollingWindowConfig,
      cwd: "/tmp",
      threadId: "thread_test_003",
      signal: ac.signal,
      ...COORD_DEPS,
    });
    expect(tools).toHaveLength(
      BASE_TOOL_NAMES.length +
        ARCHIVE_TOOL_NAMES.length +
        SCRATCHPAD_TOOL_NAMES.length +
        TODOS_TOOL_NAMES.length +
        FACTS_TOOL_NAMES.length +
        SEARCH_TOOL_NAMES.length +
        WEB_SEARCH_TOOL_NAMES.length +
        SESSION_SCRATCHPAD_TOOL_NAMES.length +
        COORD_TOOL_NAMES.length,
    );
  });

  it("skips cwd-gated tools (archive, scratchpad, todos, facts, spawn_worker) when cwd is undefined", () => {
    const tools = createDeepSeekAgentTools({
      factsConfig,
      rollingWindowConfig,
      cwd: undefined,
      threadId: "thread_test_004",
      ...COORD_DEPS,
    });
    const names = tools.map((t) => (t as unknown as { name: string }).name);
    // spawn_worker depends on parentTools, which only get built when
    // cwd is present. So no cwd → no DS-only tools at all, including
    // the coordinator's spawn tool.
    expect(names).toEqual([...BASE_TOOL_NAMES]);
  });
});
