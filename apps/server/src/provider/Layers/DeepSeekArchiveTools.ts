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
  type RollingWindowConfig,
  type PersistedMessage,
} from "./RollingWindowMemory.ts";

export interface ArchiveToolsContext {
  /** Workspace cwd — used to locate `~/.aris/projects/<key>/...`. */
  readonly cwd: string;
  /** Thread id — selects the per-thread archive directory. */
  readonly threadId: string;
  /**
   * Slice L / M3-2 — resolved rolling-window paths constructed at
   * adapter startup. Threaded through here so archive tool calls
   * don't reach for `homedir()` implicitly. See `RollingWindowConfig`.
   */
  readonly rollingWindowConfig: RollingWindowConfig;
}

const SUMMARY_SUFFIX = ".summary.md";
const WINDOW_PREFIX = "window_";
const WINDOW_SUFFIX = ".jsonl";

/**
 * Slice D / H13 fix (2026-05-16) — ReDoS hardening for `search_archives`.
 *
 * Pre-Slice-D, `search_archives` accepted `regex: true` and fed the
 * model-controlled query straight into `new RegExp(query, "i").test(...)`
 * against archived message content. A pathological pattern like
 * `(a+)+b` against a long string of `a`'s causes catastrophic
 * backtracking in V8's regex engine, blocking the event loop
 * indefinitely. Because the regex flag is model-controlled and the
 * scanned content includes any text the model has ever produced or
 * received, the attack surface is real even in local mode — a single
 * malicious prompt-injection lodged in earlier conversation could
 * later be searched with a regex that hangs the server on every
 * subsequent `search_archives` call.
 *
 * Three layered defenses below:
 *
 *   1. `SEARCH_ARCHIVES_REGEX_MAX_PATTERN_LENGTH` caps the raw query
 *      length when `regex: true`. Generous enough for legitimate
 *      patterns (`\bfoo\b`, `^prefix.*`, etc.) — tight enough that
 *      sprawling adversarial constructions are refused at the door.
 *
 *   2. `checkRegexSafety` runs a star-height ≤ 1 analysis on the
 *      pattern before compilation. The canonical exponential-ReDoS
 *      class — nested unbounded quantifiers like `(a+)+`, `(a*)*`,
 *      `((b*))*`, `((\d+)+)+` — is rejected statically with a clear
 *      error returned to the model.
 *
 *   3. `SEARCH_ARCHIVES_MAX_SCAN_CHARS_PER_MESSAGE` caps the number
 *      of content characters each individual message contributes to
 *      the matcher. Star-height analysis only catches the exponential
 *      class; the polynomial class (alternation with overlapping
 *      branches, e.g. `(a|aa)+`) can still slip through. Bounding the
 *      per-message scan length bounds the polynomial work too.
 *
 * Substring matching is unaffected — `String.prototype.includes` is
 * O(n + m) and not vulnerable to ReDoS. The cap on scan length still
 * applies for symmetry / memory bounds, but no pattern check is needed.
 */
export const SEARCH_ARCHIVES_REGEX_MAX_PATTERN_LENGTH = 200;
export const SEARCH_ARCHIVES_MAX_SCAN_CHARS_PER_MESSAGE = 32_768;

export type RegexSafetyResult =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: string };

/**
 * Returns `{ safe: true }` if the pattern passes our static ReDoS
 * checks: length cap + star-height ≤ 1 (no nested unbounded
 * quantifiers). Returns `{ safe: false, reason }` otherwise.
 *
 * The analysis walks the pattern character-by-character, tracking
 * paren depth and whether each open group's body has yet seen an
 * unbounded quantifier (`*`, `+`, `{N,}`). When a group closes and is
 * immediately followed by an unbounded quantifier, we have a nested
 * unbounded-quantifier construct — the shape that produces
 * exponential backtracking. Reject.
 *
 * Bounded quantifiers (`?`, `{N}`, `{N,M}`) are treated as safe —
 * they cap repetition, so backtracking is bounded too.
 *
 * Escape sequences (`\\X`), character classes (`[...]`), and
 * non-capturing / lookaround group prefixes (`(?:`, `(?=`, `(?!`,
 * `(?<=`, `(?<!`, `(?<name>`) are skipped without affecting the
 * star-height tracking.
 *
 * Not a complete ReDoS classifier — polynomial-class patterns
 * (alternation with overlap) pass this check. The
 * `SEARCH_ARCHIVES_MAX_SCAN_CHARS_PER_MESSAGE` cap is the second
 * layer that bounds polynomial-class work.
 */
