/**
 * ArisAgentTools — Aris's client tools repackaged as `@openai/agents`
 * SDK tool definitions.
 *
 * Why this file exists:
 *   `ArisClientTools.ts` ships the OpenAI function-calling JSON Schema for
 *   each tool plus a hand-rolled `executeArisClientTool` dispatcher. Slice 25
 *   proved the OpenAI Agents SDK can drive Aris's vLLM/Qwen3.6 stack, so
 *   Slice 26 ports each schema to the SDK's `tool({})` format with Zod
 *   parameter schemas. The execute callbacks are thin wrappers around the
 *   existing dispatcher — same I/O semantics, same error format ("Error: …"
 *   strings, not thrown Errors). Slice 23 will revisit error formatting.
 *
 *   Both files coexist during the migration. ArisClientTools.ts is still
 *   the source of truth for executor logic (read_file, edit_file, bash,
 *   grep, glob, list_directory, write_file). ArisAgentTools.ts wraps that
 *   surface in SDK shape so the SDK's agentic loop can call them. When
 *   Slice 30 retires the custom for-loop in ArisAdapter, the JSON-Schema
 *   table in ArisClientTools.ts becomes dead code and gets deleted —
 *   only the executor functions stay.
 *
 * Context handling:
 *   The original tools take an `ArisToolContext` with cwd + signal so they
 *   can resolve relative paths and respect interruption. The SDK doesn't
 *   pass cwd through `execute` — so we close over it via a factory
 *   function `createArisAgentTools(opts)`. The SDK passes its own
 *   `RunContext`-style argument to each `execute` call; we don't currently
 *   thread an AbortSignal through it (Slice 27 picks that up when wiring
 *   event-bus integration).
 *
 *   Reasoning for the factory pattern: the cwd needs to be known per-turn
 *   (per session, really). Constructing tools at module load time would
 *   freeze cwd to whatever it was when the process started. Factoring
 *   into `createArisAgentTools({ cwd })` keeps the production wiring
 *   honest — `ArisAdapter` will call this once per turn with the
 *   session's actual cwd.
 *
 * @module ArisAgentTools
 */
import { tool } from "@openai/agents";
import { z } from "zod";

import type { RuntimeMode } from "@t3tools/contracts";

import {
  type ArisToolContext,
  type ArisToolResult,
  executeArisClientTool,
} from "./ArisClientTools.ts";

