/**
 * DeepSeekRolloverSummary — generates the rolling-rollup summary that
 * gets written to `window_NNN.summary.md` after a rollover, and that
 * RW-5 reads back as a seed system message for the new active window.
 *
 * Architecture (RW-4 of the rolling-window memory system):
 *
 * When `tryRollover` in RollingWindowMemory returns `rolledOver: true`,
 * `DeepSeekAdapter` fires `generateRolloverSummaryBackground` as a
 * detached promise — it never awaits the summary, so a slow
 * (5-30s) Pro call can't block the user's next turn. The background
 * job:
 *   1. Reads the just-archived `window_NNN.jsonl` (full transcript).
 *   2. Reads the prior summary if one exists (`window_(N-1).summary.md`)
 *      so the rollup carries forward older context.
 *   3. Calls DeepSeek Pro (non-streaming, ~5K-token cap on output)
 *      with a sectioned-format prompt.
 *   4. Writes the response to `window_NNN.summary.md`.
 *
 * If the call fails (network, rate limit, malformed response), we log
 * and move on — the next turn just proceeds without a summary seed.
 * The archived window is still queryable via RW-6 retrieval tools, so
 * no data is lost; the model just has to ask for it explicitly.
 *
 * Sectioned summary format (per the design memory
 * `project_aris_rolling_window_memory.md`):
 *   - ## Topics covered
 *   - ## Decisions made
 *   - ## Code touched
 *   - ## People / context
 *   - ## Open threads
 *
 * @module DeepSeekRolloverSummary
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import OpenAI from "openai";

import {
  getThreadArchiveDir,
  type PersistedMessage,
  type RollingWindowConfig,
} from "./RollingWindowMemory.ts";

/**
 * Hard cap on the summary's output tokens. Keeps each rollup bounded
 * regardless of how big the source window was — a 920K-token window
 * doesn't need a 920K-token summary.
 *
 * Also matches the design memory's "10K cap with fade-older-content
 * pressure" — the prompt explicitly tells the model to compress
 * older content harder as windows accumulate.
 */
const SUMMARY_MAX_OUTPUT_TOKENS = 5000;

/** Default model for summary generation — V4-Pro per Kenny's call. */
const SUMMARY_MODEL = "deepseek-v4-pro";

/** File suffix for summary files alongside `window_NNN.jsonl`. */
const SUMMARY_FILENAME_SUFFIX = ".summary.md";

export interface GenerateRolloverSummaryOptions {
  /**
   * Slice L / M3-2 — resolved rolling-window paths threaded from the
   * adapter so background summary generation doesn't reach for
   * `homedir()` implicitly.
   */
  readonly rollingWindowConfig: RollingWindowConfig;
  readonly cwd: string;
  readonly threadId: string;
  /** Index of the just-archived window (1, 2, 3, ...). */
  readonly windowIndex: number;
  /** Path to the just-archived `window_NNN.jsonl`. */
  readonly archivedPath: string;
  /** Pre-built OpenAI client wired to cloud's DeepSeek proxy. */
  readonly openaiClient: OpenAI;
}

/**
 * Path to a window's summary file. Mirrors the archive path naming:
 * `window_NNN.jsonl` ↔ `window_NNN.summary.md`.
 */
export function getSummaryPath(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
  windowIndex: number,
): string {
  const padded = String(windowIndex).padStart(3, "0");
  return join(
    getThreadArchiveDir(config, cwd, threadId),
    `window_${padded}${SUMMARY_FILENAME_SUFFIX}`,
  );
}

/**
 * Find the highest-numbered summary file that exists for this thread.
 * Returns `null` if no summaries exist (first-ever rollover, or
 * earlier rollovers that failed to generate a summary).
 *
 * Used by both RW-4 (to prepend prior rollup into the new summary
 * generation prompt) and RW-5 (to seed the new active window).
 */
