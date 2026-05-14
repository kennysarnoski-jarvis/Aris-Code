import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, FileCode2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { MonacoEditor } from "./MonacoEditor";
import { FileTree } from "./FileTree";
import { EditorTabStrip } from "./EditorTabStrip";
import { buildFileTree, type FileTreeNode } from "./fileTreeModel";
import { useResizablePaneWidth } from "./useResizablePaneWidth";
import { readEnvironmentApi } from "../../environmentApi";
import { selectProjectByRef, useStore } from "../../store";
import { createThreadSelectorByRef } from "../../storeSelectors";
import { resolveThreadRouteRef } from "../../threadRoutes";

/**
 * EditorModeView — the V2 editor mode shell.
 *
 * Slice 4: the editor is now multi-tab. Clicking a file in the tree
 * opens it as a tab (or re-activates an already-open one); tabs
 * accumulate across the strip above Monaco. Each tab's fetched contents
 * are kept in a per-path cache (`tabStates`) so switching back to an
 * already-loaded tab is instant — only the first open of a file hits
 * the `readFile` RPC. Closing a tab falls back to a neighbour.
 *
 * Slices 5–6 layer theming and agent-edit reflection on top — this
 * slice doesn't change the readFile/listTree pipes, only how many
 * files can be open at once.
 *
 * Two independent async state machines: `treeState` (the listTree fetch
 * + built tree) and the per-tab `tabStates` cache (a `readFile` fetch
 * per distinct file the user has opened). They're separate because the
 * tree loads once per project while files load lazily on first open.
 *
 * cwd + environmentId are derived from the route here (mirroring
 * `DiffPanel`). Default export so the thread route can `React.lazy` it,
 * keeping Monaco (~5MB) out of the cold-start bundle.
 */

/**
 * Minimal extension → Monaco language id map. Unknown extensions fall
 * back to `plaintext` (e.g. `.pine` — Monaco has no Pine Script
 * grammar). Slice 3b-ii promotes this to a file-scoped helper since the
 * tree opens arbitrary file types now.
 */
function languageFromPath(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  const ext = lastDot >= 0 ? filePath.slice(lastDot + 1).toLowerCase() : "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "py":
      return "python";
    case "md":
    case "mdx":
      return "markdown";
    case "css":
      return "css";
    case "html":
      return "html";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "sh":
    case "bash":
      return "shell";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
      return "toml";
    case "sql":
      return "sql";
    default:
      return "plaintext";
  }
}

function basenameOf(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
}

type TreeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; nodes: FileTreeNode[]; fileCount: number };

/**
 * Per-tab file state. The `ready` variant doubles as the content cache:
 * once a tab is `ready`, switching away and back never refetches.
 */
type TabFileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; relativePath: string; contents: string; truncated: boolean };