/** Per-turn options for building tool definitions. */
export interface ArisAgentToolsOptions {
  /** Session's working directory. Tools use this to resolve relative paths. */
  readonly cwd: string | undefined;
  /** Optional cancellation signal. Currently unused — Slice 27 wires it. */
  readonly signal?: AbortSignal;
  /**
   * Runtime mode for approval gating (#22):
   *   - "full-access" → no gates (default)
   *   - "auto-accept-edits" → bash gated, edits auto-accepted
   *   - "approval-required" → bash + write_file + edit_file all gated
   *
   * When omitted, defaults to "full-access" (no gating). The SDK's
   * `needsApproval` mechanism pauses the agent run with an interruption
   * when a gated tool fires; the runner surfaces the interruption as
   * `aris.approval.requested` and waits for the user's decision via
   * the existing `respondToRequest` RPC pipeline.
   */
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Gate semantics:
 *   - bash: gated for everything except full-access
 *   - write_file / edit_file: gated only when approval-required
 *
 * "auto-accept-edits" literally auto-accepts edit operations but still
 * requires explicit confirmation for arbitrary shell execution.
 */
function shouldGateBash(mode: RuntimeMode | undefined): boolean {
  if (!mode) return false;
  return mode === "approval-required" || mode === "auto-accept-edits";
}

function shouldGateEdits(mode: RuntimeMode | undefined): boolean {
  if (!mode) return false;
  return mode === "approval-required";
}

/**
 * Format an Aris tool result for the SDK's `execute` return value.
 *
 * The SDK serializes whatever `execute` returns into the tool message
 * the model sees. We always return a string here (success OR failure) —
 * matches the legacy ArisClientTools contract. The model reads errors
 * as text, exactly as it does today through the custom for-loop.
 *
 * Slice 23 may change this to `throw new Error(...)` on `ok === false`
 * so the SDK marks the result as `is_error: true` (Claude-style
 * structured tool errors). Out of scope for Slice 26.
 */
function formatResult(result: ArisToolResult): string {
  return result.output;
}

/**
 * Build the array of SDK-format tools for a given session context.
 * Used by the (forthcoming) SDK-driven branch of ArisAdapter and
 * directly by the Slice 25/26 spike.
 */
export function createArisAgentTools(opts: ArisAgentToolsOptions) {
  const ctx: ArisToolContext = {
    cwd: opts.cwd,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  // ── read_file ────────────────────────────────────────────────────
  const readFile = tool({
    name: "read_file",
    description:
      "Read a text file and return its contents with line numbers prefixed " +
      "('  42→foo'). When neither offset nor limit is supplied, output is " +
      "capped at 2000 lines — files longer than that come back truncated " +
      "with a [truncated — file is N lines …] header so context isn't blown " +
      "by a single read. To read past the cap, call again with `offset` " +
      "(1-based start line) and/or `limit` (max lines). Use both to page " +
      "through large files.\n\n" +
      "EFFICIENCY: Each call is ONE tool dispatch regardless of how many lines " +
      "you read. Prefer wide reads (200-500 lines per call). Pulling 10-30 " +
      "line windows wastes tool calls — read a wider region in one shot " +
      "when you'd otherwise need multiple narrow reads. Don't re-read a " +
      "region you already saw earlier in this turn — scroll back through " +
      "your context first.\n\n" +
      "NOTE: line-number prefixes are display only; strip them when passing " +
      "text to edit_file.",
    parameters: z.object({
      path: z
        .string()
        .describe("Path to the file. Absolute, or relative to the session's working directory."),
      offset: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "1-based line number to start reading from. Default 1 (start of file). Omit or pass null when not paging.",
        ),
      limit: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Maximum number of lines to return. Default: 2000-line guardrail when offset is also unset; no limit otherwise. Omit or pass null when not paging.",
        ),
    }),
    // `!= null` (loose equality) intentionally catches BOTH null and
    // undefined so models that omit nullable fields (DeepSeek does this
    // routinely) and models that pass null both end up with the
    // server-side default behavior.
    async execute({ path, offset, limit }) {
      const args: Record<string, unknown> = { path };
      if (offset != null) args.offset = offset;
      if (limit != null) args.limit = limit;
      const result = await executeArisClientTool("read_file", args, ctx);
      return formatResult(result);
    },
  });

  // ── write_file ───────────────────────────────────────────────────
  const writeFile = tool({
    name: "write_file",
    description:
      "Create a new file or completely overwrite an existing file. Parent " +
      "directories are created if they don't exist. Prefer edit_file for " +
      "surgical changes to existing files.",
    parameters: z.object({
      path: z.string().describe("Destination file path. Absolute or relative to cwd."),
      content: z.string().describe("Full file contents to write."),
    }),
    needsApproval: shouldGateEdits(opts.runtimeMode),
    async execute({ path, content }) {
      const result = await executeArisClientTool("write_file", { path, content }, ctx);
      return formatResult(result);
    },
  });

