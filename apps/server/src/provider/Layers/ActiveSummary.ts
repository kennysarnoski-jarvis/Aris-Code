/**
 * ActiveSummary — sidecar summary for in-flight threads that haven't
 * rolled over yet (Slice Z.3).
 *
 * Companion file to `active.jsonl`. Lives at
 * `~/.aris/projects/<projectKey>/sessions/<threadId>/active.summary.md`.
 *
 * Purpose: close the cross-thread memory gap left by Slice X. Slice X
 * already reads `window_NNN.summary.md` to brief a new thread on a
 * prior thread's work, but those files only exist post-920K-rollover.
 * Short threads (the common case) never roll over, so they were
 * invisible to cross-thread memory. This module makes those threads
 * surface their summary continuously while they're still active.
 *
 * Lifecycle:
 *   1. After every assistant turn, `StopActiveSummaryHook` calls
 *      `shouldGenerateActiveSummary` to decide whether to fire.
 *   2. If yes: `generateActiveSummaryBackground` reads active.jsonl,
 *      calls DeepSeek Pro with the same sectioned prompt the rollover
 *      summary uses, writes the result to active.summary.md with a
 *      meta comment line recording the active.jsonl byte size at
 *      generation time. **active.jsonl is never touched.**
 *   3. Concurrent fires are de-duplicated by an in-memory in-flight
 *      tracker keyed by projectKey + threadId — only one generation
 *      per thread can run at a time.
 *   4. On SessionEnd (real session stop, rare in practice), the
 *      `SessionEndArchiveHook` runs the destructive Slice Y archive
 *      and deletes the now-superseded active.summary.md so cross-
 *      thread scan picks up `window_NNN.summary.md` instead.
 *
 * Why a meta-comment instead of a sidecar metadata file: keeps the
 * thread directory shape minimal (active.jsonl + active.summary.md,
 * nothing else). Parsing the comment is cheap and the comment is
 * invisible when the summary is rendered into Aris's system context.
 *
 * @module ActiveSummary
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import OpenAI from "openai";

import {
  getActiveWindowPath,
  getThreadArchiveDir,
  projectKeyFromCwd,
  type PersistedMessage,
  type RollingWindowConfig,
} from "./RollingWindowMemory.ts";

/** Filename used inside a thread's session directory. */
export const ACTIVE_SUMMARY_FILENAME = "active.summary.md";

/**
 * Minimum number of bytes of `active.jsonl` before we'll consider
 * generating an active summary. Matches `THREAD_CLOSE_MIN_ACTIVE_BYTES`
 * from Slice Y so the threshold for "this thread has enough content to
 * warrant a summary" is consistent across both paths.
 */
export const ACTIVE_SUMMARY_MIN_BYTES = 2048;

/**
 * Minimum byte growth of `active.jsonl` between consecutive summary
 * generations. Without this debounce, Stop would fire a Pro summary
 * after every assistant turn — expensive and pointless when the user
 * only added one short message. 2KB of new content is roughly one
 * substantive exchange.
 */
export const ACTIVE_SUMMARY_RESUMMARIZE_BYTES = 2048;

/** Hard cap on summary output tokens — mirrors the rollover summary. */
const ACTIVE_SUMMARY_MAX_OUTPUT_TOKENS = 5000;

/** Default model — V4-Pro, same as the rollover summary. */
const ACTIVE_SUMMARY_MODEL = "deepseek-v4-pro";

const META_COMMENT_PREFIX = "<!-- aris-active-summary-meta: ";
const META_COMMENT_SUFFIX = " -->";

/**
 * Metadata recorded inline at the top of `active.summary.md`. The
 * `sizeAtGeneration` field is the load-bearing one: it tells the next
 * Stop fire how much active.jsonl has grown since the last summary
 * write, which drives the debounce.
 */
export interface ActiveSummaryMeta {
  /** Size in bytes of `active.jsonl` at the moment this summary was generated. */
  readonly sizeAtGeneration: number;
  /** ISO timestamp when the summary was generated. */
  readonly generatedAtIso: string;
}

/**
 * Result of reading an existing `active.summary.md`. `text` is the
 * full file contents (including the meta-comment first line); `meta`
 * is the parsed metadata, or `null` if the file pre-dates the meta
 * format or has a malformed first line.
 */
export interface ActiveSummaryFile {
  readonly text: string;
  readonly meta: ActiveSummaryMeta | null;
}

