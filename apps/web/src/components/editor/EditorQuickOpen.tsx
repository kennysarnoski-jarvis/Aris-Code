import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { readEnvironmentApi } from "../../environmentApi";
import { useTheme } from "../../hooks/useTheme";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";

/**
 * EditorQuickOpen — Cmd-P fuzzy file palette for V2 editor mode.
 *
 * A modal overlay: type to fuzzy-search the project, ↑/↓ to move, Enter
 * to open the highlighted file as a tab, Esc (or a backdrop click) to
 * dismiss. The search itself is the existing `projects.searchEntries`
 * RPC — this component is just the keyboard-driven UI over it.
 *
 * `EditorModeView` owns the open/closed state and the Cmd-P keybinding;
 * it only mounts this component while the palette is open, so the
 * input's autofocus and the debounced search fire once per opening.
 */

const SEARCH_DEBOUNCE_MS = 120;
const RESULT_LIMIT = 50;
// `searchEntries` rejects an empty query; "." is the workspace index's
// match-all token, so the list is populated the moment the palette opens.
const MATCH_ALL_QUERY = ".";

function basenameOf(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
}

function dirnameOf(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex >= 0 ? path.slice(0, slashIndex) : "";
}

type QuickOpenState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; files: ProjectEntry[]; truncated: boolean };

export function EditorQuickOpen(props: {
  cwd: string;
  environmentId: EnvironmentId;
  onClose: () => void;
  onPickFile: (path: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<QuickOpenState>({ status: "loading" });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);

  // Autofocus the input the moment the palette opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced fuzzy search. An empty query falls back to the index's
  // match-all token, so the palette shows files immediately on open and
  // never has to render a blank state.
  useEffect(() => {
    const trimmed = query.trim();
    const searchQuery = trimmed.length > 0 ? trimmed : MATCH_ALL_QUERY;
    let cancelled = false;
    const timer = setTimeout(() => {
      const api = readEnvironmentApi(props.environmentId);
      if (!api) {
        setState({ status: "error", message: "Environment connection unavailable." });
        return;
      }
      void (async () => {
        try {
          const result = await api.projects.searchEntries({
            cwd: props.cwd,
            query: searchQuery,
            limit: RESULT_LIMIT,
          });
          if (cancelled) {
            return;
          }
          // Quick-open opens files; directories in the index aren't
          // actionable here, so they're dropped from the list.
          const files = result.entries.filter((entry) => entry.kind === "file");
          setState({ status: "ready", files, truncated: result.truncated });
          setSelectedIndex(0);
        } catch (err) {
          if (cancelled) {
            return;
          }
          const message = err instanceof Error ? err.message : "Search failed.";
          setState({ status: "error", message });
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, props.cwd, props.environmentId]);

  // Keep the highlighted row in view as ↑/↓ moves the selection.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const files = state.status === "ready" ? state.files : [];

  const pickFile = (path: string) => {
    props.onPickFile(path);
    props.onClose();
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, Math.max(files.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = files[selectedIndex];
      if (picked) {
        pickFile(picked.path);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(event) => {
        // Backdrop click closes; clicks inside the panel keep it open
        // (their target is the panel/its children, not this element).
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div className="flex max-h-[60vh] w-[36rem] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
        <input
          ref={inputRef}
          type="text"
          value={query}
          maxLength={256}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Search files by name…"
          className="shrink-0 border-b border-border bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {state.status === "error" ? (
            <p className="px-3 py-2 text-sm text-destructive">{state.message}</p>
          ) : files.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {state.status === "loading" ? "Searching…" : "No matching files"}
            </p>
          ) : (
            files.map((file, index) => {
              const isSelected = index === selectedIndex;
              return (
                <button
                  key={file.path}
                  ref={isSelected ? selectedRowRef : undefined}
                  type="button"
                  onClick={() => pickFile(file.path)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                    isSelected ? "bg-accent text-foreground" : "text-muted-foreground",
                  )}
                >
                  <VscodeEntryIcon
                    pathValue={file.path}
                    kind="file"
                    theme={resolvedTheme}
                    className="size-4"
                  />
                  <span className="shrink-0 truncate text-foreground">{basenameOf(file.path)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
                    {dirnameOf(file.path)}
                  </span>
                </button>
              );
            })
          )}
        </div>
        {state.status === "ready" && state.truncated ? (
          <p className="shrink-0 border-t border-border px-3 py-1 text-xs text-muted-foreground/60">
            Showing the first {RESULT_LIMIT} matches — narrow your search to see more
          </p>
        ) : null}
      </div>
    </div>
  );
}
