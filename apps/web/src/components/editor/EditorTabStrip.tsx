import { PlusIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * Tab descriptor — the minimal info `EditorTabStrip` needs to render
 * one tab. `EditorModeView` builds these from the tab id + state map;
 * the strip itself doesn't know whether a tab is backed by a file or
 * an untitled buffer.
 */
export interface EditorTabStripItem {
  /** Stable tab identity. May or may not be a file path. */
  id: string;
  /** Visible label (file basename, "Untitled-N", …). */
  label: string;
  /** Tooltip — full path for files, label for untitled. */
  title: string;
}

/**
 * EditorTabStrip — the open-files tab bar above the Monaco pane in V2
 * editor mode.
 *
 * Each tab shows its label (full title on hover via `title`), click to
 * switch, × to close. The strip scrolls horizontally when more tabs
 * are open than fit. Renders nothing when no tabs are open — the editor
 * area shows its empty state instead.
 *
 * A tab with unsaved edits (`dirtyTabIds`) shows a dot in place of the ×;
 * the × reveals on hover so the tab is still closable. Open/close/switch
 * logic, the per-tab content cache, and dirty tracking all live in
 * `EditorModeView` — this strip is purely presentational.
 *
 * A trailing + button (when `onNewUntitled` is provided) opens a fresh
 * in-memory untitled buffer.
 */
export function EditorTabStrip(props: {
  tabs: readonly EditorTabStripItem[];
  activeTabId: string | null;
  dirtyTabIds: ReadonlySet<string>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewUntitled?: () => void;
}) {
  if (props.tabs.length === 0 && !props.onNewUntitled) {
    return null;
  }
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-background">
      {props.tabs.map((tab) => {
        const isActive = tab.id === props.activeTabId;
        const isDirty = props.dirtyTabIds.has(tab.id);
        return (
          <div
            key={tab.id}
            className={cn(
              "group flex shrink-0 items-center gap-1.5 border-r border-border pr-1.5 pl-3 text-sm",
              isActive
                ? "bg-card text-foreground"
                : "bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => props.onSelectTab(tab.id)}
              className="max-w-[12rem] truncate"
              title={tab.title}
            >
              {tab.label}
            </button>
            {/* Dot + × share one slot. The dirty dot shows by default
                and fades out on hover; the × fades in to take its
                place so a dirty tab is still closable. A clean tab has
                no dot — the close button keeps its prior behaviour:
                always visible on the active tab, hover-revealed
                otherwise, so the strip stays calm with many files
                open. */}
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              {isDirty ? (
                <span
                  aria-hidden
                  className="absolute size-1.5 rounded-full bg-red-500 transition-opacity group-hover:opacity-0"
                />
              ) : null}
              <button
                type="button"
                onClick={() => props.onCloseTab(tab.id)}
                aria-label={`Close ${tab.label}`}
                className={cn(
                  "flex size-4 items-center justify-center rounded-sm text-muted-foreground/60 transition-opacity hover:bg-accent hover:text-foreground",
                  isDirty
                    ? "opacity-0 group-hover:opacity-100"
                    : isActive
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100",
                )}
              >
                <XIcon className="size-3" aria-hidden />
              </button>
            </span>
          </div>
        );
      })}
      {props.onNewUntitled ? (
        <button
          type="button"
          onClick={props.onNewUntitled}
          title="New file"
          aria-label="New file"
          className="flex shrink-0 items-center justify-center px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PlusIcon className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
