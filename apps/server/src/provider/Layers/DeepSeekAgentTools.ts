/**
 * DeepSeekAgentTools — DeepSeek's view of Aris Code's local file/shell
 * tool surface, plus DS-only rolling-window archive query tools.
 *
 * The 7 base tools (read_file, write_file, edit_file, bash, grep,
 * glob, list_directory) come straight from `ArisAgentTools` — no
 * fork, no duplication. Per CLAUDE.md's "no duplicate logic" rule
 * those tool definitions are model-agnostic and should stay shared.
 *
 * The 3 DS-only archive tools (`list_archives`, `search_archives`,
 * `read_archive_range`) come from `DeepSeekArchiveTools`. They're
 * specifically for querying the rolling-window memory layer that
 * only DS uses (Aris persists conversations to aris_memory.db on the
 * POD/cloud side and doesn't have on-disk window archives).
 *
 * If you're a future Claude looking at this thinking "I should clone
 * the base tools for DS parity" — DON'T. Read the recon memory and
 * the CLAUDE.md "no duplicate logic" rule first. The re-export of
 * Aris tools is intentional; only the DS-specific archive tools live
 * separately because they have no Aris analogue.
 *
 * @module DeepSeekAgentTools
 */
import type { ArisEvent } from "@t3tools/contracts";

import type { AgentTemplate } from "./ArisAgentTemplatesLoader.ts";
import { createArisAgentTools, type ArisAgentToolsOptions } from "./ArisAgentTools.ts";
import { createDeepSeekAgentTool } from "./DeepSeekAgentTool.ts";
import { createDeepSeekArchiveTools } from "./DeepSeekArchiveTools.ts";
import { createDeepSeekFactsTools } from "./DeepSeekFactsTool.ts";
import type { FactsConfig } from "./FactsMemory.ts";
import type { RollingWindowConfig } from "./RollingWindowMemory.ts";
import { createDeepSeekScratchpadTool } from "./DeepSeekScratchpadTool.ts";
import { createDeepSeekSearchTools } from "./DeepSeekSearchTools.ts";
import { createDeepSeekWebSearchTools } from "./DeepSeekWebSearchTools.ts";
import { createDeepSeekSessionScratchpadTools } from "./DeepSeekSessionScratchpadTools.ts";
import { createDeepSeekTodosTool } from "./DeepSeekTodosTool.ts";

export interface DeepSeekAgentToolsOptions extends ArisAgentToolsOptions {
  /**
   * Thread id — required for DS-only archive tools (list_archives,
   * search_archives, read_archive_range) which scope their queries to
   * the per-thread `~/.aris/projects/<key>/sessions/<thread-id>/`
   * directory. The base Aris tools don't need it.
   */
  readonly threadId: string;
  /**
   * Slice L / M3-2 — resolved rolling-window paths from the adapter
   * composition root. Threaded through to archive tools so they
   * don't reach for `homedir()` implicitly.
   */
  readonly rollingWindowConfig: RollingWindowConfig;
  /**
   * COORD-1 — cloud creds + default model needed by `spawn_worker`
   * to construct fresh OpenAIClients for sub-agents. Optional so
   * tests and callers that don't have cloud creds in scope can still
   * compose the non-coordinator tool families. When absent,
   * `spawn_worker` is omitted from the result.
   */
  readonly cloudBaseUrl?: string;
  readonly cloudToken?: string;
  readonly defaultModelName?: string;
  /**
   * COORD-5 — parent turn id keys the per-session shared scratchpad
   * file. Optional so callers that don't yet know the turn id (rare
   * in practice; production always has it from the adapter) can
   * still build the non-COORD-5 tool families. When absent, the
   * read/append session-scratchpad tools are omitted.
   */
  readonly parentTurnId?: string;
  /**
   * MEM-3 — FactsConfig carrying resolved paths for the user-global
   * facts store. Required so `createDeepSeekFactsTools` doesn't
   * call `homedir()` implicitly at tool-execute time. Production
   * callers pass `makeFactsConfig()`; tests pass a temp-dir config.
   */
  readonly factsConfig: FactsConfig;
  /**
   * COORD-6.1 — emit aris.worker.spawn.* and
   * aris.session_scratchpad.appended events when workers spawn /
   * complete and when entries are appended. The adapter passes a
   * callback that publishes through its existing publishArisEvent
   * hook. Optional so non-adapter callers can skip the event channel.
   */
  readonly emitCoordinatorEvent?: (event: ArisEvent) => void;
  /**
   * Slice 4 — Pre-baked agent templates from `.aris/agents/`. Threaded
   * through to `createDeepSeekAgentTool` so spawn_worker's tool
   * description includes the template manifest and its execute() can
   * look up templates by name. Optional — when absent, spawn_worker
   * works exactly like the pre-Slice-4 behavior (the `template` param
   * still validates as a string but always returns the unknown-template
   * error string because there are no templates to look up).
   */
  readonly templates?: ReadonlyArray<AgentTemplate>;
}

