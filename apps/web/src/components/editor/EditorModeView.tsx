import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, FileCode2Icon, FilePlusIcon, WrapTextIcon } from "lucide-react";
import * as monaco from "monaco-editor";

import { Button } from "../ui/button";
import { MonacoEditor } from "./MonacoEditor";
import { FileTree } from "./FileTree";
import { EditorTabStrip } from "./EditorTabStrip";
import { EditorQuickOpen } from "./EditorQuickOpen";
import { buildFileTree, type FileTreeNode } from "./fileTreeModel";
import { useResizablePaneWidth } from "./useResizablePaneWidth";
import { readEnvironmentApi } from "../../environmentApi";
import { readLocalApi } from "../../localApi";
import { selectProjectByRef, useStore } from "../../store";
import { createThreadSelectorByRef } from "../../storeSelectors";
import { resolveThreadRouteRef } from "../../threadRoutes";

/**
 * EditorModeView — the V2 editor mode shell.
 *
 * Multi-tab (Slice 4): clicking a file in the tree opens it as a tab
 * (or re-activates an already-open one); tabs accumulate across the
 * strip above Monaco. Closing a tab falls back to a neighbour.
 *
 * Model-per-tab (Slice 6a-i): each open file is backed by its own
 * Monaco `ITextModel`, held in the `tabStates` cache. The model *is*
 * the buffer — switching tabs swaps `editor.setModel()` rather than
 * re-`setValue`-ing a shared model, so each tab keeps its own undo
 * history, cursor, and scroll. This view owns the full model
 * lifecycle: created when a `readFile` resolves, disposed when the tab
 * closes, the project switches, or editor mode unmounts.
 *
 * Save + dirty tracking (Slice 6a-ii): a tab is dirty when its model's
 * `getAlternativeVersionId()` differs from the version id last written
 * to disk — so undoing back to the saved state clears the dirty mark,
 * the way VS Code behaves. Cmd-S writes the active model through
 * `projects.writeFile`. Truncated files (the readFile size cap was
 * hit) open read-only — writing a truncated buffer back would chop the
 * real file.
 *
 * Unsaved-edit guards (Slice 6c): closing a dirty tab, or leaving
 * editor mode entirely (which unmounts this view and disposes every
 * model), prompts a confirm first — a stray click shouldn't silently
 * drop unsaved work.
 *
 * Quick-open (Slice 7b): Cmd-P opens `EditorQuickOpen`, a fuzzy file
 * palette over `projects.searchEntries`. The keybinding is a
 * window-level listener owned here so it works regardless of focus;
 * the palette component is only mounted while open.
 *
 * Quality-of-life (Slice 7c): Cmd-W closes the active tab (sharing the
 * window-level keydown listener with Cmd-P), and a header toggle drives
 * Monaco word wrap — persisted to localStorage so it survives reloads.
 *
 * New File (Slices 8a/8b): the file-tree header + reveals an inline
 * input that writes an empty file via `projects.writeFile` (which
 * creates parent dirs), reloads the tree, and opens it as a tab.
 * Right-clicking a folder offers "New File" and scopes that same input
 * to the clicked folder — the input shows the folder as a fixed prefix
 * so the destination is always answered. An inline input rather than
 * `window.prompt` — reliable in the Electron renderer, and nicer.
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
  | {
      status: "ready";
      nodes: FileTreeNode[];
      fileCount: number;
      // Flat set of every file path in the project — backs the New File
      // duplicate check without re-walking the nested tree.
      filePaths: ReadonlySet<string>;
    };

/**
 * Per-tab file state. The `ready` variant doubles as the content cache:
 * once a tab is `ready`, switching away and back never refetches. Its
 * `model` is the live Monaco buffer for that file — owned here, and
 * disposed (with its `contentListener`) when the tab/project/view goes
 * away.
 */
type TabFileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      relativePath: string;
      model: monaco.editor.ITextModel;
      // The model's alternative-version-id at the last successful write
      // (or initial load). The tab is dirty once the model moves off it.
      savedVersionId: number;
      // `onDidChangeContent` subscription that recomputes `dirtyPaths`;
      // disposed alongside the model.
      contentListener: monaco.IDisposable;
      truncated: boolean;
    };

const WORD_WRAP_STORAGE_KEY = "aris-editor-word-wrap";

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
  // Paths with unsaved edits — drives the dirty dot in the tab strip.
  // Kept as its own state (not derived) because dirtiness flips on every
  // keystroke via each model's `onDidChangeContent` listener.
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
  // Last save failure, surfaced in the header until the next successful
  // save, a switch to a different tab's error, or a project switch.
  const [saveError, setSaveError] = useState<{ path: string; message: string } | null>(null);
  // Cmd-P fuzzy file palette open/closed.
  const [quickOpenActive, setQuickOpenActive] = useState(false);
  // Editor word wrap — header toggle, persisted across reloads.
  const [wordWrap, setWordWrap] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(WORD_WRAP_STORAGE_KEY) === "on",
  );
  // New File inline input — `null` means not creating. When active,
  // `folderPath` is the destination folder ("" = project root) and
  // `draft` is the in-progress name the user is typing. `newFileError`
  // surfaces a duplicate/write failure beneath the input without a
  // dialog.
  const [newFile, setNewFile] = useState<{ folderPath: string; draft: string } | null>(null);
  const [newFileError, setNewFileError] = useState<string | null>(null);
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const activeTabPathRef = useRef(activeTabPath);
  activeTabPathRef.current = activeTabPath;
  const tabStatesRef = useRef(tabStates);
  tabStatesRef.current = tabStates;
  const dirtyPathsRef = useRef(dirtyPaths);
  dirtyPathsRef.current = dirtyPaths;

  // Effect 1 — load the project tree. Runs once per project. Resets the
  // whole tab strip up front so stale tabs from the previous project
  // can't briefly drive Effect 2 against the new cwd; the auto-pick
  // below re-seeds a single tab once the fresh index lands. The
  // previous project's models are disposed before the reset — they
  // belong to a cwd we're leaving.
  useEffect(() => {
    for (const state of tabStatesRef.current.values()) {
      if (state.status === "ready") {
        state.contentListener.dispose();
        state.model.dispose();
      }
    }
    setOpenTabs([]);
    setActiveTabPath(null);
    setTabStates(new Map());
    setDirtyPaths(new Set());
    setSaveError(null);
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
        setTreeState({
          status: "ready",
          nodes,
          fileCount: files.length,
          filePaths: new Set(files.map((entry) => entry.path)),
        });
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
        // The model is the editable buffer for this tab. Created here on
        // first open and cached in `tabStates`; disposed by the tab
        // close / project switch / unmount paths.
        const model = monaco.editor.createModel(
          result.contents,
          languageFromPath(result.relativePath),
        );
        const savedVersionId = model.getAlternativeVersionId();
        // Recompute this tab's dirty mark on every edit. Reads the
        // *current* `savedVersionId` off the ref so a save (which
        // advances it) is reflected without re-binding the listener.
        const contentListener = model.onDidChangeContent(() => {
          const current = tabStatesRef.current.get(path);
          if (current?.status !== "ready") {
            return;
          }
          const isDirty = model.getAlternativeVersionId() !== current.savedVersionId;
          setDirtyPaths((prev) => {
            if (prev.has(path) === isDirty) {
              return prev;
            }
            const next = new Set(prev);
            if (isDirty) {
              next.add(path);
            } else {
              next.delete(path);
            }
            return next;
          });
        });
        setTabStates((prev) =>
          new Map(prev).set(path, {
            status: "ready",
            relativePath: result.relativePath,
            model,
            savedVersionId,
            contentListener,
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
  // the end. The cached state — including the Monaco model — is dropped;
  // reopening the file refetches and rebuilds a fresh model.
  const onCloseTab = useCallback((path: string) => {
    const current = openTabsRef.current;
    const closingIndex = current.indexOf(path);
    if (closingIndex === -1) {
      return;
    }
    // Closing a dirty tab drops its buffer — confirm first so an
    // unsaved file isn't lost to a stray click on the ×.
    if (
      dirtyPathsRef.current.has(path) &&
      !window.confirm(`${basenameOf(path)} has unsaved changes. Close anyway?`)
    ) {
      return;
    }
    // Dispose the model + its dirty listener before dropping the tab —
    // read off the ref so disposal stays outside the (otherwise pure)
    // state updaters.
    const closingState = tabStatesRef.current.get(path);
    if (closingState?.status === "ready") {
      closingState.contentListener.dispose();
      closingState.model.dispose();
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
    setDirtyPaths((prev) => {
      if (!prev.has(path)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    setSaveError((prev) => (prev?.path === path ? null : prev));
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

  // Dispose every open model + listener when editor mode unmounts (e.g.
  // "Back to Chat"). The tab-close and project-switch paths handle the
  // incremental cases; this catches the wholesale teardown so nothing
  // leaks past the view that owns it.
  useEffect(() => {
    return () => {
      for (const state of tabStatesRef.current.values()) {
        if (state.status === "ready") {
          state.contentListener.dispose();
          state.model.dispose();
        }
      }
    };
  }, []);

  // Window-level keyboard shortcuts for editor mode (capture phase so
  // they fire regardless of focus and win over OS defaults). Bound for
  // the lifetime of editor mode — this view only exists in editor mode.
  //   Cmd/Ctrl-P — open the fuzzy file palette (beats the print shortcut)
  //   Cmd/Ctrl-W — close the active tab (beats closing the window);
  //                with no tab open it falls through to the default.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
        return;
      }
      if (event.code === "KeyP") {
        event.preventDefault();
        setQuickOpenActive(true);
        return;
      }
      if (event.code === "KeyW") {
        const path = activeTabPathRef.current;
        if (path) {
          event.preventDefault();
          onCloseTab(path);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [onCloseTab]);

  // Persist the word-wrap choice so it survives reloads.
  useEffect(() => {
    window.localStorage.setItem(WORD_WRAP_STORAGE_KEY, wordWrap ? "on" : "off");
  }, [wordWrap]);

  // Save the active tab's buffer to disk — invoked by Cmd-S through
  // `MonacoEditor`. No-ops unless the active tab is `ready` and
  // non-truncated: a truncated buffer is only a prefix of the file, so
  // writing it back would chop the rest (the editor also opens
  // truncated files read-only as the first line of defence).
  // `versionId` is captured *before* the await — edits made while the
  // write is in flight keep the tab dirty rather than being silently
  // folded into the saved state.
  const onSave = useCallback(() => {
    const path = activeTabPathRef.current;
    if (!path || !environmentId || !activeCwd) {
      return;
    }
    const state = tabStatesRef.current.get(path);
    if (state?.status !== "ready" || state.truncated) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setSaveError({ path, message: "Environment connection unavailable." });
      return;
    }
    const { model } = state;
    const contents = model.getValue();
    const versionId = model.getAlternativeVersionId();
    void (async () => {
      try {
        await api.projects.writeFile({ cwd: activeCwd, relativePath: path, contents });
        // The tab may have closed (and its model disposed) mid-write.
        const latest = tabStatesRef.current.get(path);
        if (latest?.status !== "ready") {
          return;
        }
        setTabStates((prev) => {
          const entry = prev.get(path);
          if (entry?.status !== "ready") {
            return prev;
          }
          return new Map(prev).set(path, { ...entry, savedVersionId: versionId });
        });
        // Edits that landed during the write leave the tab dirty
        // against the version we just persisted.
        const stillDirty = latest.model.getAlternativeVersionId() !== versionId;
        setDirtyPaths((prev) => {
          if (prev.has(path) === stillDirty) {
            return prev;
          }
          const next = new Set(prev);
          if (stillDirty) {
            next.add(path);
          } else {
            next.delete(path);
          }
          return next;
        });
        setSaveError((prev) => (prev?.path === path ? null : prev));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save file.";
        setSaveError({ path, message });
      }
    })();
  }, [environmentId, activeCwd]);

  // "Back to Chat" fully unmounts editor mode, disposing every model —
  // so any unsaved edits would vanish without a trace. Confirm first
  // when any tab is dirty. Editor mode is a whole-window mode, so this
  // and the per-tab × are the only ways out.
  const onExitToChat = props.onExitToChat;
  const handleExitToChat = useCallback(() => {
    const dirtyCount = dirtyPathsRef.current.size;
    if (dirtyCount > 0) {
      const subject = dirtyCount === 1 ? "file has" : "files have";
      if (
        !window.confirm(
          `${dirtyCount} ${subject} unsaved changes. Leave the editor anyway?`,
        )
      ) {
        return;
      }
    }
    onExitToChat();
  }, [onExitToChat]);

  // Commit the New File inline input: write an empty file, reload the
  // tree so it appears, and open it as a tab. `writeFile` creates any
  // missing parent directories, so a `path/to/new.ts` draft just works.
  // Failures (duplicate path, write error) keep the input open with the
  // reason shown beneath it.
  const commitNewFile = useCallback(() => {
    if (!environmentId || !activeCwd || newFile === null) {
      return;
    }
    const base = newFile.draft.trim();
    if (base.length === 0) {
      setNewFile(null);
      setNewFileError(null);
      return;
    }
    // The destination folder is fixed by where New File was triggered
    // ("" = project root); the user only types the name (or a sub-path).
    const relativePath = newFile.folderPath ? `${newFile.folderPath}/${base}` : base;
    if (treeState.status === "ready" && treeState.filePaths.has(relativePath)) {
      setNewFileError(`"${relativePath}" already exists`);
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setNewFileError("Environment connection unavailable.");
      return;
    }
    void (async () => {
      try {
        const result = await api.projects.writeFile({
          cwd: activeCwd,
          relativePath,
          contents: "",
        });
        // Reload the tree off the (now cache-invalidated) index so the
        // new file shows up. This only touches `treeState` — open tabs
        // and the active selection are left alone.
        const tree = await api.projects.listTree({ cwd: activeCwd });
        const nodes = buildFileTree(tree.entries);
        const files = tree.entries.filter((entry) => entry.kind === "file");
        setTreeState({
          status: "ready",
          nodes,
          fileCount: files.length,
          filePaths: new Set(files.map((entry) => entry.path)),
        });
        setNewFile(null);
        setNewFileError(null);
        onSelectFile(result.relativePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create file.";
        setNewFileError(message);
      }
    })();
  }, [environmentId, activeCwd, newFile, treeState, onSelectFile]);

  // Right-click on a folder row → a "New File" menu scoped to that
  // folder. Picking it opens the inline input with the folder as a
  // fixed prefix, so the user only types the filename.
  const handleFolderContextMenu = useCallback(
    async (folderPath: string, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }
      const clicked = await api.contextMenu.show(
        [{ id: "new-file", label: "New File" }],
        position,
      );
      if (clicked === "new-file") {
        setNewFileError(null);
        setNewFile({ folderPath, draft: "" });
      }
    },
    [],
  );

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
  const activeModel = activeTabState?.status === "ready" ? activeTabState.model : null;
  // Truncated files open read-only — writing back a partial buffer
  // would chop the file. See `onSave`.
  const activeIsTruncated = activeTabState?.status === "ready" && activeTabState.truncated;

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
          {saveError ? (
            <span className="min-w-0 shrink truncate text-xs text-destructive">
              Save failed: {saveError.message}
            </span>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setWordWrap((value) => !value)}
          className={`shrink-0 ${wordWrap ? "bg-accent text-foreground" : ""}`}
          aria-pressed={wordWrap}
          title={wordWrap ? "Word wrap: on" : "Word wrap: off"}
        >
          <WrapTextIcon className="size-3.5" aria-hidden />
        </Button>
        <Button variant="outline" size="sm" onClick={handleExitToChat} className="shrink-0">
          <ArrowLeftIcon className="size-3.5" aria-hidden />
          Back to Chat
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          className="flex shrink-0 flex-col overflow-hidden"
          style={{ width: `${treePaneWidth}px` }}
        >
          {/* File-tree header — the New File affordance. The + reveals
              an inline path input; committing it routes through
              `commitNewFile`. */}
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
            {newFile === null ? (
              <>
                <span className="flex-1 text-xs font-medium text-muted-foreground">Files</span>
                <button
                  type="button"
                  onClick={() => {
                    setNewFileError(null);
                    setNewFile({ folderPath: "", draft: "" });
                  }}
                  disabled={!environmentId || !activeCwd}
                  title="New file"
                  aria-label="New file"
                  className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <FilePlusIcon className="size-3.5" aria-hidden />
                </button>
              </>
            ) : (
              <div className="flex min-w-0 flex-1 items-center">
                {newFile.folderPath ? (
                  <span
                    className="shrink-0 truncate text-xs text-muted-foreground/60"
                    title={newFile.folderPath}
                  >
                    {newFile.folderPath}/
                  </span>
                ) : null}
                <input
                  autoFocus
                  type="text"
                  value={newFile.draft}
                  placeholder={newFile.folderPath ? "new-file.ts" : "path/to/new-file.ts"}
                  onChange={(event) => {
                    setNewFile({ folderPath: newFile.folderPath, draft: event.target.value });
                    setNewFileError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitNewFile();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setNewFile(null);
                      setNewFileError(null);
                    }
                  }}
                  onBlur={() => {
                    setNewFile(null);
                    setNewFileError(null);
                  }}
                  className="h-6 min-w-0 flex-1 rounded-sm bg-transparent px-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                />
              </div>
            )}
          </div>
          {newFileError ? (
            <div className="shrink-0 border-b border-border px-3 py-1 text-xs text-destructive">
              {newFileError}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">
            {treeState.status === "ready" ? (
              treeState.fileCount === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  No files yet — use + above to create one.
                </div>
              ) : (
                <FileTree
                  nodes={treeState.nodes}
                  activePath={activeTabPath}
                  onSelectFile={onSelectFile}
                  onFolderContextMenu={handleFolderContextMenu}
                />
              )
            ) : (
              <div className="p-4 text-sm text-muted-foreground">
                {treeState.status === "loading"
                  ? "Loading files..."
                  : treeState.status === "error"
                    ? treeState.message
                    : "No project workspace available for this thread."}
              </div>
            )}
          </div>
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
            dirtyPaths={dirtyPaths}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
          />
          {/* The editor instance is mounted for the lifetime of editor
              mode — models swap in/out as tabs change. The loading /
              error / empty states render as an opaque overlay rather
              than unmounting Monaco, so the widget (and its view state)
              survives a tab that's mid-fetch. */}
          <div className="relative min-h-0 min-w-0 flex-1">
            <MonacoEditor
              model={activeModel}
              readOnly={activeIsTruncated}
              wordWrap={wordWrap}
              onSave={onSave}
            />
            {activeTabState?.status !== "ready" ? (
              <div className="absolute inset-0 flex items-center justify-center bg-background p-8 text-center text-sm text-muted-foreground">
                {activeTabState?.status === "loading"
                  ? "Loading file..."
                  : activeTabState?.status === "error"
                    ? activeTabState.message
                    : "Select a file from the tree to view it."}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {quickOpenActive && environmentId && activeCwd ? (
        <EditorQuickOpen
          cwd={activeCwd}
          environmentId={environmentId}
          onClose={() => setQuickOpenActive(false)}
          onPickFile={onSelectFile}
        />
      ) : null}
    </div>
  );
}