/**
 * Path to the active summary sidecar for a given thread. Mirrors
 * `getActiveWindowPath` but with a `.summary.md` companion.
 */
export function getActiveSummaryPath(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): string {
  return join(getThreadArchiveDir(config, cwd, threadId), ACTIVE_SUMMARY_FILENAME);
}

/**
 * Parse the meta comment from the first line of an active.summary.md
 * file. Returns `null` if the line doesn't match the expected shape
 * (older files without meta, or hand-edited summaries).
 */
export function parseActiveSummaryMeta(fileText: string): ActiveSummaryMeta | null {
  const firstNewline = fileText.indexOf("\n");
  const firstLine = firstNewline === -1 ? fileText : fileText.slice(0, firstNewline);
  if (!firstLine.startsWith(META_COMMENT_PREFIX) || !firstLine.endsWith(META_COMMENT_SUFFIX)) {
    return null;
  }
  const jsonPart = firstLine.slice(
    META_COMMENT_PREFIX.length,
    firstLine.length - META_COMMENT_SUFFIX.length,
  );
  try {
    const parsed: unknown = JSON.parse(jsonPart);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { sizeAtGeneration?: unknown }).sizeAtGeneration === "number" &&
      typeof (parsed as { generatedAtIso?: unknown }).generatedAtIso === "string"
    ) {
      const obj = parsed as { sizeAtGeneration: number; generatedAtIso: string };
      return { sizeAtGeneration: obj.sizeAtGeneration, generatedAtIso: obj.generatedAtIso };
    }
  } catch {
    // Malformed JSON in the meta comment — treat as no meta.
  }
  return null;
}

/**
 * Read the active summary sidecar if it exists. Returns `null` when
 * the file is absent (no summary generated yet) and the parsed
 * structure otherwise.
 */
