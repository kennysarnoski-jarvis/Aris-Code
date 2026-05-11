/**
 * DeepSeekArchiveTools — DS-specific tools for querying the rolling-
 * window archive layer (RW-6 of the rolling-window memory system).
 *
 * Three tools for retrieving content from prior windows that the
 * rollup summary glossed over:
 *
 *   - `list_archives` — metadata about every archived window in this
 *     thread. Cheap, always available.
 *   - `search_archives` — keyword/regex grep across all archived
 *     transcripts. Returns matching messages with surrounding context.
 *     Handles ~80% of "what did we discuss about X" lookups.
 *   - `read_archive_range` — pull a specific message range from a
 *     specific window. The escape hatch when search snippets aren't
 *     enough and DS needs to see conversation flow around a moment.
 *
 * Scope: per-thread only for V1 (cross-thread search would bring
 * memdir into the picture and gets messier). Each tool reads from
 * `~/.aris/projects/<project-key>/sessions/<thread-id>/window_NNN.jsonl`
 * via path helpers in `RollingWindowMemory`.
 *
 * NOT registered for Aris-provider threads — Aris uses `aris_memory.db`
 * (graph store) and has no rolling-window archives. Adding these tools
 * would just confuse the Aris model.
 *
 * @module DeepSeekArchiveTools
 */
import { promises as fs } from "node:fs";
import { tool } from "@openai/agents";
import { z } from "zod";

import {
  getArchivedWindowPath,
  getThreadArchiveDir,
  type PersistedMessage,
} from "./RollingWindowMemory.ts";

export interface ArchiveToolsContext {
  /** Workspace cwd — used to locate `~/.aris/projects/<key>/...`. */
  readonly cwd: string;
  /** Thread id — selects the per-thread archive directory. */
  readonly threadId: string;
}

const SUMMARY_SUFFIX = ".summary.md";
const WINDOW_PREFIX = "window_";
const WINDOW_SUFFIX = ".jsonl";

interface ArchiveWindowMetadata {
  readonly windowIndex: number;
  readonly archivedPath: string;
  readonly summaryPath: string | null;
  readonly bytes: number;
  readonly lineCount: number;
  readonly approxTokens: number;
  readonly firstTimestamp: string | null;
  readonly lastTimestamp: string | null;
  readonly summaryPreview: string | null;
}

/**
 * Read all archived window files in this thread's directory and
 * extract metadata. Used by `list_archives` and as a building block
 * for `search_archives`.
 */
async function listArchivedWindows(ctx: ArchiveToolsContext): Promise<ArchiveWindowMetadata[]> {
  const dir = getThreadArchiveDir(ctx.cwd, ctx.threadId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const windowIndices = new Set<number>();
  for (const name of entries) {
    if (!name.startsWith(WINDOW_PREFIX)) continue;
    if (!name.endsWith(WINDOW_SUFFIX)) continue;
    const middle = name.slice(WINDOW_PREFIX.length, -WINDOW_SUFFIX.length);
    const n = Number.parseInt(middle, 10);
    if (Number.isFinite(n) && n > 0) windowIndices.add(n);
  }
  const sortedIndices = Array.from(windowIndices).sort((a, b) => a - b);
  const result: ArchiveWindowMetadata[] = [];
  for (const idx of sortedIndices) {
    const archivedPath = getArchivedWindowPath(ctx.cwd, ctx.threadId, idx);
    const padded = String(idx).padStart(3, "0");
    const summaryPath = `${dir}/window_${padded}${SUMMARY_SUFFIX}`;
    let bytes = 0;
    let lineCount = 0;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;
    try {
      const stat = await fs.stat(archivedPath);
      bytes = stat.size;
      const raw = await fs.readFile(archivedPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      lineCount = lines.length;
      const firstLine = lines[0];
      const lastLine = lines[lines.length - 1];
      if (firstLine) {
        try {
          firstTimestamp = (JSON.parse(firstLine) as PersistedMessage).timestamp ?? null;
        } catch {
          // Skip — corrupt header line.
        }
      }
      if (lastLine && lastLine !== firstLine) {
        try {
          lastTimestamp = (JSON.parse(lastLine) as PersistedMessage).timestamp ?? null;
        } catch {
          // Skip — corrupt tail line.
        }
      }
    } catch {
      // Skip windows we can't stat/read.
    }
    let summaryPreview: string | null = null;
    let summaryExists = false;
    try {
      const summaryRaw = await fs.readFile(summaryPath, "utf8");
      summaryExists = true;
      // First ~200 chars of the summary as a preview to help DS pick.
      summaryPreview = summaryRaw.length > 200 ? summaryRaw.slice(0, 200) + "…" : summaryRaw;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Permission or other read issue — note it but don't fail the
        // listing; the caller can still see the archive exists.
      }
    }
    result.push({
      windowIndex: idx,
      archivedPath,
      summaryPath: summaryExists ? summaryPath : null,
      bytes,
      lineCount,
      approxTokens: Math.ceil(bytes / 4),
      firstTimestamp,
      lastTimestamp,
      summaryPreview,
    });
  }
  return result;
}

/** Read every persisted message in an archived window file. */
async function readArchivedWindowMessages(path: string): Promise<PersistedMessage[]> {
  const raw = await fs.readFile(path, "utf8");
  const out: PersistedMessage[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as PersistedMessage;
      if (
        (parsed.role === "user" || parsed.role === "assistant") &&
        typeof parsed.content === "string"
      ) {
        out.push(parsed);
      }
    } catch {
      // Skip corrupt lines.
    }
  }
  return out;
}

