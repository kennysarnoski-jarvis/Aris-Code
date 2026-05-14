import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * EditorTabStrip — the open-files tab bar above the Monaco pane in V2
 * editor mode.
 *
 * Each tab shows the file's basename (full path on hover via `title`),
 * click to switch, × to close. The strip scrolls horizontally when more
 * tabs are open than fit. Renders nothing when no tabs are open — the
 * editor area shows its empty state instead.
 *
 * Purely presentational: open/close/switch logic + the per-tab content
 * cache live in `EditorModeView`.
 */
function basenameOf(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
}

export function EditorTabStrip(props: {
  tabs: readonly string[];
  activeTabPath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
}) {
  if (props.tabs.length === 0) {
    return null;
  }
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-background">
      {props.tabs.map((path) => {
        const isActive = path === props.activeTabPath;
        const name = basenameOf(path);
        return (
          <div
            key={path}
            className={cn(
              "group flex shrink-0 items-center gap-1.5 border-r border-border pr-1.5 pl-3 text-sm",
              isActive
                ? "bg-card text-foreground"
                : "bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => props.onSelectTab(path)}
              className="max-w-[12rem] truncate"
              title={path}
            >
              {name}
            </button>
            <button
              type="button"
              onClick={() => props.onCloseTab(path)}
              aria-label={`Close ${name}`}
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 hover:bg-accent hover:text-foreground",
                // Close button stays visible on the active tab; on
                // inactive tabs it reveals on hover so the strip stays
                // calm when many files are open.
                isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              <XIcon className="size-3" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
