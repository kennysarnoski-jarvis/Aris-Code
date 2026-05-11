/**
 * ArisClientTools - Tool executors for Aris's filesystem and shell tools.
 *
 * After the Slice 30 SDK migration, this module is executor-only: each
 * `executeXyz` function implements the actual work for a single tool
 * (read_file, write_file, edit_file, bash, grep, glob, list_directory).
 * The OpenAI Agents SDK schemas (with Zod parameter validation) live
 * in `ArisAgentTools.ts` and call into `executeArisClientTool` here
 * for the actual side effects.
 *
 * Removed in Slice 30d (still in git history):
 *   - `ARIS_CLIENT_TOOL_SCHEMAS` JSON-Schema array (replaced by Zod
 *     schemas in ArisAgentTools).
 *   - `approvalForTool` runtime-mode gating (deferred — needs
 *     re-implementation via SDK's needsApproval mechanism).
 *   - `canonicalItemTypeForTool` / `canonicalRequestTypeForTool` /
 *     `describeToolCall` UI label helpers (no longer consumed; the
 *     UI maps tool names to labels client-side via the chat events).
 *   - `ArisToolName` / `isArisClientTool` (only used by the legacy
 *     for-loop's name validation).
 *
 * @module ArisClientTools
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ArisToolContext {
  readonly cwd: string | undefined;
  readonly signal?: AbortSignal;
}

export interface ArisToolResult {
  readonly ok: boolean;
  readonly output: string;
}

function resolvePath(target: string, cwd: string | undefined): string {
  if (path.isAbsolute(target)) return target;
  if (!cwd) return path.resolve(target);
  return path.resolve(cwd, target);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

/**
 * Default-read line cap. When the model calls `read_file` without an
 * explicit `offset` or `limit`, we slice to this many lines and prepend
 * a `[truncated …]` header. Without the cap a single 10k-line file
 * would dump ~60k tokens into context and blow the window — Aris's
 * Qwen 3.6 context is 65k total, of which ~12k is already system prompt
 * + tool schemas, so even one large unconstrained read can be fatal.
 *
 * 2000 matches the convention in popular agent toolchains and covers
 * the typical code file in full while still hard-capping the runaway
 * case (auto-generated bundles, lock files, log files).
 */
const READ_FILE_DEFAULT_LIMIT_LINES = 2000;

async function executeReadFile(
  args: Record<string, unknown>,
  ctx: ArisToolContext,
): Promise<ArisToolResult> {
  const p = stringArg(args, "path");
  if (!p) return { ok: false, output: "Error: 'path' is required." };

  const rawOffset = args.offset;
  const rawLimit = args.limit;
  const offsetSupplied = typeof rawOffset === "number" && Number.isFinite(rawOffset);
  const limitSupplied = typeof rawLimit === "number" && Number.isFinite(rawLimit);
  const offset = offsetSupplied ? Math.max(1, Math.trunc(rawOffset as number)) : 1;
  // Big-file guardrail: when the caller passed NEITHER offset nor limit,
  // apply the default cap. Either one being supplied means the caller
  // is paging deliberately; honor their request unmodified.
  const explicitLimit = limitSupplied ? Math.max(1, Math.trunc(rawLimit as number)) : undefined;
  const effectiveLimit =
    explicitLimit ?? (offsetSupplied ? undefined : READ_FILE_DEFAULT_LIMIT_LINES);

  try {
    const resolved = resolvePath(p, ctx.cwd);
    const contents = await fs.readFile(resolved, "utf8");
    const lines = contents.split("\n");
    const totalLines = lines.length;
    const startIdx = offset - 1;
    const endIdx =
      effectiveLimit !== undefined ? Math.min(startIdx + effectiveLimit, totalLines) : totalLines;

    if (startIdx >= totalLines) {
      return {
        ok: false,
        output: `Error: offset ${offset} is past end of file (${totalLines} lines).`,
      };
    }

    const slice = lines.slice(startIdx, endIdx);
    const pad = String(endIdx).length;
    const numbered = slice
      .map((line, i) => `${String(startIdx + 1 + i).padStart(pad, " ")}→${line}`)
      .join("\n");

    // Header rules:
    //   - Caller supplied offset OR limit → standard "[lines X-Y of N]"
    //     (their intent was deliberate, no truncation framing needed).
    //   - Neither supplied AND file fit under the cap → no header.
    //   - Neither supplied AND file exceeded the cap → "[truncated …]"
    //     header tells the model the read was capped and how to continue.
    const explicitlySliced = offsetSupplied || limitSupplied;
    const guardrailTruncated = !explicitlySliced && totalLines > READ_FILE_DEFAULT_LIMIT_LINES;
    let header = "";
    if (explicitlySliced) {
      header = `[lines ${startIdx + 1}-${endIdx} of ${totalLines}]\n`;
    } else if (guardrailTruncated) {
      header =
        `[truncated — file is ${totalLines} lines, showing first ` +
        `${READ_FILE_DEFAULT_LIMIT_LINES}; call read_file again with ` +
        `offset=${endIdx + 1} to continue]\n`;
    }

    return { ok: true, output: header + numbered };
  } catch (err) {
    return { ok: false, output: `Error reading ${p}: ${(err as Error).message}` };
  }
}