export function createDeepSeekAgentTools(opts: DeepSeekAgentToolsOptions) {
  const baseTools = createArisAgentTools({
    cwd: opts.cwd,
    ...(opts.runtimeMode ? { runtimeMode: opts.runtimeMode } : {}),
  });
  // Archive tools only function when there's a real cwd (we can
  // compute the archive directory from cwd). Skip registering them
  // when cwd is empty — better than tools that always error.
  if (!opts.cwd || opts.cwd.length === 0) {
    return baseTools;
  }
  const archiveTools = createDeepSeekArchiveTools({
    cwd: opts.cwd,
    threadId: opts.threadId,
    rollingWindowConfig: opts.rollingWindowConfig,
  });
  // MEM-1 — Scratchpad tool. Like archive tools, gated on cwd because
  // the underlying jsonl lives at `~/.aris/projects/<key>/scratchpad.jsonl`
  // and we can't compute the key without a workspace cwd. Project-
  // scoped, NOT thread-scoped, so threadId isn't passed through.
  const scratchpadTools = createDeepSeekScratchpadTool({ cwd: opts.cwd });
  // MEM-2 — Todos tool. Same gating + scoping rules as scratchpad —
  // file lives at `~/.aris/projects/<key>/todos.jsonl`, project-scoped.
  const todosTools = createDeepSeekTodosTool({ cwd: opts.cwd });
  // MEM-3 — Facts tools (upsert_memory_node + delete_memory_node).
  // USER-GLOBAL — file lives at `~/.aris/facts.jsonl`, NOT under
  // any project. Doesn't depend on cwd at all (still inside the
  // cwd-gated branch because we only register the full DS tool
  // surface when cwd is present, but `createDeepSeekFactsTools`
  // takes no context — facts are scoped to the host user, not the
  // project).
  const factsTools = createDeepSeekFactsTools(opts.factsConfig);
  // KG search tools (search_knowledge / search_cve / search_code).
  // Backed by the cloud's `/api/local/search/*` routes which run the
  // 3-pass + GAT rescore pipeline against the Lightsail-hosted
  // `arisllm` Postgres. Reuses cloudBaseUrl + cloudToken (already
  // required for DS chat dispatch) for the bearer auth — no new
  // credential surface. Returns [] when either is missing so this
  // composes cleanly into the parentTools spread either way.
  const searchTools =
    opts.cloudBaseUrl && opts.cloudToken
      ? createDeepSeekSearchTools({
          cloudBaseUrl: opts.cloudBaseUrl,
          cloudToken: opts.cloudToken,
        })
      : [];
  // 2026-05-12 — Web search tool. Hits the cloud's bearer-auth
  // /api/local/web_search route (Anthropic Claude Haiku + the
  // web_search_20250305 server tool). Same gating as KG search —
  // skip when cloud creds aren't present so the spread below is
  // unconditional.
  const webSearchTools =
    opts.cloudBaseUrl && opts.cloudToken
      ? createDeepSeekWebSearchTools({
          cloudBaseUrl: opts.cloudBaseUrl,
          cloudToken: opts.cloudToken,
        })
      : [];
  // COORD-5 — Per-session shared scratchpad tools. Available to the
  // PARENT (writerLabel="parent") so the coordinator can publish a
  // master plan or read worker findings. Workers get their own copy
  // of these tools with writerLabel set to their description (built
  // inside DeepSeekAgentTool.ts when each worker is spawned). Gated
  // on parentTurnId + cwd + threadId — same gating as the worker
  // dependency chain.
  const sessionScratchpadTools = opts.parentTurnId
    ? createDeepSeekSessionScratchpadTools({
        rollingWindowConfig: opts.rollingWindowConfig,
        cwd: opts.cwd,
        threadId: opts.threadId,
        parentTurnId: opts.parentTurnId,
        writerLabel: "parent",
        ...(opts.emitCoordinatorEvent ? { emitCoordinatorEvent: opts.emitCoordinatorEvent } : {}),
      })
    : [];
  // COORD-1 — `spawn_worker` (the AgentTool). Always-on per Kenny
  // (DS is cheap, let her decide when to fan out). Built last so it
  // can capture the parent's full tool catalog as `parentTools` —
  // workers draw from this when filtering by allowlist or applying
  // default exclusion (WORKER_EXCLUDED_TOOL_NAMES strips spawn_worker
  // itself + scratchpad/todos/facts/archive).
  //
  // Gated on cloudBaseUrl + cloudToken + defaultModelName being
  // present. When any are absent (tests, alternate composers), the
  // factory returns []. Production callers (DeepSeekAdapter) always
  // have all three from `serverSettings.providers.deepseek`.
  const parentTools = [
    ...baseTools,
    ...archiveTools,
    ...scratchpadTools,
    ...todosTools,
    ...factsTools,
    ...searchTools,
    ...webSearchTools,
    ...sessionScratchpadTools,
  ];
  const agentToolFamily =
    opts.cloudBaseUrl && opts.cloudToken && opts.defaultModelName
      ? createDeepSeekAgentTool({
          cloudBaseUrl: opts.cloudBaseUrl,
          cloudToken: opts.cloudToken,
          defaultModelName: opts.defaultModelName,
          parentTools,
          ...(opts.signal ? { abortSignal: opts.signal } : {}),
          ...(opts.parentTurnId
            ? {
                sessionScratchpadCtx: {
                  rollingWindowConfig: opts.rollingWindowConfig,
                  cwd: opts.cwd,
                  threadId: opts.threadId,
                  parentTurnId: opts.parentTurnId,
                },
              }
            : {}),
          ...(opts.emitCoordinatorEvent ? { emitCoordinatorEvent: opts.emitCoordinatorEvent } : {}),
          // Slice 4 — templates pass through unchanged. Omitted-when-
          // absent matches the conditional-spread pattern used for the
          // other optional deps to satisfy `exactOptionalPropertyTypes`.
          ...(opts.templates ? { templates: opts.templates } : {}),
        })
      : [];
  return [...parentTools, ...agentToolFamily];
}