export default function EditorModeView(props: { onExitToChat: () => void }) {
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeThread && activeProjectId
      ? selectProjectByRef(store, {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        })
      : undefined,
  );
  const environmentId = activeThread?.environmentId ?? null;
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;

  const [treeState, setTreeState] = useState<TreeState>({ status: "idle" });
  // Multi-tab state. `openTabs` is the ordered strip; `activeTabPath`
  // points at the focused tab; `tabStates` caches each tab's fetched
  // contents keyed by path. Refs mirror the latter two so the close
  // handler and Effect 2 can read the freshest values synchronously
  // without re-binding on every keystroke-equivalent change.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [tabStates, setTabStates] = useState<Map<string, TabFileState>>(new Map());
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const tabStatesRef = useRef(tabStates);
  tabStatesRef.current = tabStates;

  // Effect 1 — load the project tree. Runs once per project. Resets the
  // whole tab strip up front so stale tabs from the previous project
  // can't briefly drive Effect 2 against the new cwd; the auto-pick
  // below re-seeds a single tab once the fresh index lands.
  useEffect(() => {
    setOpenTabs([]);
    setActiveTabPath(null);
    setTabStates(new Map());
    if (!environmentId || !activeCwd) {
      setTreeState({ status: "idle" });
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setTreeState({ status: "error", message: "Environment connection unavailable." });
      return;
    }
    // `cancelled` guards against a resolved fetch landing after the user
    // switched threads/projects or left editor mode.
    let cancelled = false;
    setTreeState({ status: "loading" });
    void (async () => {
      try {
        const tree = await api.projects.listTree({ cwd: activeCwd });
        if (cancelled) {
          return;
        }
        const nodes = buildFileTree(tree.entries);
        const files = tree.entries.filter((entry) => entry.kind === "file");
        setTreeState({ status: "ready", nodes, fileCount: files.length });
        // Auto-pick the first non-dotfile for immediate content. Dotfiles
        // (`.DS_Store`, `.gitignore`, ...) are rarely what you want first
        // and `.DS_Store` is binary; the server's binary guard is still
        // the real backstop when the user clicks one in the tree.
        const firstFile = files.find((entry) => !basenameOf(entry.path).startsWith("."));
        if (firstFile) {
          setOpenTabs([firstFile.path]);
          setActiveTabPath(firstFile.path);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to load project files.";
        setTreeState({ status: "error", message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, activeCwd]);

  // Effect 2 — read whatever file `activeTabPath` points at, unless it's
  // already cached. Re-runs on every tab switch, but a cache hit
  // (`ready` or `error`) returns immediately so only the first open of
  // a given file hits the RPC.
  useEffect(() => {
    if (!environmentId || !activeCwd || !activeTabPath) {
      return;
    }
    const cached = tabStatesRef.current.get(activeTabPath);
    if (cached && cached.status !== "loading") {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setTabStates((prev) =>
        new Map(prev).set(activeTabPath, {
          status: "error",
          message: "Environment connection unavailable.",
        }),
      );
      return;
    }
    let cancelled = false;
    const path = activeTabPath;
    setTabStates((prev) => new Map(prev).set(path, { status: "loading" }));
    void (async () => {
      try {
        const result = await api.projects.readFile({ cwd: activeCwd, relativePath: path });
        if (cancelled) {
          return;
        }
        setTabStates((prev) =>
          new Map(prev).set(path, {
            status: "ready",
            relativePath: result.relativePath,
            contents: result.contents,
            truncated: result.truncated,
          }),
        );
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to open file.";
        setTabStates((prev) => new Map(prev).set(path, { status: "error", message }));
      }
    })();
    return () => {
      cancelled = true;
      // Drop a still-pending `loading` entry so re-activating this tab
      // refetches instead of being stuck on a cache hit that never
      // resolved. A `ready`/`error` entry that landed before cleanup is
      // left intact — that's the cache doing its job.
      setTabStates((prev) => {
        const entry = prev.get(path);
        if (!entry || entry.status !== "loading") {
          return prev;
        }
        const next = new Map(prev);
        next.delete(path);
        return next;
      });
    };
  }, [environmentId, activeCwd, activeTabPath]);

  // Tree click — open the file as a tab (or re-activate it if already
  // open) and focus it. New tabs append to the end of the strip.
  const onSelectFile = useCallback((path: string) => {
    setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveTabPath(path);
  }, []);

  const onSelectTab = useCallback((path: string) => {
    setActiveTabPath(path);
  }, []);

  // Close a tab. Reads `openTabsRef` so the neighbour computation sees
  // the live strip even if multiple closes land in one tick. When the
  // active tab closes, focus falls to the tab that took its index slot
  // (i.e. the former right neighbour), or the new last tab if it was at
  // the end. The cached content is dropped — reopening refetches.
  const onCloseTab = useCallback((path: string) => {
    const current = openTabsRef.current;
    const closingIndex = current.indexOf(path);
    if (closingIndex === -1) {
      return;
    }
    const nextTabs = current.filter((tab) => tab !== path);
    setOpenTabs(nextTabs);
    setTabStates((prev) => {
      if (!prev.has(path)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    setActiveTabPath((prevActive) => {
      if (prevActive !== path) {
        return prevActive;
      }
      if (nextTabs.length === 0) {
        return null;
      }
      const fallbackIndex = Math.min(closingIndex, nextTabs.length - 1);
      return nextTabs[fallbackIndex] ?? null;
    });
  }, []);

  // Resizable tree pane — long file paths get clipped at a fixed width,
  // so the user drags the divider to size it. Width persists across
  // reloads.
  const { width: treePaneWidth, onResizeHandleMouseDown } = useResizablePaneWidth({
    storageKey: "aris-editor-tree-width",
    defaultWidth: 256,
    minWidth: 160,
    maxWidth: 600,
  });

  const activeTabState = activeTabPath ? (tabStates.get(activeTabPath) ?? null) : null;

  const headerPath =
    activeTabState?.status === "ready"
      ? `${activeTabState.relativePath}${activeTabState.truncated ? " (truncated)" : ""}`
      : activeTabPath;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileCode2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="shrink-0 text-base font-medium">Editor</span>
          {headerPath ? (
            <span className="min-w-0 truncate text-sm text-muted-foreground">{headerPath}</span>
          ) : null}
          {treeState.status === "ready" ? (
            <span className="shrink-0 text-xs text-muted-foreground/60">
              {treeState.fileCount} {treeState.fileCount === 1 ? "file" : "files"}
            </span>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={props.onExitToChat} className="shrink-0">
          <ArrowLeftIcon className="size-3.5" aria-hidden />
          Back to Chat
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="shrink-0 overflow-auto" style={{ width: `${treePaneWidth}px` }}>
          {treeState.status === "ready" ? (
            <FileTree
              nodes={treeState.nodes}
              activePath={activeTabPath}
              onSelectFile={onSelectFile}
            />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              {treeState.status === "loading"
                ? "Loading files..."
                : treeState.status === "error"
                  ? treeState.message
                  : "No project workspace available for this thread."}
            </div>
          )}
        </aside>
        {/* Drag handle — doubles as the visual divider between the tree
            pane and the editor. Wider than a 1px border so it's an
            easy grab target. */}
        <div
          onMouseDown={onResizeHandleMouseDown}
          className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-foreground/25"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file tree"
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <EditorTabStrip
            tabs={openTabs}
            activeTabPath={activeTabPath}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
          />
          <div className="min-h-0 min-w-0 flex-1">
            {activeTabState?.status === "ready" ? (
              <MonacoEditor
                value={activeTabState.contents}
                language={languageFromPath(activeTabState.relativePath)}
                readOnly
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                {activeTabState?.status === "loading"
                  ? "Loading file..."
                  : activeTabState?.status === "error"
                    ? activeTabState.message
                    : "Select a file from the tree to view it."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