  // ── edit_file ────────────────────────────────────────────────────
  const editFile = tool({
    name: "edit_file",
    description:
      "Replace a substring inside an existing file. Fails if the search " +
      "string is not found, or if it appears more than once and replace_all " +
      "is not set.",
    parameters: z.object({
      path: z.string().describe("File to edit."),
      search: z
        .string()
        .describe("Exact string to find. Must be unique unless replace_all is true."),
      replace: z.string().describe("Replacement string."),
      replace_all: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "If true, replace every occurrence. Default false (single-match required). Omit or pass null for default.",
        ),
    }),
    needsApproval: shouldGateEdits(opts.runtimeMode),
    async execute({ path, search, replace, replace_all }) {
      const args: Record<string, unknown> = { path, search, replace };
      if (replace_all != null) args.replace_all = replace_all;
      const result = await executeArisClientTool("edit_file", args, ctx);
      return formatResult(result);
    },
  });

  // ── bash ─────────────────────────────────────────────────────────
  const bash = tool({
    name: "bash",
    description:
      "Execute a shell command in the session's working directory. Returns " +
      "combined stdout, stderr, and exit code. Use for builds, tests, git, " +
      "or any CLI tool.",
    parameters: z.object({
      command: z.string().describe("Shell command to run (interpreted by /bin/bash -lc)."),
      timeout_ms: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Optional timeout in milliseconds. Default 120000. Omit or pass null for default.",
        ),
    }),
    needsApproval: shouldGateBash(opts.runtimeMode),
    async execute({ command, timeout_ms }) {
      const args: Record<string, unknown> = { command };
      if (timeout_ms != null) args.timeout_ms = timeout_ms;
      const result = await executeArisClientTool("bash", args, ctx);
      return formatResult(result);
    },
  });

  // ── grep ─────────────────────────────────────────────────────────
  const grep = tool({
    name: "grep",
    description:
      "Search file contents for a regex pattern using ripgrep. Returns " +
      "matching lines prefixed by file path and line number.",
    parameters: z.object({
      pattern: z.string().describe("Regex pattern to search for."),
      path: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional directory or file to search. Defaults to the cwd. Omit or pass null for cwd.",
        ),
      glob: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional glob filter, e.g. '*.ts' or 'src/**/*.py'. Omit or pass null for no filter.",
        ),
      case_insensitive: z
        .boolean()
        .nullable()
        .optional()
        .describe("If true, perform case-insensitive matching. Omit or pass null for default."),
    }),
    async execute({ pattern, path, glob, case_insensitive }) {
      const args: Record<string, unknown> = { pattern };
      if (path != null) args.path = path;
      if (glob != null) args.glob = glob;
      if (case_insensitive != null) args.case_insensitive = case_insensitive;
      const result = await executeArisClientTool("grep", args, ctx);
      return formatResult(result);
    },
  });

  // ── glob ─────────────────────────────────────────────────────────
  const glob = tool({
    name: "glob",
    description:
      "List files matching a glob pattern. Returns one path per line, " +
      "relative to the search root.",
    parameters: z.object({
      pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'."),
      path: z
        .string()
        .nullable()
        .optional()
        .describe("Optional root directory. Defaults to cwd. Omit or pass null for cwd."),
    }),
    async execute({ pattern, path }) {
      const args: Record<string, unknown> = { pattern };
      if (path != null) args.path = path;
      const result = await executeArisClientTool("glob", args, ctx);
      return formatResult(result);
    },
  });

  // ── list_directory ───────────────────────────────────────────────
  const listDirectory = tool({
    name: "list_directory",
    description:
      "List the contents of a directory. By default returns only immediate " +
      "children. Set recursive=true to walk subdirectories (capped by " +
      "max_depth). Directories are suffixed with '/'. Use this to get your " +
      "bearings when the user points the session at a folder.",
    parameters: z.object({
      path: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Directory path. Absolute or relative to cwd. Defaults to cwd. Omit or pass null for cwd.",
        ),
      recursive: z
        .boolean()
        .nullable()
        .optional()
        .describe("If true, walk subdirectories. Default false. Omit or pass null for default."),
      max_depth: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Maximum recursion depth when recursive=true. Default 3. Ignored when recursive=false. Omit or pass null for default.",
        ),
    }),
    async execute({ path, recursive, max_depth }) {
      const args: Record<string, unknown> = {};
      if (path != null) args.path = path;
      if (recursive != null) args.recursive = recursive;
      if (max_depth != null) args.max_depth = max_depth;
      const result = await executeArisClientTool("list_directory", args, ctx);
      return formatResult(result);
    },
  });

  return [readFile, writeFile, editFile, bash, grep, glob, listDirectory];
}
