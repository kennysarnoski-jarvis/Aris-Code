/**
 * FactsMemory — USER-GLOBAL durable facts for DeepSeek, backed by an
 * append-only `.jsonl` file at `~/.aris/facts.jsonl`.
 *
 * Slice MEM-3: Cross-project memory layer. Distinct from MEM-1
 * (project-scoped scratchpad) and MEM-2 (project-scoped todos):
 * facts live OUTSIDE any project directory and apply across every
 * project the user opens in Aris Code. This is what makes DS feel
 * like she remembers Kenny himself, not just his current codebase.
 *
 * Layout:
 *
 *   ~/.aris/
 *     facts.jsonl                       ← THIS module's file (USER-GLOBAL)
 *     projects/<project-key>/
 *       scratchpad.jsonl                ← MEM-1 (project-scoped)
 *       todos.jsonl                     ← MEM-2 (project-scoped)
 *       sessions/<thread-id>/...        ← rolling window (per-thread)
 *
 * Scope decision (Kenny, 2026-05-10): user + feedback only. The
 * `project` and `reference` fact types from Aris's original sqlite
 * schema are dropped — scratchpad covers project-scoped notes, and
 * we don't need a separate "external pointer" type when scratchpad
 * can hold URLs verbatim.
 *
 * Format — one JSON object per line, append-only:
 *
 *   { "id":"<uuid>", "ts":"<iso>", "action":"upsert",
 *     "factType":"user", "label":"name",
 *     "description":"User's preferred name", "content":"Kenny" }
 *
 *   { "id":"<uuid>", "ts":"<iso>", "action":"delete",
 *     "factType":"user", "label":"name" }
 *
 * Identity: each fact is keyed on `(factType, label)`. Upsert by
 * existing key overwrites (description + content). Delete removes
 * the key. Replay walks the record stream and derives the current
 * map.
 *
 * Why `factType` not `type`: the term `type` is overloaded inside
 * tool param schemas; `factType` reads unambiguously in code AND in
 * the persisted line.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Data } from "effect";

const ARIS_HOME_DIR = ".aris";
const FACTS_FILENAME = "facts.jsonl";

/**
 * Tagged error for any facts I/O failure. Mirrors the patterns in
 * `ScratchpadMemory` / `TodosMemory` / `RollingWindowMemory` so
 * callers using `Effect.tryPromise.catch` get a properly tagged
 * narrow type.
 */
export class FactsIOError extends Data.TaggedError("FactsIOError")<{
  readonly operation: "read" | "append" | "mkdir";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * `Effect.tryPromise.catch` adapter — wraps an unknown thrown value
 * into a tagged `FactsIOError`.
 */
export function toFactsIOError(operation: "read" | "append" | "mkdir") {
  return (cause: unknown): FactsIOError =>
    new FactsIOError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
}

/**
 * Allowed fact types. User-global only — scope decision per Kenny:
 *   - `user` — identity facts about the user (name, role, people in
 *     their life, preferences). Carry across every project.
 *   - `feedback` — rules the user has given about how DS should
 *     behave. Carry across every project.
 *
 * `project` and `reference` from Aris's original schema are NOT
 * supported here — scratchpad covers per-project notes, and external
 * URL pointers can sit inside a fact's content if needed.
 */
export type FactType = "user" | "feedback";

/**
 * One persisted mutation to the facts store. Discriminated union on
 * `action`. Upsert carries the full payload; delete carries just the
 * identity key.
 */
export type FactsRecord =
  | {
      readonly id: string;
      readonly ts: string;
      readonly action: "upsert";
      readonly factType: FactType;
      readonly label: string;
      readonly description: string;
      readonly content: string;
    }
  | {
      readonly id: string;
      readonly ts: string;
      readonly action: "delete";
      readonly factType: FactType;
      readonly label: string;
    };

/** Current-state shape after replay — what callers consume. */
export interface Fact {
  readonly factType: FactType;
  readonly label: string;
  readonly description: string;
  readonly content: string;
}

/** Path to the user-global facts file. Pure path math — no fs touch. */
export function getFactsPath(): string {
  return join(homedir(), ARIS_HOME_DIR, FACTS_FILENAME);
}

/** Path to the user-global ARIS_HOME dir (parent of facts.jsonl). */
export function getArisHomeDir(): string {
  return join(homedir(), ARIS_HOME_DIR);
}

/**
 * Idempotent `mkdir -p` on the ARIS_HOME directory. Safe to call
 * before every append. (The dir is created lazily so a fresh install
 * doesn't have to provision it explicitly.)
 */
export async function ensureArisHomeDir(): Promise<void> {
  await fs.mkdir(getArisHomeDir(), { recursive: true });
}

/**
 * Parse one line into a `FactsRecord`. Returns `null` for lines that
 * don't match the expected shape. Caller drops nulls with a console
 * warning rather than throwing — single-line corruption shouldn't
 * break the whole replay.
 */
function parseRecord(line: string): FactsRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const action = obj["action"];
  const factType = obj["factType"];
  const label = obj["label"];
  const id = typeof obj["id"] === "string" ? obj["id"] : "";
  const ts = typeof obj["ts"] === "string" ? obj["ts"] : "";
  if (factType !== "user" && factType !== "feedback") return null;
  if (typeof label !== "string" || label.length === 0) return null;
  if (action === "upsert") {
    const description = obj["description"];
    const content = obj["content"];
    if (typeof description !== "string") return null;
    if (typeof content !== "string") return null;
    return { id, ts, action, factType, label, description, content };
  }
  if (action === "delete") {
    return { id, ts, action, factType, label };
  }
  return null;
}

