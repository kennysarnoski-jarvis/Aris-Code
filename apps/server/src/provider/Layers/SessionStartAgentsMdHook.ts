/**
 * SessionStart hook — AGENTS.md / ARIS.md project-convention injection.
 *
 * Reads project-level agent conventions from the workspace root and
 * injects them into the system prompt at session start. Follows the
 * same SessionStart hook contract as `session-start-cross-thread`:
 * returns `{ inject: <fullBlock> }` when conventions exist, `{}`
 * when no convention file is found.
 *
 * Resolution priority (first match wins):
 *   1. `./ARIS.md` — Aris-specific conventions (highest priority)
 *   2. `./AGENTS.md` — universal agent conventions (fallback)
 *
 * Both files sit at the project root (cwd). The `.aris/AGENTS.md`
 * variant (like `.claude/CLAUDE.md`) is deferred — we can add it to
 * the resolution list when there's a demonstrated need.
 *
 * The injection block includes:
 *   - A header explaining what the block is and where it came from
 *   - The raw file contents verbatim
 *
 * Error handling matches the cross-thread hook's convention: file
 * read failures don't block session start. The hook catches them and
 * returns `{}` so the session proceeds without project conventions.
 *
 * @module SessionStartAgentsMdHook
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { HookSpec, SessionStartContext, SessionStartResult } from "./HookTypes.ts";

/**
 * Priority for this hook. Runs BEFORE the cross-thread hook (100) so
 * the system-prompt narrative order is:
 *   - CWD context (adapter-injected, not a hook)
 *   - Project conventions (ARIS.md / AGENTS.md)
 *   - Cross-thread memory (prior thread briefing)
 *   - Session state (scratchpad, todos, facts)
 *
 * priority=80 puts it ahead of cross-thread (priority=100).
 */
const HOOK_PRIORITY = 80;

const HOOK_NAME = "session-start-agents-md";

/**
 * Files to check, in priority order. First one that exists and is
 * readable wins — we don't merge multiple files. The list comes from
 * Claude Code's convention (CLAUDE.md) adapted for Aris:
 * `ARIS.md` takes precedence over the universal `AGENTS.md`.
 */
const CONVENTION_FILES = ["ARIS.md", "AGENTS.md"] as const;

/**
 * Render the raw file contents as a system-context injection block.
 * The header tells the model what it's reading and that it's a
 * project-level convention file — the model should internalize these
 * rules for the life of the session.
 */
export function renderAgentsMdBlock(fileName: string, content: string): string {
  return (
    `## Project conventions (${fileName})\n\n` +
    "The content below is the project's agent conventions file. " +
    "It describes how this codebase is structured, how to build " +
    "and test it, coding conventions, and any other rules you " +
    "should follow while working in this project. Read it once — " +
    "these rules are stable for the life of this session.\n\n" +
    "If the conventions conflict with your default behavior, the " +
    "conventions win. This file is the project maintainer's " +
    "authoritative specification for how you should work here.\n\n" +
    content
  );
}

/**
 * Resolve and read the first available convention file. Returns
 * `{ fileName, content }` on success, `null` when no convention
 * file exists or all reads fail.
 *
 * Security note: only reads files named `ARIS.md` or `AGENTS.md`
 * directly under `cwd` — no path traversal, no symlink following
 * beyond what the OS gives us. The file list is a compile-time
 * constant, so injection via env is impossible.
 */
export async function resolveAgentsMd(
  cwd: string,
): Promise<{ fileName: string; content: string } | null> {
  for (const fileName of CONVENTION_FILES) {
    const filePath = path.join(cwd, fileName);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(filePath, "utf-8");
      const trimmed = content.trim();
      if (trimmed.length === 0) continue; // empty file = skip
      return { fileName, content: trimmed };
    } catch {
      // ENOENT, EACCES, etc. — try next file
      continue;
    }
  }
  return null;
}

/**
 * Factory: produce a SessionStart hook spec that reads project
 * conventions from the workspace root. No external dependencies —
 * the hook only needs `ctx.cwd`.
 *
 * Register on adapter setup:
 * ```ts
 * hookBus.register(makeSessionStartAgentsMdHook());
 * ```
 */
export function makeSessionStartAgentsMdHook(): Extract<HookSpec, { event: "SessionStart" }> {
  return {
    event: "SessionStart",
    name: HOOK_NAME,
    priority: HOOK_PRIORITY,
    handler: async (ctx: SessionStartContext): Promise<SessionStartResult> => {
      // No cwd → no project → no conventions to read.
      if (!ctx.cwd) {
        return {};
      }

      let resolved: { fileName: string; content: string } | null;
      try {
        resolved = await resolveAgentsMd(ctx.cwd);
      } catch (err) {
        // Catch-all: fs module-level failure (shouldn't happen, but
        // we don't want to block session start on anything).
        console.warn(`[${HOOK_NAME}] resolution failed: ${(err as Error).message}`);
        return {};
      }

      if (resolved === null) {
        return {};
      }

      return { inject: renderAgentsMdBlock(resolved.fileName, resolved.content) };
    },
  };
}