export async function findLatestSummaryPath(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<{ path: string; windowIndex: number } | null> {
  const dir = getThreadArchiveDir(config, cwd, threadId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  let bestIndex = 0;
  let bestPath: string | null = null;
  for (const name of entries) {
    if (!name.startsWith("window_")) continue;
    if (!name.endsWith(SUMMARY_FILENAME_SUFFIX)) continue;
    const middle = name.slice("window_".length, -SUMMARY_FILENAME_SUFFIX.length);
    const n = Number.parseInt(middle, 10);
    if (Number.isFinite(n) && n > bestIndex) {
      bestIndex = n;
      bestPath = join(dir, name);
    }
  }
  return bestPath ? { path: bestPath, windowIndex: bestIndex } : null;
}

/** Read the contents of a summary file, or `null` if it doesn't exist. */
export async function readSummary(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Read the archived window file and parse each JSONL line. */
async function readArchivedWindow(path: string): Promise<PersistedMessage[]> {
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
      // Skip corrupt lines silently — same posture as readActiveWindow.
    }
  }
  return out;
}

/**
 * Render the archived window as a single text block for the summary
 * prompt. Each turn becomes a labeled section so DS can attribute
 * statements correctly. Format:
 *
 *   --- Turn 1 ---
 *   USER: <text>
 *   ASSISTANT: <text>
 *   --- Turn 2 ---
 *   ...
 */
function renderArchiveForSummary(messages: PersistedMessage[]): string {
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

const SUMMARY_SYSTEM_PROMPT = `You are a senior engineer writing the rolling-rollup memory summary for a coding agent (Aris). Your output is a single Markdown document that becomes the primary context for the NEXT 1M-token conversation window. Aris will read this on every turn until the next rollover.

Goals:
- Capture EVERYTHING that matters for the work to continue cleanly: decisions, architecture, code locations, open questions, user preferences, blockers.
- Carry forward the prior rollup (if provided) — older content gets compressed harder, recent content stays detailed.
- Be CONCRETE about file paths, function names, line numbers, decision rationale. Vague summaries are useless.
- Stay under 5000 tokens. Use terse bullets, not prose paragraphs. Drop filler.

Required sections (use these exact H2 headers, in this order):

## Topics covered
What the conversation has been about, in priority order. One bullet per topic.

## Decisions made
Concrete decisions and the reasoning. Format: "**X** — chose Y over Z because <reason>". Include code-level decisions.

## Code touched
Files modified or read in this window, with what changed. Format: "**path/to/file.ts** — what changed and why".

## People / context
The user (Kenny), people they mention, projects, environments, anything personal/relational that affects the work.

## Open threads
Things explicitly deferred, blocked, or not-yet-addressed. The TODO list Aris should be aware of.

Rules:
- Use the prior summary verbatim where it's still accurate; rewrite where new info supersedes.
- For "Code touched": list every file from the new window AND keep the most important files from the prior summary.
- For "Decisions made": never lose a load-bearing decision, even from older windows. Compress wording, don't drop the fact.
- Mention specific user preferences/feedback patterns ("Kenny prefers X", "Kenny said no Y") explicitly.
- No markdown emphasis spam. Bold/italic only for emphasis that matters.
- Output ONLY the summary document. No preamble, no explanation, no "here's the summary" intro.`;

function buildUserPrompt(opts: {
  windowIndex: number;
  priorSummary: string | null;
  archiveText: string;
}): string {
  const { windowIndex, priorSummary, archiveText } = opts;
  const sections: string[] = [];
  sections.push(`# Generating rollup summary for window ${windowIndex}`);
  sections.push("");
  if (priorSummary !== null) {
    sections.push(
      `## Prior rollup (window ${windowIndex - 1}) — incorporate, compress where needed`,
    );
    sections.push("");
    sections.push(priorSummary.trim());
    sections.push("");
  } else {
    sections.push("## Prior rollup");
    sections.push("");
    sections.push("(none — this is the first rollover for this thread)");
    sections.push("");
  }
  sections.push(
    `## New window ${windowIndex} transcript — full conversation that just rolled over`,
  );
  sections.push("");
  sections.push(archiveText);
  sections.push("");
  sections.push(
    "Now write the rollup summary for window " +
      windowIndex +
      ". Carry forward what matters from the prior rollup, integrate everything from the new transcript, follow the required sections exactly.",
  );
  return sections.join("\n");
}

/**
 * Synchronously generate a rollup summary for a just-archived window
 * and write it to disk. Returns the path on success, or throws on
 * failure. Callers wrap this in a fire-and-forget invocation.
 */
async function generateRolloverSummary(opts: GenerateRolloverSummaryOptions): Promise<string> {
  const { rollingWindowConfig, cwd, threadId, windowIndex, archivedPath, openaiClient } = opts;

  const messages = await readArchivedWindow(archivedPath);
  const archiveText = renderArchiveForSummary(messages);

  let priorSummary: string | null = null;
  if (windowIndex > 1) {
    const priorSummaryPath = getSummaryPath(rollingWindowConfig, cwd, threadId, windowIndex - 1);
    priorSummary = await readSummary(priorSummaryPath);
  }

  const userPrompt = buildUserPrompt({ windowIndex, priorSummary, archiveText });

  const completion = await openaiClient.chat.completions.create({
    model: SUMMARY_MODEL,
    stream: false,
    max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const choice = completion.choices[0];
  const summaryText =
    choice && typeof choice.message?.content === "string" ? choice.message.content.trim() : "";

  if (summaryText.length === 0) {
    throw new Error("DeepSeek returned empty summary content");
  }

  const summaryPath = getSummaryPath(rollingWindowConfig, cwd, threadId, windowIndex);
  await fs.writeFile(summaryPath, summaryText + "\n", { encoding: "utf8" });
  return summaryPath;
}

/**
 * Fire-and-forget wrapper. Use this from inside a turn handler — the
 * promise is detached so a slow Pro call (5-30s) never blocks the
 * user's next turn. Failures are logged and swallowed.
 *
 * The caller should NOT await the returned promise — the function
 * spawns the actual work in the background. The returned promise
 * resolves immediately (synchronous return after kicking off the
 * detached task).
 */
export function generateRolloverSummaryBackground(opts: GenerateRolloverSummaryOptions): void {
  void (async () => {
    try {
      const path = await generateRolloverSummary(opts);
      console.error(
        `[DeepSeekRolloverSummary] generated window ${opts.windowIndex} summary at ${basename(path)}`,
      );
    } catch (err) {
      console.warn(
        `[DeepSeekRolloverSummary] window ${opts.windowIndex} summary generation failed (continuing without summary): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
}
