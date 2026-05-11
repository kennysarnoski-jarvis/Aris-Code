import { memo, useCallback, useMemo, useState } from "react";
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import type { ArisMemoryNode, ArisMemoryType } from "../../arisMemoryFetch";

interface MemoryCardProps {
  readonly nodes: ReadonlyArray<ArisMemoryNode>;
  readonly onSaveContent: (args: {
    type: ArisMemoryType;
    label: string;
    content: string;
    projectId?: number | null;
  }) => Promise<{ syncedToCloud: boolean }>;
  readonly onDelete: (args: {
    type: ArisMemoryType;
    label: string;
    projectId?: number | null;
  }) => Promise<{ deletedEdges: number; notFound: boolean }>;
}

interface TypeStats {
  readonly type: ArisMemoryType;
  readonly count: number;
}

/**
 * Fixed display order for the four V1 memdir types — matches the
 * Anthropic-style memdir convention (most-personal at top, project-local
 * facts in the middle, external pointers at the bottom).
 */
const TYPE_ORDER: readonly ArisMemoryType[] = ["user", "feedback", "project", "reference"] as const;

function statsFor(nodes: ReadonlyArray<ArisMemoryNode>): TypeStats[] {
  const counts = new Map<ArisMemoryType, number>();
  for (const t of TYPE_ORDER) counts.set(t, 0);
  for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  return TYPE_ORDER.map((t) => ({ type: t, count: counts.get(t) ?? 0 }));
}

function nodesForType(
  nodes: ReadonlyArray<ArisMemoryNode>,
  type: ArisMemoryType,
): ArisMemoryNode[] {
  return nodes.filter((n) => n.type === type);
}

/**
 * Initial active tab: the first type with content, falling back to "user"
 * when (transiently) every bucket is empty. MemorySidebar only mounts this
 * card when `nodes.length > 0`, so the fallback effectively never fires.
 */
function pickInitialTab(stats: ReadonlyArray<TypeStats>): ArisMemoryType {
  return stats.find((s) => s.count > 0)?.type ?? "user";
}

/**
 * MemoryCard — renders the Aris memory graph as a tabbed `.md`-style
 * document. One tab per memory type (USER · FEEDBACK · PROJECT · REFERENCE);
 * the active tab body is a flowing scroll of every entry in that type with
 * label as heading, description as italic subhead, and content rendered
 * as markdown. Edit/delete affordances are hover-revealed pencil + trash
 * icons on each section heading.
 *
 * Design rationale: replaces the prior nested-accordion layout where each
 * entry was its own bordered button-card. With ~30+ entries in REFERENCE,
 * the button-card list felt like a UI list of rows; users wanted it to feel
 * like opening `reference.md` in an editor — one document, all info inline.
 * Storage stays per-row (the underlying graph is unchanged); this is a
 * pure display-layer redesign.
 */
