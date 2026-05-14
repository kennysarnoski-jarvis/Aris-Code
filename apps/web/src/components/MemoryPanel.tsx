/**
 * MemoryPanel — right-sidebar section showing the user-global facts
 * store (`~/.aris/facts.jsonl`), mirroring Cowork's Memory panel.
 *
 * Why this exists (2026-05-12):
 *   The facts.jsonl file already drives every Aris turn's `<facts>`
 *   system-prompt block (MEM-3). Until now there was no user-facing
 *   surface for it — you couldn't see what Aris remembers about you
 *   without asking her. This panel makes it inspectable.
 *
 * Always-visible: facts are user-global (apply to every project,
 * every provider), so we don't gate on the active provider. Even
 * when the user is in a Codex / Claude thread, the panel still shows
 * what's saved — those providers don't see facts in their context,
 * but the user can still inspect them.
 *
 * Interaction model:
 *   - Click a row → expand to show `description` + `content`.
 *   - No edit / delete from UI (read-only). Mutations go through
 *     Aris ("forget about X" → she calls `delete_memory_node`), which
 *     keeps the source of truth in one place and matches Cowork's
 *     pattern.
 *
 * Layout:
 *   - Grouped by `factType` (user vs feedback) — matches how the
 *     system-prompt block is rendered.
 *   - Each group has its own header so the panel is scannable.
 *
 * @module MemoryPanel
 */
import { useMemo, useState } from "react";

import type { ArisFact, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useArisFacts } from "../useArisFacts";

export interface MemoryPanelProps {
  readonly threadId: ThreadId | null;
  readonly environmentId: EnvironmentId | null;
}

interface GroupedFacts {
  readonly factType: ArisFact["factType"];
  readonly label: string;
  readonly facts: ReadonlyArray<ArisFact>;
}

const FACT_TYPE_LABELS: Record<ArisFact["factType"], string> = {
  user: "About you",
  feedback: "How to work with you",
};

const FACT_TYPE_ORDER: ReadonlyArray<ArisFact["factType"]> = ["user", "feedback"];

export function MemoryPanel(props: MemoryPanelProps) {
  const { threadId, environmentId } = props;
  const { facts, isLoading, errorMessage } = useArisFacts({ threadId, environmentId });

  const grouped = useMemo<ReadonlyArray<GroupedFacts>>(() => {
    const byType = new Map<ArisFact["factType"], ArisFact[]>();
    for (const fact of facts) {
      const bucket = byType.get(fact.factType);
      if (bucket) bucket.push(fact);
      else byType.set(fact.factType, [fact]);
    }
    return FACT_TYPE_ORDER.flatMap((factType) => {
      const bucket = byType.get(factType);
      if (!bucket || bucket.length === 0) return [];
      // Sort labels alphabetically within a group so the panel order
      // is stable across refetches (otherwise jsonl replay order
      // leaks into the UI, which feels random to the user).
      const sorted = [...bucket].sort((a, b) => a.label.localeCompare(b.label));
      return [{ factType, label: FACT_TYPE_LABELS[factType], facts: sorted }];
    });
  }, [facts]);

  const totalCount = facts.length;

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 px-3">
        Memory {totalCount > 0 ? `(${totalCount})` : ""}
      </div>
      {errorMessage && (
        <div
          className="text-[11px] text-red-600 dark:text-red-400 px-3 py-1 truncate"
          title={errorMessage}
        >
          Failed to load memory: {errorMessage}
        </div>
      )}
      {totalCount === 0 && !isLoading && !errorMessage && (
        <div className="text-sm text-zinc-500 dark:text-zinc-400 italic px-3 py-2">
          No memories saved yet. Aris will save things you tell her here automatically.
        </div>
      )}
      {grouped.map((group) => (
        <section key={group.factType} className="flex flex-col">
          <div className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 px-3 pt-1">
            {group.label}
          </div>
          <ul className="flex flex-col">
            {group.facts.map((fact) => (
              <MemoryRow key={`${fact.factType}:${fact.label}`} fact={fact} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MemoryRow(props: { fact: ArisFact }) {
  const { fact } = props;
  const [expanded, setExpanded] = useState(false);
  const hasMore = fact.description.length > 0 || fact.content.length > 0;
  return (
    <li className="px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
      <button
        type="button"
        onClick={() => (hasMore ? setExpanded((v) => !v) : undefined)}
        className="w-full text-left flex flex-col gap-0.5 cursor-pointer disabled:cursor-default"
        disabled={!hasMore}
        aria-expanded={hasMore ? expanded : undefined}
      >
        <span className="text-sm text-zinc-800 dark:text-zinc-200 break-words">{fact.label}</span>
        {expanded && (
          <div className="mt-1 flex flex-col gap-1 text-[11px] text-zinc-600 dark:text-zinc-300 break-words whitespace-pre-wrap">
            {fact.description.length > 0 && (
              <div className="italic text-zinc-500 dark:text-zinc-400">{fact.description}</div>
            )}
            {fact.content.length > 0 && <div>{fact.content}</div>}
          </div>
        )}
      </button>
    </li>
  );
}