/** Format a single message as a labeled snippet for tool output. */
function formatMessage(
  msg: PersistedMessage,
  windowIndex: number,
  msgIndex: number,
  maxContentChars = 800,
): string {
  const truncated =
    msg.content.length > maxContentChars
      ? msg.content.slice(0, maxContentChars) + "…[truncated]"
      : msg.content;
  return `[window_${windowIndex}, msg_${msgIndex}, ${msg.timestamp}] ${msg.role.toUpperCase()}: ${truncated}`;
}

/**
 * Build the `list_archives`, `search_archives`, and
 * `read_archive_range` tools. Returns an array suitable to concat
 * onto the base Aris tool list in `DeepSeekAgentTools`.
 */
export function createDeepSeekArchiveTools(ctx: ArchiveToolsContext) {
  // ── list_archives ──────────────────────────────────────────────
  const listArchives = tool({
    name: "list_archives",
    description:
      "List metadata about every archived rolling-window in this thread. " +
      "Each window is a frozen transcript from before the most recent " +
      "rollover (the active conversation grew past the rolling-window " +
      "threshold and was archived). Returns window index, byte size, " +
      "approximate token count, message line count, time range, and a " +
      "preview of the rollup summary if one exists. Use this to orient " +
      "yourself before calling search_archives or read_archive_range.",
    parameters: z.object({}),
    async execute() {
      const windows = await listArchivedWindows(ctx);
      if (windows.length === 0) {
        return "No archived windows yet for this thread. The current conversation is still in the active window — no rollover has fired.";
      }
      const lines: string[] = [`Found ${windows.length} archived window(s):`, ""];
      for (const w of windows) {
        lines.push(`window_${w.windowIndex}:`);
        lines.push(`  bytes: ${w.bytes}, ~${w.approxTokens} tokens, ${w.lineCount} message lines`);
        if (w.firstTimestamp) lines.push(`  first message: ${w.firstTimestamp}`);
        if (w.lastTimestamp) lines.push(`  last message: ${w.lastTimestamp}`);
        if (w.summaryPath) {
          lines.push(`  summary: present`);
          if (w.summaryPreview) {
            lines.push(`  summary preview: ${w.summaryPreview.replace(/\n/g, " ")}`);
          }
        } else {
          lines.push(`  summary: missing (background generation may still be running)`);
        }
        lines.push("");
      }
      return lines.join("\n");
    },
  });

  // ── search_archives ────────────────────────────────────────────
  const searchArchives = tool({
    name: "search_archives",
    description:
      "Search the archived rolling-window transcripts for messages " +
      "matching a query. Substring match by default; pass `regex: true` " +
      "to interpret the query as a regular expression. Returns matched " +
      "messages prefixed with `[window_N, msg_M, timestamp] ROLE:`. " +
      "Use this when the rollup summary glossed over a detail you need " +
      "to recover from earlier in the conversation. Scoped to this " +
      "thread only — does not search other threads.",
    parameters: z.object({
      query: z.string().describe("Search string. Substring match unless `regex: true` is passed."),
      regex: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "If true, interpret `query` as a regular expression. Default false. Omit or pass null for default.",
        ),
      max_results: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Maximum number of matched messages to return. Default 20. Omit or pass null for default.",
        ),
    }),
    async execute({ query, regex, max_results }) {
      const useRegex = regex === true;
      const cap = typeof max_results === "number" && max_results > 0 ? max_results : 20;
      let matcher: (text: string) => boolean;
      if (useRegex) {
        try {
          const re = new RegExp(query, "i");
          matcher = (text) => re.test(text);
        } catch (err) {
          return `Invalid regex \`${query}\`: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        const lower = query.toLowerCase();
        matcher = (text) => text.toLowerCase().includes(lower);
      }
      const windows = await listArchivedWindows(ctx);
      if (windows.length === 0) {
        return "No archived windows yet — nothing to search. The current conversation is still in the active window.";
      }
      const matches: string[] = [];
      let totalScanned = 0;
      for (const w of windows) {
        if (matches.length >= cap) break;
        const messages = await readArchivedWindowMessages(w.archivedPath);
        for (let i = 0; i < messages.length; i += 1) {
          totalScanned += 1;
          const m = messages[i];
          if (m && matcher(m.content)) {
            matches.push(formatMessage(m, w.windowIndex, i));
            if (matches.length >= cap) break;
          }
        }
      }
      if (matches.length === 0) {
        return `No matches for ${useRegex ? "regex" : "substring"} \`${query}\` across ${totalScanned} archived messages in ${windows.length} window(s).`;
      }
      const header = `Found ${matches.length} match${matches.length === 1 ? "" : "es"} for ${useRegex ? "regex" : "substring"} \`${query}\` (capped at ${cap}, scanned ${totalScanned} messages):`;
      return [header, "", ...matches].join("\n\n");
    },
  });

  // ── read_archive_range ─────────────────────────────────────────
  const readArchiveRange = tool({
    name: "read_archive_range",
    description:
      "Pull a specific range of messages from a specific archived " +
      "window. Use this after list_archives or search_archives to see " +
      "the conversation flow around a moment in detail. Message indices " +
      "are 0-based within the window; both start and end are inclusive. " +
      "If end_msg is omitted, reads from start_msg to the end of the window.",
    parameters: z.object({
      window_index: z
        .number()
        .int()
        .describe("Index of the archived window (1, 2, 3, ...). See list_archives output."),
      start_msg: z.number().int().describe("0-based index of the first message to return."),
      end_msg: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "0-based inclusive end. Omit or pass null to read to the end of the window. Hard cap of 50 messages per call.",
        ),
    }),
    async execute({ window_index, start_msg, end_msg }) {
      if (window_index < 1) {
        return "Invalid window_index — must be ≥ 1. Use list_archives to see available windows.";
      }
      if (start_msg < 0) {
        return "Invalid start_msg — must be ≥ 0.";
      }
      const archivedPath = getArchivedWindowPath(ctx.cwd, ctx.threadId, window_index);
      let messages: PersistedMessage[];
      try {
        messages = await readArchivedWindowMessages(archivedPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return `Window ${window_index} does not exist. Use list_archives to see available windows.`;
        }
        throw err;
      }
      if (start_msg >= messages.length) {
        return `start_msg ${start_msg} is past end of window (${messages.length} messages total).`;
      }
      const HARD_CAP = 50;
      const requestedEnd = typeof end_msg === "number" ? end_msg : messages.length - 1;
      const clampedEnd = Math.min(requestedEnd, messages.length - 1, start_msg + HARD_CAP - 1);
      const slice = messages.slice(start_msg, clampedEnd + 1);
      const lines: string[] = [
        `window_${window_index}, messages ${start_msg}..${clampedEnd} (${slice.length} of ${messages.length} total in this window):`,
        "",
      ];
      for (let i = 0; i < slice.length; i += 1) {
        const m = slice[i];
        if (m) {
          lines.push(formatMessage(m, window_index, start_msg + i, 2000));
        }
      }
      if (clampedEnd < requestedEnd) {
        lines.push("");
        lines.push(
          `Note: requested end_msg=${requestedEnd} was capped at ${clampedEnd} (50-message hard cap per call). Call again with start_msg=${clampedEnd + 1} to continue.`,
        );
      }
      return lines.join("\n\n");
    },
  });

  return [listArchives, searchArchives, readArchiveRange];
}