const MemoryCard = memo(function MemoryCard({ nodes, onSaveContent, onDelete }: MemoryCardProps) {
  const stats = useMemo(() => statsFor(nodes), [nodes]);
  const [activeTab, setActiveTab] = useState<ArisMemoryType>(() => pickInitialTab(stats));
  const activeNodes = useMemo(() => nodesForType(nodes, activeTab), [nodes, activeTab]);

  const [editingNodeId, setEditingNodeId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const switchTab = useCallback((type: ArisMemoryType) => {
    setActiveTab(type);
    // Switching tabs cancels any in-flight per-row state — those flows are
    // bound to a specific node which may not exist on the new tab.
    setEditingNodeId(null);
    setEditDraft("");
    setSaveError(null);
    setConfirmingDeleteId(null);
    setDeleteError(null);
  }, []);

  const startEdit = useCallback((node: ArisMemoryNode) => {
    setEditingNodeId(node.id);
    setEditDraft(node.content ?? "");
    setSaveError(null);
    // Edit and delete-confirm are mutually exclusive UI states.
    setConfirmingDeleteId(null);
    setDeleteError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingNodeId(null);
    setEditDraft("");
    setSaveError(null);
  }, []);

  const saveEdit = useCallback(
    async (node: ArisMemoryNode) => {
      setSaving(true);
      setSaveError(null);
      try {
        await onSaveContent({
          type: node.type,
          label: node.label,
          content: editDraft,
          projectId: node.project_id,
        });
        setEditingNodeId(null);
        setEditDraft("");
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setSaveError(detail);
      } finally {
        setSaving(false);
      }
    },
    [editDraft, onSaveContent],
  );

  const requestDelete = useCallback((node: ArisMemoryNode) => {
    // First click on trash arms confirmation; second click confirms.
    setConfirmingDeleteId(node.id);
    setDeleteError(null);
    // Edit and delete-confirm are mutually exclusive UI states.
    setEditingNodeId(null);
    setSaveError(null);
  }, []);

  const cancelDelete = useCallback(() => {
    setConfirmingDeleteId(null);
    setDeleteError(null);
  }, []);

  const confirmDelete = useCallback(
    async (node: ArisMemoryNode) => {
      setDeleting(true);
      setDeleteError(null);
      try {
        await onDelete({
          type: node.type,
          label: node.label,
          projectId: node.project_id,
        });
        setConfirmingDeleteId(null);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setDeleteError(detail);
      } finally {
        setDeleting(false);
      }
    },
    [onDelete],
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-background/30">
      {/* Card header — overall total */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/40 px-3">
        <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/60 uppercase">
          Memory
        </span>
        <span className="text-[10px] text-muted-foreground/40">
          {nodes.length} {nodes.length === 1 ? "item" : "items"}
        </span>
      </div>

      {/* Tab strip — one tab per memdir type */}
      <div className="flex shrink-0 items-stretch border-b border-border/40">
        {stats.map(({ type, count }) => {
          const isActive = activeTab === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => switchTab(type)}
              className={cn(
                "relative flex flex-1 items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-semibold tracking-widest uppercase transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground/50 hover:text-muted-foreground/80",
              )}
            >
              <span>{type}</span>
              <span className="text-muted-foreground/30">({count})</span>
              {isActive ? (
                <span className="absolute right-0 bottom-[-1px] left-0 h-px bg-foreground/70" />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Active tab body — flowing document */}
      <div className="px-3 py-3">
        {activeNodes.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-muted-foreground/40">
            No {activeTab} memories yet.
          </p>
        ) : (
          <article className="space-y-5">
            {activeNodes.map((node, idx) => {
              const isEditing = editingNodeId === node.id;
              const isConfirmingDelete = confirmingDeleteId === node.id;
              return (
                <section key={node.id} className="group">
                  {idx > 0 ? <hr className="mb-4 border-border/30" /> : null}

                  {/* Heading row — label, description, hover affordances */}
                  <header className="mb-1 flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[13px] leading-snug font-semibold text-foreground/90">
                        {node.label}
                      </h3>
                      {node.description ? (
                        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/55 italic">
                          {node.description}
                        </p>
                      ) : null}
                    </div>
                    {!isEditing && !isConfirmingDelete ? (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => requestDelete(node)}
                          aria-label={`Delete memory: ${node.label}`}
                          className="text-muted-foreground/50 hover:text-red-400/80"
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => startEdit(node)}
                          aria-label={`Edit memory: ${node.label}`}
                          className="text-muted-foreground/50 hover:text-foreground/70"
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                      </div>
                    ) : null}
                  </header>

                  {/* Body — markdown content or edit textarea */}
                  {isEditing ? (
                    <div className="space-y-2">
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        className="min-h-[100px] w-full resize-y rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-[12px] leading-relaxed text-foreground/90 outline-none focus:border-border focus:ring-0"
                        autoFocus
                        disabled={saving}
                      />
                      {saveError ? (
                        <p className="text-[11px] text-red-400/80">{saveError}</p>
                      ) : null}
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={cancelEdit}
                          disabled={saving}
                          aria-label="Cancel edit"
                          className="text-muted-foreground/50 hover:text-foreground/70"
                        >
                          <XIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => void saveEdit(node)}
                          disabled={saving}
                          aria-label="Save edit"
                          className="text-emerald-400/80 hover:text-emerald-400"
                        >
                          <CheckIcon className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-[12px] leading-relaxed text-muted-foreground/85">
                      {node.content ? (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ children, href, ...rest }) => (
                              <a
                                {...rest}
                                href={href}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="text-foreground/80 underline decoration-muted-foreground/30 underline-offset-2 hover:decoration-foreground/60"
                              >
                                {children}
                              </a>
                            ),
                            code: ({ children, ...rest }) => (
                              <code
                                {...rest}
                                className="rounded bg-muted/40 px-1 py-0.5 font-mono text-[11.5px] text-foreground/85"
                              >
                                {children}
                              </code>
                            ),
                            pre: ({ children }) => (
                              <pre className="my-1.5 overflow-x-auto rounded-md border border-border/40 bg-background/40 p-2 font-mono text-[11.5px] leading-relaxed">
                                {children}
                              </pre>
                            ),
                            p: ({ children }) => (
                              <p className="my-1 first:mt-0 last:mb-0">{children}</p>
                            ),
                            ul: ({ children }) => (
                              <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>
                            ),
                            ol: ({ children }) => (
                              <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>
                            ),
                            strong: ({ children }) => (
                              <strong className="font-semibold text-foreground/90">
                                {children}
                              </strong>
                            ),
                            em: ({ children }) => (
                              <em className="text-muted-foreground/90 italic">{children}</em>
                            ),
                          }}
                        >
                          {node.content}
                        </ReactMarkdown>
                      ) : (
                        <span className="text-muted-foreground/30 italic">(empty)</span>
                      )}
                    </div>
                  )}

                  {/* Footer — relative time, or delete-confirm prompt */}
                  {isConfirmingDelete ? (
                    <div className="mt-2 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-red-400/80">Delete this memory?</span>
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={cancelDelete}
                            disabled={deleting}
                            aria-label="Cancel delete"
                            className="text-muted-foreground/50 hover:text-foreground/70"
                          >
                            <XIcon className="size-3.5" />
                          </Button>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => void confirmDelete(node)}
                            disabled={deleting}
                            aria-label="Confirm delete"
                            className="text-red-400/80 hover:text-red-400"
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                      {deleteError ? (
                        <p className="text-[11px] text-red-400/80">{deleteError}</p>
                      ) : null}
                    </div>
                  ) : !isEditing ? (
                    <p className="mt-1.5 text-[10px] text-muted-foreground/30">
                      updated {formatRelative(node.updated_at)}
                    </p>
                  ) : null}
                </section>
              );
            })}
          </article>
        )}
      </div>
    </div>
  );
});

/**
 * aris_db writes timestamps as SQLite's default `YYYY-MM-DD HH:MM:SS` (UTC).
 * Format relative to "now" with coarse buckets — we don't need sub-minute
 * precision for "when was this remembered".
 */
function formatRelative(raw: string): string {
  if (!raw) return "";
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return raw;
  const diffSec = Math.floor((Date.now() - parsed) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.floor(diffDay / 30);
  return `${diffMo}mo ago`;
}

export default MemoryCard;
export type { MemoryCardProps };
