/**
 * CoordinatorTypes — shared types for DeepSeek's coordinator-mode
 * tools (AgentTool, future TaskStopTool, future SyntheticOutputTool).
 *
 * Slice COORD-1: Foundation. Mirrors the Rust reference impl in
 * `~/Projects/claude-code/src-rust/cc-tools/src/agent_tool.rs` so the
 * shape is consistent with the leaked Anthropic implementation. The
 * Rust uses an `AgentInput` struct + `QueryOutcome` enum; we follow
 * the same names so future Claude (or whoever inherits this code)
 * can cross-reference both implementations without translating.
 *
 * @module CoordinatorTypes
 */

/**
 * Worker spawn input — the shape the model fills in when it calls
 * the spawn_worker tool. Mirrors the leaked Rust `AgentInput` struct
 * 1:1 so a future Claude reading both can map between them.
 *
 * Field semantics:
 *
 * - `description` — 3-5 word label for logging and (eventually) the
 *   TUI tree view. NOT cosmetic — it's how the user sees what each
 *   spawned worker is doing. "research auth flow" is a good
 *   description; "do the thing" is a bad one.
 *
 * - `prompt` — fully self-contained task prompt. The worker has NO
 *   visibility into the parent's conversation history, scratchpad,
 *   todos, or facts (those are coordinator-level state). The prompt
 *   must include every piece of context the worker needs.
 *
 * - `tools` — optional name allowlist. When `undefined`, the worker
 *   gets the default tool set (all DS tools minus AgentTool itself
 *   and the project/user state tools). When provided, the worker
 *   gets exactly those tools, filtered from the parent's catalog by
 *   name. Use the explicit allowlist to create restricted "code-
 *   monkey" workers (e.g., `["bash", "read_file"]`).
 *
 * - `system_prompt` — optional override for the worker's `instructions`.
 *   Default is a minimal "you are a sub-agent" framing. Override when
 *   you want a domain-specific worker persona.
 *
 * - `max_turns` — optional cap on worker iterations. Default 10
 *   (matches Rust ref). Workers that hit this cap return a partial
 *   result with a status signal in COORD-3; for COORD-1 they just
 *   return whatever text was produced before the cap.
 */
export interface AgentInput {
  readonly description: string;
  readonly prompt: string;
  readonly tools?: ReadonlyArray<string>;
  readonly system_prompt?: string;
  readonly max_turns?: number;
}

/**
 * Worker run outcome. Discriminated union on `status`. COORD-1 ships
 * the two basic variants; COORD-3 will add a `budget_exceeded`
 * variant carrying a checkpoint payload.
 *
 * Field semantics:
 *
 * - `ok` — worker completed normally. `text` is the final output the
 *   model produced. `usage` is optional per-worker token usage if the
 *   SDK surfaces it (cloud-side metering already aggregates total
 *   cost via the bearer regardless, so this is a UI nicety).
 *
 * - `error` — worker failed before producing output (auth missing,
 *   network error, SDK threw). `message` is the human-readable
 *   reason. The coordinator should surface this back to the user, not
 *   silently retry.
 */
export type QueryOutcome =
  | {
      readonly status: "ok";
      readonly text: string;
      readonly usage?: WorkerUsage;
    }
  | {
      readonly status: "error";
      readonly message: string;
    };

/**
 * Optional per-worker token usage. Populated when the SDK's
 * `result.usage` is available; left undefined otherwise. Cloud-side
 * metering does the actual billing aggregation via the bearer, so
 * this exists purely so the coordinator's response can show the user
 * "this worker burned N tokens" if we want that visibility later.
 */
export interface WorkerUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/**
 * Default `max_turns` for a spawned worker when the model doesn't
 * specify. Bump history:
 *   - Rust ref: 10
 *   - COORD-1 (initial): 25 — workers spun on empty-grep "audit X
 *     for Y" tasks; turn 1 returned nothing, worker didn't trust the
 *     empty result and burned the rest of its budget trying variants.
 *     25 fixed that.
 *   - 2026-05-11: 50 — live three-worker refactor (swap `errorMessage`
 *     across web/) showed legitimate read → plan → edit → verify → fix
 *     work needs ~30-40 turns to land. Workers were making real
 *     progress but ran out of rope. 50 gives implementation tasks
 *     headroom while keeping spinning workers bounded.
 *
 * Workers that need more iterations (deep research, sprawling
 * refactors) should still pass `max_turns` explicitly. Tasks that
 * don't fit in ~100 turns are the wrong shape — decompose them into
 * multiple narrower workers rather than raising the cap.
 */
export const DEFAULT_WORKER_MAX_TURNS = 50;

/**
 * Tool names that are ALWAYS available to every spawned worker, even
 * when the coordinator passes an explicit `tools: [...]` allowlist
 * that omits them. These are the baseline file/shell operations that
 * any practical worker task may legitimately need — without them you
 * get the 2026-05-12 failure mode where Aris spawned a refactor worker
 * with `tools: ["read_file", "edit_file", "grep"]` and the worker
 * needed `bash` mid-task to size a file, hit "Tool bash not found in
 * agent DeepSeek.Worker", and failed the whole worker.
 *
 * The coordinator's `tools` arg is now ADDITIVE over this baseline —
 * it can add specialty tools (e.g. `search_knowledge`) but cannot
 * narrow below the baseline.
 *
 * If you're tempted to add `scratchpad` / `todos` / `facts` /
 * `search_*` to this set: DON'T. Those are specialty tools whose
 * presence in a worker context depends on the task; the baseline is
 * strictly the always-makes-sense surface.
 */
export const WORKER_BASELINE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "grep",
  "glob",
  "list_directory",
]);

/**
 * Tool names that are NEVER given to a spawned worker, regardless of
 * whether the model passed `tools: undefined` (default) or a
 * whitelist that includes them.
 *
 * Per Kenny (2026-05-10): KISS — workers are full sub-agents
 * reporting to the parent, with the same tool surface and reasoning
 * mode. The only hard exclusion is recursion: workers can't spawn
 * their own workers. Everything else (scratchpad, todos, facts,
 * archives, file/shell tools) is fair game. If a worker pollutes
 * project state, the coordinator can clean up — that's the
 * coordinator's responsibility, not a security boundary we need to
 * hardcode.
 */
export const WORKER_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set(["spawn_worker"]);