async function executeWriteFile(
  args: Record<string, unknown>,
  ctx: ArisToolContext,
): Promise<ArisToolResult> {
  const p = stringArg(args, "path");
  const content = stringArg(args, "content");
  if (!p) return { ok: false, output: "Error: 'path' is required." };
  try {
    const resolved = resolvePath(p, ctx.cwd);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    return { ok: true, output: `Wrote ${content.length} bytes to ${p}.` };
  } catch (err) {
    return { ok: false, output: `Error writing ${p}: ${(err as Error).message}` };
  }
}

async function executeEditFile(
  args: Record<string, unknown>,
  ctx: ArisToolContext,
): Promise<ArisToolResult> {
  const p = stringArg(args, "path");
  const search = stringArg(args, "search");
  const replace = stringArg(args, "replace");
  const replaceAll = args.replace_all === true;
  if (!p) return { ok: false, output: "Error: 'path' is required." };
  if (!search) return { ok: false, output: "Error: 'search' must be non-empty." };
  try {
    const resolved = resolvePath(p, ctx.cwd);
    const original = await fs.readFile(resolved, "utf8");
    const occurrences = original.split(search).length - 1;
    if (occurrences === 0) {
      return { ok: false, output: `Error: search string not found in ${p}.` };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        output: `Error: search string appears ${occurrences} times in ${p}. Pass replace_all=true or provide more surrounding context to make the match unique.`,
      };
    }
    const updated = replaceAll
      ? original.split(search).join(replace)
      : original.replace(search, replace);
    await fs.writeFile(resolved, updated, "utf8");

    // Give the agent enough evidence to reason about progress on multi-file
    // tasks. Without a snippet + remaining count, Qwen can spiral in reasoning
    // trying to verify whether the edit actually landed.
    const replacedCount = replaceAll ? occurrences : 1;
    const remaining = updated.split(search).length - 1;
    const anchorIndex = updated.indexOf(replace);
    let snippet = "";
    if (replace.length > 0 && anchorIndex >= 0) {
      const lineStart = updated.lastIndexOf("\n", anchorIndex) + 1;
      const nextNewline = updated.indexOf("\n", anchorIndex + replace.length);
      const lineEnd = nextNewline === -1 ? updated.length : nextNewline;
      const rawLine = updated.slice(lineStart, lineEnd);
      snippet = rawLine.length > 240 ? `${rawLine.slice(0, 237)}...` : rawLine;
    }

    const lines = [
      `Replaced ${replacedCount} occurrence(s) in ${p}.`,
      `Remaining occurrences of search string: ${remaining}.`,
    ];
    if (snippet) {
      lines.push(`Edited line: ${snippet}`);
    }
    return {
      ok: true,
      output: lines.join("\n"),
    };
  } catch (err) {
    return { ok: false, output: `Error editing ${p}: ${(err as Error).message}` };
  }
}

async function executeBash(
  args: Record<string, unknown>,
  ctx: ArisToolContext,
): Promise<ArisToolResult> {
  const command = stringArg(args, "command");
  const timeoutMs =
    typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms)
      ? Math.max(1000, args.timeout_ms)
      : 120_000;
  if (!command) return { ok: false, output: "Error: 'command' is required." };

  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: ctx.cwd,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Process may already be dead.
      }
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Error spawning command: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parts = [
        stdout ? `stdout:\n${stdout}` : "",
        stderr ? `stderr:\n${stderr}` : "",
        killed ? `terminated: timeout after ${timeoutMs}ms` : `exit_code: ${code ?? -1}`,
      ].filter(Boolean);
      resolve({
        ok: !killed && code === 0,
        output: parts.join("\n\n") || "(no output)",
      });
    });
  });
}

async function executeRipgrep(
  rgArgs: ReadonlyArray<string>,
  ctx: ArisToolContext,
  noMatchExitCode: number,
): Promise<ArisToolResult> {
  return new Promise((resolve) => {
    const child = spawn("rg", [...rgArgs], {
      cwd: ctx.cwd,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      resolve({ ok: false, output: `Error running rg: ${err.message}` });
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, output: stdout || "(no matches)" });
      else if (code === noMatchExitCode) resolve({ ok: true, output: "(no matches)" });
      else resolve({ ok: false, output: stderr || `rg exited with code ${code}` });
    });
  });
}

