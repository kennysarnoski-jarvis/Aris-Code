import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, FileCode2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { MonacoEditor } from "./MonacoEditor";
import { FileTree } from "./FileTree";
import { buildFileTree, type FileTreeNode } from "./fileTreeModel";
import { useResizablePaneWidth } from "./useResizablePaneWidth";
import { readEnvironmentApi } from "../../environmentApi";
import { selectProjectByRef, useStore } from "../../store";
import { createThreadSelectorByRef } from "../../storeSelectors";
import { resolveThreadRouteRef } from "../../threadRoutes";

/**
 * EditorModeView — the V2 editor mode shell.
 *
 * Slice 3b-ii: the left pane is now the real recursive file tree, built
 * from `projects.listTree`. Clicking a file reads it through
 * `projects.readFile` and shows it in Monaco (read-only, highlighted).
 * The first non-dotfile is auto-selected on open so there's immediate
 * content. Slices 4–6 layer tabs, theming, and agent-edit reflection on
 * top — this slice doesn't change the readFile/listTree pipes, only how
 * the user drives them.
 *
 * Two independent async state machines: `treeState` (the listTree fetch
 * + built tree) and `fileState` (the readFile fetch for whatever
 * `openFilePath` currently points at). They're separate because the
 * tree loads once per project while the file reloads on every
 * selection.
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

type FileState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "error"; path: string; message: string }
  | { status: "ready"; path: string; contents: string; truncated: boolean };

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
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [fileState, setFileState] = useState<FileState>({ status: "idle" });

  // Effect 1 — load the project tree. Runs once per project. Resets the
  // open-file selection up front so a stale path from the previous
  // project can't briefly drive Effect 2 against the new cwd; the
  // auto-pick below re-seeds it once the fresh index lands.
  useEffect(() => {
    setOpenFilePath(null);
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
          setOpenFilePath(firstFile.path);
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

  // Effect 2 — read whatever file `openFilePath` points at. Re-runs on
  // every selection change.
  useEffect(() => {
    if (!environmentId || !activeCwd || !openFilePath) {
      setFileState({ status: "idle" });
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setFileState({
        status: "error",
        path: openFilePath,
        message: "Environment connection unavailable.",
      });
      return;
    }
    let cancelled = false;
    const path = openFilePath;
    setFileState({ status: "loading", path });
    void (async () => {
      try {
        const result = await api.projects.readFile({ cwd: activeCwd, relativePath: path });
        if (cancelled) {
          return;
        }
        setFileState({
          status: "ready",
          path: result.relativePath,
          contents: result.contents,
          truncated: result.truncated,
        });
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to open file.";
        setFileState({ status: "error", path, message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, activeCwd, openFilePath]);

  const onSelectFile = useCallback((path: string) => {
    setOpenFilePath(path);
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

  const headerPath =
    fileState.status === "ready"
      ? `${fileState.path}${fileState.truncated ? " (truncated)" : ""}`
      : fileState.status === "loading"
        ? fileState.path
        : null;

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
              activePath={openFilePath}
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
        <div className="min-h-0 min-w-0 flex-1">
          {fileState.status === "ready" ? (
            <MonacoEditor
              value={fileState.contents}
              language={languageFromPath(fileState.path)}
              readOnly
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
              {fileState.status === "loading"
                ? "Loading file..."
                : fileState.status === "error"
                  ? fileState.message
                  : "Select a file from the tree to view it."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