export function checkRegexSafety(pattern: string): RegexSafetyResult {
  if (pattern.length === 0) {
    return { safe: false, reason: "empty regex pattern" };
  }
  if (pattern.length > SEARCH_ARCHIVES_REGEX_MAX_PATTERN_LENGTH) {
    return {
      safe: false,
      reason: `regex pattern too long (${pattern.length} chars, max ${SEARCH_ARCHIVES_REGEX_MAX_PATTERN_LENGTH})`,
    };
  }
  // groupStack[i] = "has the body of the i-th open group seen any
  // unbounded quantifier so far?". Index 0 is the implicit top-level
  // group. Push on `(`, pop on `)`.
  const groupStack: boolean[] = [false];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "\\") {
      // Escape sequence — next char is literal regardless of meaning.
      i += 2;
      continue;
    }

    if (ch === "[") {
      // Character class — quantifier semantics inside the class are
      // different (the `+` inside `[a+]` is just a literal `+`). Skip
      // past the closing `]`, handling escaped `]` inside.
      i += 1;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i += 1;
        i += 1;
      }
      i += 1; // skip the `]`
      continue;
    }

    if (ch === "(") {
      groupStack.push(false);
      i += 1;
      // Skip group prefixes so the `?` / `=` / `!` chars inside don't
      // get mistaken for quantifiers when we resume the main loop.
      if (pattern[i] === "?") {
        i += 1;
        if (pattern[i] === "<") {
          // (?<= , (?<! , or (?<name> — skip to the terminator.
          i += 1;
          while (
            i < pattern.length &&
            pattern[i] !== ">" &&
            pattern[i] !== "=" &&
            pattern[i] !== "!"
          ) {
            i += 1;
          }
          i += 1; // skip the terminator
        } else {
          // (?: , (?= , (?! — skip the single discriminator char.
          i += 1;
        }
      }
      continue;
    }

    if (ch === ")") {
      const innerHasUnbounded = groupStack.pop() ?? false;
      i += 1;
      const next = i < pattern.length ? pattern[i] : undefined;
      const groupQuantifiedUnbounded =
        next === "*" || next === "+" || (next === "{" && isUnboundedRepetition(pattern, i));
      if (groupQuantifiedUnbounded) {
        if (innerHasUnbounded) {
          return {
            safe: false,
            reason: "regex has nested unbounded quantifier (ReDoS risk)",
          };
        }
        // The whole group becomes an unbounded-quantified atom in its
        // parent body.
        if (groupStack.length > 0) {
          groupStack[groupStack.length - 1] = true;
        }
      } else if (innerHasUnbounded) {
        // Bounded or no quantifier on this group, but the body did
        // contain unbounded repetition — propagate so a later outer
        // quantifier on a parent group still trips the check.
        if (groupStack.length > 0) {
          groupStack[groupStack.length - 1] = true;
        }
      }
      continue;
    }

    if (ch === "*" || ch === "+") {
      if (groupStack.length > 0) {
        groupStack[groupStack.length - 1] = true;
      }
      i += 1;
      continue;
    }

    if (ch === "{") {
      // `{N}` or `{N,M}` are bounded — safe. `{N,}` is unbounded —
      // treat like `*`. We skip past the closing `}` either way.
      if (isUnboundedRepetition(pattern, i) && groupStack.length > 0) {
        groupStack[groupStack.length - 1] = true;
      }
      while (i < pattern.length && pattern[i] !== "}") i += 1;
      i += 1;
      continue;
    }

    // Anything else (literals, anchors, `|`, bounded-quantifier `?`,
    // non-greedy modifier `?`) does not contribute to star-height.
    i += 1;
  }
  return { safe: true };
}