async function executeGrep(
  args: Record<string, unknown>,
  ctx: ArisToolContext,
): Promise<ArisToolResult> {
  const pattern = stringArg(args, "pattern");
  const searchPath = stringArg(args, "path") || ".";
  const glob = stringArg(args, "glob");
  const caseInsensitive = args.case_insensitive === true;
  if (!pattern) return { ok: false, output: "Error: 'pattern' is required." };

  // Safety flags: cap each matching line at 300 columns, cap matches-per-file
  // at 50. Prevents unminified JSON / JSONL / giant single-line files from
  // dumping megabytes into the conversation (which is exactly how we got a
  // 13MB grep result poisoning the DB — never again).
  const rgArgs: string[] = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--max-columns",
    "300",
    "--max-count",
    "50",
  ];
  if (caseInsensitive) rgArgs.push("-i");
  if (glob) rgArgs.push("--glob", glob);
  rgArgs.push("--", pattern, searchPath);

  const result = await executeRipgrep(rgArgs, ctx, 1);

  // Final hard ceiling on total tool output — no single tool call can ever
  // return more than 20KB of text regardless of how permissive rg's flags are.
  const MAX_CHARS = 20_000;
  if (result.output.length > MAX_CHARS) {
    const kept = result.output.slice(0, MAX_CHARS);
    const dropped = result.output.length - MAX_CHARS;
    return {
      ok: result.ok,
      output: `${kept}\n\n[... truncated ${dropped.toLocaleString()} more chars. Narrow your search with --glob or a more specific pattern.]`,
    };
  }
  return result;
}

async function executeGlob(
  args: Record<string, unknown>,
  ctx: ArisToolContext,
): Promise<ArisToolResult> {
  const pattern = stringArg(args, "pattern");
  const searchPath = stringArg(args, "path") || ".";
  if (!pattern) return { ok: false, output: "Error: 'pattern' is required." };

  const rootCtx: ArisToolContext = { cwd: resolvePath(searchPath, ctx.cwd) };
  if (ctx.signal) {
    (rootCtx as { signal?: AbortSignal }).signal = ctx.signal;
  }
  return executeRipgrep(["--files", "--glob", pattern], rootCtx, 1);
}

/**
 * Directories that are skipped when walking recursively. Present them at the
 * top level if the user asks for them explicitly, but don't descend into them
 * — they're almost always noise (or huge).
 */
const LIST_DIRECTORY_SKIP: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  "__pycache__",
  ".venv",
  ".turbo",
  ".cache",
]);

async function walkDirectory(
  root: string,
  maxDepth: number,
  depth: number,
  prefix: string,
): Promise<string[]> {
  if (depth >= maxDepth) return [];
  const out: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const relPath = prefix + entry.name;
    if (entry.isDirectory()) {
      out.push(relPath + "/");
      if (!LIST_DIRECTORY_SKIP.has(entry.name) && depth + 1 < maxDepth) {
        const children = await walkDirectory(entryPath, maxDepth, depth + 1, relPath + "/");
        out.push(...children);
      }
    } else {
      out.push(relPath);
    }
  }
  return out;
}

async function executeListDirectory(
  args: Record<string, unknown>,
  ctx: ArisToolContext,
): Promise<ArisToolResult> {
  const p = stringArg(args, "path") || ".";
  const recursive = args.recursive === true;
  const rawMaxDepth = args.max_depth;
  const maxDepth = recursive
    ? typeof rawMaxDepth === "number" && Number.isFinite(rawMaxDepth)
      ? Math.max(1, Math.min(10, Math.trunc(rawMaxDepth)))
      : 3
    : 1;
  try {
    const resolved = resolvePath(p, ctx.cwd);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, output: `Error: ${p} is not a directory.` };
    }
    const entries = await walkDirectory(resolved, maxDepth, 0, "");
    if (entries.length === 0) return { ok: true, output: "(empty directory)" };
    return { ok: true, output: entries.join("\n") };
  } catch (err) {
    return { ok: false, output: `Error listing ${p}: ${(err as Error).message}` };
  }
}

/**
 * Dispatch an Aris client tool call to its executor.
 *
 * Always resolves — never throws. Errors are returned as `{ ok: false, output }`
 * so the model can read them and recover.
 */
export async function executeArisClientTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ArisToolContext,
): Promise<ArisToolResult> {
  switch (name) {
    case "read_file":
      return executeReadFile(args, ctx);
    case "write_file":
      return executeWriteFile(args, ctx);
    case "edit_file":
      return executeEditFile(args, ctx);
    case "bash":
      return executeBash(args, ctx);
    case "grep":
      return executeGrep(args, ctx);
    case "glob":
      return executeGlob(args, ctx);
    case "list_directory":
      return executeListDirectory(args, ctx);
    default:
      return { ok: false, output: `Unknown tool: ${name}` };
  }
}