export async function readActiveSummary(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<ActiveSummaryFile | null> {
  const path = getActiveSummaryPath(config, cwd, threadId);
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  return { text, meta: parseActiveSummaryMeta(text) };
}

/**
 * Atomically write an active summary, prepending the meta comment.
 * Uses write-then-rename so a crash mid-write leaves either the old
 * file or the new file in place — never a partial one.
 */
export async function writeActiveSummary(
  path: string,
  summaryBody: string,
  meta: ActiveSummaryMeta,
): Promise<void> {
  const metaLine =
    META_COMMENT_PREFIX +
    JSON.stringify({
      sizeAtGeneration: meta.sizeAtGeneration,
      generatedAtIso: meta.generatedAtIso,
    }) +
    META_COMMENT_SUFFIX;
  const contents = metaLine + "\n" + summaryBody.trim() + "\n";
  const tempPath = path + ".tmp";
  await fs.writeFile(tempPath, contents, { encoding: "utf8" });
  await fs.rename(tempPath, path);
}

/**
 * Delete the active summary sidecar if present. Used by the SessionEnd
 * archive path after the destructive rollover happens — once
 * `window_NNN.summary.md` exists, the active sidecar is obsolete and
 * cross-thread scan should prefer the rollover summary.
 */
export async function deleteActiveSummary(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<void> {
  const path = getActiveSummaryPath(config, cwd, threadId);
  try {
    await fs.unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

/**
 * Discriminated result of `shouldGenerateActiveSummary`. The reason
 * string is for logging — the caller only branches on `shouldGenerate`.
 */
export type ShouldGenerateResult =
  | { readonly shouldGenerate: false; readonly reason: string }
  | {
      readonly shouldGenerate: true;
      /** Current size of `active.jsonl`, to be recorded as `sizeAtGeneration`. */
      readonly currentBytes: number;
    };

/**
 * Decide whether the Stop hook should fire a summary generation. The
 * debounce rules:
 *   - Active.jsonl absent or too small → no summary.
 *   - No prior summary exists → generate (this is the first one).
 *   - Prior summary exists with parseable meta → generate only if
 *     active.jsonl has grown by at least
 *     `ACTIVE_SUMMARY_RESUMMARIZE_BYTES` since the last write.
 *   - Prior summary exists but meta is missing/malformed → generate
 *     (one regeneration upgrades the file to the new meta format).
 *
 * Does not consult the in-flight tracker — that's the caller's
 * responsibility because it's per-runtime state, not per-disk.
 */
export async function shouldGenerateActiveSummary(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<ShouldGenerateResult> {
  const activePath = getActiveWindowPath(config, cwd, threadId);
  let activeStat: { size: number };
  try {
    activeStat = await fs.stat(activePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { shouldGenerate: false, reason: "no-active-file" };
    }
    throw err;
  }
  if (activeStat.size < ACTIVE_SUMMARY_MIN_BYTES) {
    return { shouldGenerate: false, reason: "below-threshold" };
  }

  const existing = await readActiveSummary(config, cwd, threadId);
  if (existing === null) {
    return { shouldGenerate: true, currentBytes: activeStat.size };
  }
  if (existing.meta === null) {
    // Legacy file without meta — regenerate so it gets the comment.
    return { shouldGenerate: true, currentBytes: activeStat.size };
  }
  const grewBy = activeStat.size - existing.meta.sizeAtGeneration;
  if (grewBy < ACTIVE_SUMMARY_RESUMMARIZE_BYTES) {
    return { shouldGenerate: false, reason: "no-significant-growth" };
  }
  return { shouldGenerate: true, currentBytes: activeStat.size };
}

// ── In-flight tracker ───────────────────────────────────────────────
//
// Module-level Set of "<projectKey>:<threadId>" keys currently
// generating. Prevents two Stop fires from racing on the same thread.
// Cleared in the generation function's finally block.

const inFlightKeys = new Set<string>();

function makeInFlightKey(cwd: string, threadId: string): string {
  return projectKeyFromCwd(cwd) + ":" + threadId;
}

/** Test-only: clear the in-flight tracker between runs. */
export function __resetInFlightTrackerForTest(): void {
  inFlightKeys.clear();
}

/** Test-only: peek at the in-flight tracker for assertions. */
export function __getInFlightSizeForTest(): number {
  return inFlightKeys.size;
}

// ── Summary generation ──────────────────────────────────────────────

const ACTIVE_SUMMARY_SYSTEM_PROMPT = `You are a senior engineer writing the running summary for an IN-FLIGHT coding conversation between a user (Kenny) and a coding agent (Aris). Your output is a single Markdown document that will be surfaced to FUTURE threads in the same project so they can pick up where this one leaves off.

Goals:
- Capture EVERYTHING that matters for the work to continue cleanly: decisions, architecture, code locations, open questions, user preferences, blockers.
- Be CONCRETE about file paths, function names, line numbers, decision rationale. Vague summaries are useless.
- Stay under 5000 tokens. Use terse bullets, not prose paragraphs. Drop filler.

Required sections (use these exact H2 headers, in this order):

## Topics covered
What the conversation has been about, in priority order. One bullet per topic.

## Decisions made
Concrete decisions and the reasoning. Format: "**X** — chose Y over Z because <reason>". Include code-level decisions.

## Code touched
Files modified or read in this conversation, with what changed. Format: "**path/to/file.ts** — what changed and why".

## People / context
The user (Kenny), people they mention, projects, environments, anything personal/relational that affects the work.

## Open threads
Things explicitly deferred, blocked, or not-yet-addressed. The TODO list that should be aware of.

Rules:
- This is a LIVE thread — the conversation is still happening. Summarize what's happened so far; don't speculate about what will happen.
- Mention specific user preferences/feedback patterns ("Kenny prefers X", "Kenny said no Y") explicitly.
- No markdown emphasis spam. Bold/italic only for emphasis that matters.
- Output ONLY the summary document. No preamble, no explanation, no "here's the summary" intro.`;

async function readActiveWindowForSummary(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<PersistedMessage[]> {
  const path = getActiveWindowPath(config, cwd, threadId);
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
      // Skip corrupt lines — same posture as readActiveWindow.
    }
  }
  return out;
}

function renderActiveForSummary(messages: readonly PersistedMessage[]): string {
  const turnGroups = new Map<string, PersistedMessage[]>();
  const turnOrder: string[] = [];
  for (const msg of messages) {
    if (!turnGroups.has(msg.turnId)) {
      turnGroups.set(msg.turnId, []);
      turnOrder.push(msg.turnId);
    }
    turnGroups.get(msg.turnId)?.push(msg);
  }
  const parts: string[] = [];
  for (let i = 0; i < turnOrder.length; i += 1) {
    parts.push(`--- Turn ${i + 1} ---`);
    const group = turnGroups.get(turnOrder[i] ?? "") ?? [];
    for (const msg of group) {
      parts.push(`${msg.role.toUpperCase()}: ${msg.content}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

export interface GenerateActiveSummaryOptions {
  readonly rollingWindowConfig: RollingWindowConfig;
  readonly cwd: string;
  readonly threadId: string;
  readonly openaiClient: OpenAI;
  /**
   * Size of active.jsonl observed by `shouldGenerateActiveSummary` —
   * recorded into the meta comment so the next debounce check knows
   * exactly how much new content to wait for. Passed in (rather than
   * re-stat'd) so the value matches the decision that triggered this
   * generation, not whatever has been appended since.
   */
  readonly observedActiveBytes: number;
}

/**
 * Synchronously generate an active summary and write it to disk.
 * Throws on failure. Caller wraps in fire-and-forget.
 */
async function generateActiveSummary(opts: GenerateActiveSummaryOptions): Promise<string> {
  const { rollingWindowConfig, cwd, threadId, openaiClient, observedActiveBytes } = opts;

  const messages = await readActiveWindowForSummary(rollingWindowConfig, cwd, threadId);
  if (messages.length === 0) {
    throw new Error("active.jsonl had no parseable messages");
  }
  const activeText = renderActiveForSummary(messages);

  const userPrompt =
    "# In-flight thread transcript\n\n" +
    activeText +
    "\n\nNow write the running summary for this thread. Follow the required sections exactly.";

  const rawCompletion: unknown = await openaiClient.chat.completions.create({
    model: ACTIVE_SUMMARY_MODEL,
    stream: false,
    max_tokens: ACTIVE_SUMMARY_MAX_OUTPUT_TOKENS,
    messages: [
      { role: "system", content: ACTIVE_SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  // The cloud trusted-caller proxy at
  // /api/local/deepseek/v1/chat/completions sometimes returns the
  // response body as a raw JSON string (with leading whitespace)
  // instead of a parsed object. Normalize: parse strings, accept
  // objects as-is.
  type ChatCompletionShape = {
    choices?: ReadonlyArray<{ message?: { content?: unknown } }>;
  };
  let completion: ChatCompletionShape;
  if (typeof rawCompletion === "string") {
    try {
      completion = JSON.parse((rawCompletion as string).trim()) as ChatCompletionShape;
    } catch (parseErr) {
      console.error(
        `[ActiveSummary] failed to parse string response: ${
          (parseErr as Error).message
        }; first 200 chars: ${(rawCompletion as string).slice(0, 200)}`,
      );
      throw new Error("DeepSeek returned unparseable string response for active summary");
    }
  } else if (rawCompletion && typeof rawCompletion === "object") {
    completion = rawCompletion as ChatCompletionShape;
  } else {
    throw new Error("DeepSeek returned null/undefined response for active summary");
  }

  if (!completion.choices || !Array.isArray(completion.choices)) {
    console.error(
      `[ActiveSummary] parsed completion missing choices (keys=${Object.keys(completion).join(",")})`,
    );
    throw new Error("DeepSeek response has no choices array for active summary");
  }
  const choice = completion.choices[0];
  const summaryText =
    choice && typeof choice.message?.content === "string" ? choice.message.content.trim() : "";

  if (summaryText.length === 0) {
    throw new Error("DeepSeek returned empty active-summary content");
  }

  const summaryPath = getActiveSummaryPath(rollingWindowConfig, cwd, threadId);
  await writeActiveSummary(summaryPath, summaryText, {
    sizeAtGeneration: observedActiveBytes,
    generatedAtIso: new Date().toISOString(),
  });
  return summaryPath;
}

/**
 * Fire-and-forget wrapper. Returns immediately after kicking off the
 * detached task. Concurrent calls for the same (cwd, threadId) pair
 * are de-duplicated via the in-flight tracker — a second call while
 * the first is still running is a no-op (logged and dropped).
 *
 * Failures are logged and swallowed; the Stop hook never blocks the
 * user's next turn on a slow or failing Pro call.
 */
export function generateActiveSummaryBackground(opts: GenerateActiveSummaryOptions): void {
  const key = makeInFlightKey(opts.cwd, opts.threadId);
  if (inFlightKeys.has(key)) {
    console.error(`[ActiveSummary] skip: generation already in-flight for ${key}`);
    return;
  }
  inFlightKeys.add(key);
  void (async () => {
    try {
      const path = await generateActiveSummary(opts);
      console.error(`[ActiveSummary] wrote ${basename(path)} for thread ${opts.threadId}`);
    } catch (err) {
      console.warn(
        `[ActiveSummary] generation failed for thread ${opts.threadId} (continuing without summary): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      inFlightKeys.delete(key);
    }
  })();
}