/**
 * Helper for `checkRegexSafety` — returns true iff the `{...}` block
 * starting at `openIdx` is the unbounded form `{N,}` (comma followed
 * directly by `}`). `{N}` and `{N,M}` return false.
 */
function isUnboundedRepetition(pattern: string, openIdx: number): boolean {
  let j = openIdx + 1;
  while (j < pattern.length && pattern[j] !== "}") {
    if (pattern[j] === ",") {
      // Skip optional whitespace after the comma (uncommon, but valid
      // in some regex dialects) and check for the closing brace.
      let k = j + 1;
      while (k < pattern.length && pattern[k] === " ") k += 1;
      return pattern[k] === "}";
    }
    j += 1;
  }
  return false;
}

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
async function listArchivedWindows(
  ctx: ArchiveToolsContext,
  resolvedThreadId: string,
): Promise<ArchiveWindowMetadata[]> {
  const dir = getThreadArchiveDir(ctx.rollingWindowConfig, ctx.cwd, resolvedThreadId);
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
    const archivedPath = getArchivedWindowPath(
      ctx.rollingWindowConfig,
      ctx.cwd,
      resolvedThreadId,
      idx,
    );
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
  // Slice X.3 — resolve the thread_id arg for cross-thread archive
  // queries. When the model omits `thread_id` (or passes null), we
  // default to the current thread. When provided, we hand it to
  // `getThreadArchiveDir` which calls `assertSafeThreadId` — any
  // unsafe slug throws there and we surface the message to the
  // model so it can correct. The directory existence check happens
  // implicitly: the listing path returns [] for a missing dir, so
  // the model sees "no archived windows" rather than a hard error
  // when it asks about a thread that hasn't rolled over.
  //
  // Path-traversal / cross-project safety: `getThreadArchiveDir` is
  // rooted at `<arisHomeDir>/projects/<projectKey>/sessions/` where
  // projectKey derives from ctx.cwd. The thread_id only varies the
  // final path segment, and `assertSafeThreadId` rejects any value
  // containing `/`, `\`, `..`, NUL, or anything outside
  // `[A-Za-z0-9_-]+`. The model cannot navigate out of the project's
  // sessions directory regardless of what string it passes.
  const resolveThreadId = (requested: string | null | undefined): string =>
    typeof requested === "string" && requested.length > 0 ? requested : ctx.threadId;

  // ── list_archives ──────────────────────────────────────────────
  const listArchives = tool({
    name: "list_archives",
    description:
      "List metadata about every archived rolling-window in a thread. " +
      "Each window is a frozen transcript from before the most recent " +
      "rollover (the active conversation grew past the rolling-window " +
      "threshold and was archived). Returns window index, byte size, " +
      "approximate token count, message line count, time range, and a " +
      "preview of the rollup summary if one exists. Use this to orient " +
      "yourself before calling search_archives or read_archive_range.\n\n" +
      "Defaults to the CURRENT thread. Pass `thread_id` to query a " +
      "different thread in the same project — useful when the prior-" +
      "thread briefing in the system prompt mentions a thread you " +
      "want to dig into.",
    parameters: z.object({
      thread_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional. Other thread's id to query (same project). Omit or pass null for the current thread.",
        ),
    }),
    async execute({ thread_id }) {
      const resolvedThreadId = resolveThreadId(thread_id);
      let windows;
      try {
        windows = await listArchivedWindows(ctx, resolvedThreadId);
      } catch (err) {
        return `Refused unsafe thread_id \`${thread_id}\`: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (windows.length === 0) {
        return `No archived windows yet for thread \`${resolvedThreadId}\`. ${
          resolvedThreadId === ctx.threadId
            ? "The current conversation is still in the active window — no rollover has fired."
            : "That thread either doesn't exist in this project or hasn't rolled over yet."
        }`;
      }
      const lines: string[] = [
        `Found ${windows.length} archived window(s) in thread \`${resolvedThreadId}\`:`,
        "",
      ];
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
      "matching a query. Substring match by default (case-insensitive); " +
      "pass `regex: true` to interpret the query as a regular expression. " +
      "Regex patterns must be ≤200 chars and free of nested unbounded " +
      "quantifiers (e.g. `(a+)+`) — those are refused as ReDoS-unsafe; " +
      "use substring search instead. Returns matched messages prefixed " +
      "with `[window_N, msg_M, timestamp] ROLE:`. Use this when the " +
      "rollup summary glossed over a detail you need to recover from " +
      "earlier in the conversation.\n\n" +
      "Defaults to the CURRENT thread. Pass `thread_id` to search a " +
      "different thread in the same project — useful when the prior-" +
      "thread briefing references something you want to find.",
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
      thread_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional. Other thread's id to search (same project). Omit or pass null for the current thread.",
        ),
    }),
    async execute({ query, regex, max_results, thread_id }) {
      const resolvedThreadId = resolveThreadId(thread_id);
      const useRegex = regex === true;
      const cap = typeof max_results === "number" && max_results > 0 ? max_results : 20;
      let matcher: (text: string) => boolean;
      if (useRegex) {
        // Slice D / H13 — gate the regex path on a static ReDoS check
        // BEFORE compiling. Catches the exponential-backtracking class
        // (nested unbounded quantifiers) and oversize patterns; the
        // per-message scan cap below bounds polynomial-class work.
        const safety = checkRegexSafety(query);
        if (!safety.safe) {
          return `Refused unsafe regex \`${query}\`: ${safety.reason}. Try substring search (\`regex: false\` or omit) — that path is not vulnerable.`;
        }
        try {
          const re = new RegExp(query, "i");
          matcher = (text) =>
            re.test(
              text.length > SEARCH_ARCHIVES_MAX_SCAN_CHARS_PER_MESSAGE
                ? text.slice(0, SEARCH_ARCHIVES_MAX_SCAN_CHARS_PER_MESSAGE)
                : text,
            );
        } catch (err) {
          return `Invalid regex \`${query}\`: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        const lower = query.toLowerCase();
        matcher = (text) => {
          const scan =
            text.length > SEARCH_ARCHIVES_MAX_SCAN_CHARS_PER_MESSAGE
              ? text.slice(0, SEARCH_ARCHIVES_MAX_SCAN_CHARS_PER_MESSAGE)
              : text;
          return scan.toLowerCase().includes(lower);
        };
      }
      let windows;
      try {
        windows = await listArchivedWindows(ctx, resolvedThreadId);
      } catch (err) {
        return `Refused unsafe thread_id \`${thread_id}\`: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (windows.length === 0) {
        return `No archived windows yet for thread \`${resolvedThreadId}\` — nothing to search.`;
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
      thread_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional. Other thread's id to read from (same project). Omit or pass null for the current thread.",
        ),
    }),
    async execute({ window_index, start_msg, end_msg, thread_id }) {
      if (window_index < 1) {
        return "Invalid window_index — must be ≥ 1. Use list_archives to see available windows.";
      }
      if (start_msg < 0) {
        return "Invalid start_msg — must be ≥ 0.";
      }
      const resolvedThreadId = resolveThreadId(thread_id);
      let archivedPath: string;
      try {
        archivedPath = getArchivedWindowPath(
          ctx.rollingWindowConfig,
          ctx.cwd,
          resolvedThreadId,
          window_index,
        );
      } catch (err) {
        return `Refused unsafe thread_id \`${thread_id}\`: ${err instanceof Error ? err.message : String(err)}`;
      }
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