/**
 * Read the raw record stream from disk in file order. Returns `[]`
 * for a missing file (no facts written yet for this user).
 */
export async function readFactsRecords(): Promise<ReadonlyArray<FactsRecord>> {
  const path = getFactsPath();
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: FactsRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const record = parseRecord(line);
    if (record === null) {
      console.warn(`[FactsMemory] dropped corrupt line in ${path}: ${line.slice(0, 80)}…`);
      continue;
    }
    out.push(record);
  }
  return out;
}

/**
 * Replay records in file order to derive the current facts map. Pure
 * function on the record array — separated from IO so tests can
 * verify replay semantics without touching disk.
 *
 * Replay rules:
 *   - `upsert(factType, label, description, content)` → set the entry
 *     at key `(factType, label)`. Overwrites prior value.
 *   - `delete(factType, label)` → remove the entry at that key
 *     (no-op if missing).
 *
 * Returns an array sorted by (factType, label) for stable rendering.
 * Most callers will then group by factType for the system-prompt
 * block; sorting up front keeps tests deterministic.
 */
export function replayFacts(records: ReadonlyArray<FactsRecord>): ReadonlyArray<Fact> {
  // Map keyed on `${factType}::${label}` for O(1) upsert/delete.
  const byKey = new Map<string, Fact>();
  for (const r of records) {
    const key = `${r.factType}::${r.label}`;
    if (r.action === "upsert") {
      byKey.set(key, {
        factType: r.factType,
        label: r.label,
        description: r.description,
        content: r.content,
      });
    } else {
      byKey.delete(key);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.factType !== b.factType) return a.factType < b.factType ? -1 : 1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

/** Convenience: read the file and replay in one call. */
export async function readFacts(): Promise<ReadonlyArray<Fact>> {
  const records = await readFactsRecords();
  return replayFacts(records);
}

/**
 * Append one record to the facts file. Atomic at the line level
 * (O_APPEND) and fsynced via `flush: true`.
 */
export async function appendFactsRecord(record: FactsRecord): Promise<void> {
  await ensureArisHomeDir();
  const line = JSON.stringify(record) + "\n";
  await fs.appendFile(getFactsPath(), line, { encoding: "utf8", flush: true });
}

/**
 * Build a `FactsRecord` with a fresh uuid + timestamp. Tool layer
 * uses this so it doesn't have to import `crypto` directly.
 */
export function newFactsRecord(
  input:
    | {
        readonly action: "upsert";
        readonly factType: FactType;
        readonly label: string;
        readonly description: string;
        readonly content: string;
      }
    | {
        readonly action: "delete";
        readonly factType: FactType;
        readonly label: string;
      },
): FactsRecord {
  const id = randomUUID();
  const ts = new Date().toISOString();
  if (input.action === "upsert") {
    return {
      id,
      ts,
      action: "upsert",
      factType: input.factType,
      label: input.label,
      description: input.description,
      content: input.content,
    };
  }
  return { id, ts, action: "delete", factType: input.factType, label: input.label };
}

/**
 * Render the current facts list as a compact text block for the
 * system prompt. Groups by `factType`, alphabetizes within each
 * group. Emits `## user` and `## feedback` subheadings.
 *
 * Returns the empty string when there are no facts so the adapter
 * can decide to skip the `<facts>` block entirely.
 *
 * Format inside the block (per group):
 *
 *     ## user
 *     - name — Kenny
 *     - timezone — Pacific (US/Canada)
 *
 *     ## feedback
 *     - no_patches — only architecturally correct fixes; never use words like "patch" or "band-aid"
 *     - terse_responses — skip trailing summaries; user can read the diff
 *
 * The `description` is the line shown ("the hook"). The `content` is
 * appended after `: ` only when non-trivially distinct from the
 * description, to keep the block compact.
 */
export function renderFacts(facts: ReadonlyArray<Fact>): string {
  if (facts.length === 0) return "";
  const groups = new Map<FactType, Fact[]>();
  for (const f of facts) {
    const existing = groups.get(f.factType) ?? [];
    existing.push(f);
    groups.set(f.factType, existing);
  }
  const sections: string[] = [];
  // Stable order: user before feedback.
  for (const factType of ["user", "feedback"] as const) {
    const groupFacts = groups.get(factType);
    if (!groupFacts || groupFacts.length === 0) continue;
    const lines: string[] = [`## ${factType}`];
    for (const f of groupFacts) {
      // Use the description as the headline. If content adds info,
      // append it after a separator. If content equals description
      // (which is fine — sometimes the hook IS the value), don't
      // duplicate.
      const body =
        f.content.length > 0 && f.content !== f.description
          ? `${f.label} — ${f.description} | ${f.content}`
          : `${f.label} — ${f.description}`;
      lines.push(`- ${body}`);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

/**
 * Per-file write lock. Same pattern as `TodosMemory.withTodosWriteLock`
 * — keyed on the file path so concurrent upserts don't lose writes
 * when the model emits multiple facts tool calls in a single turn.
 *
 * For facts the lock matters less than for todos (no read-modify-write
 * id allocation), but the post-write state report still benefits from
 * serialization, and concurrent `upsert + delete` for the same key
 * needs ordering anyway.
 */
const FACTS_WRITE_LOCKS = new Map<string, Promise<unknown>>();

export async function withFactsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const key = getFactsPath();
  const prior = FACTS_WRITE_LOCKS.get(key) ?? Promise.resolve();
  const ours = prior.then(
    () => fn(),
    () => fn(),
  );
  FACTS_WRITE_LOCKS.set(
    key,
    ours.catch(() => undefined),
  );
  return await ours;
}
