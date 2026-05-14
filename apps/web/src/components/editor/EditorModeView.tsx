import { useEffect, useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, FileCode2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { MonacoEditor } from "./MonacoEditor";
import { readEnvironmentApi } from "../../environmentApi";
import { selectProjectByRef, useStore } from "../../store";
import { createThreadSelectorByRef } from "../../storeSelectors";
import { resolveThreadRouteRef } from "../../threadRoutes";

/**
 * EditorModeView — the V2 editor mode shell.
 *
 * Slice 3a: Monaco shows a *real* file from the open project, fetched
 * through the new `projects.readFile` RPC. The file is auto-picked (the
 * first file in the project index) rather than hardcoded — hardcoding a
 * path like `package.json` can't work across project types (Node,
 * Python, Pine Script...). This slice exists to prove the RPC pipe
 * end-to-end (contract → server → web client → Monaco). Slice 3b adds
 * the file tree so the open file becomes the user's click selection;
 * 4–6 layer tabs, theming, and agent-edit reflection on top.
 *
 * cwd + environmentId are derived from the route here (mirroring
 * `DiffPanel`) rather than threaded as props — keeps the route's editor
 * branch a plain `<EditorModeView onExitToChat=... />`.
 *
 * Default export so the thread route can `React.lazy` it, keeping
 * Monaco (~5MB) out of the cold-start bundle.
 */

/**
 * Minimal extension → Monaco language id map. Slice 3a opens whatever
 * file the index hands back, so the editor needs at least coarse
 * highlighting per file type. Unknown extensions fall back to
 * `plaintext` (e.g. `.pine` — Monaco has no Pine Script grammar). Slice
 * 3b can promote this to a shared helper if the file tree needs it
 * elsewhere.
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

type ReadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      contents: string;
      relativePath: string;
      truncated: boolean;
      /** Total file count in the project index — Slice 3b-i's visible
       *  proof that `listTree` returned the full, uncapped index. */
      fileCount: number;
    };

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

  const [state, setState] = useState<ReadState>({ status: "idle" });

  useEffect(() => {
    if (!environmentId || !activeCwd) {
      setState({ status: "idle" });
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setState({ status: "error", message: "Environment connection unavailable." });
      return;
    }
    // `cancelled` guards against a resolved fetch landing after the
    // user switched threads/projects or left editor mode.
    let cancelled = false;
    setState({ status: "loading" });

    // Slice 3b-i pulls the project's full file index via `listTree`
    // (uncapped, unlike `searchEntries`'s 200-result limit) and
    // auto-picks the first non-dotfile to keep proving the readFile
    // pipe. Slice 3b-ii renders this same index as the clickable file
    // tree; the auto-pick becomes the tree's initial selection.
    void (async () => {
      try {
        const tree = await api.projects.listTree({ cwd: activeCwd });
        if (cancelled) {
          return;
        }
        const files = tree.entries.filter((entry) => entry.kind === "file");
        // Skip dotfiles in the auto-pick — `.DS_Store`, `.gitignore`,
        // etc. are rarely what you want to see first (and `.DS_Store`
        // is binary). The server's binary guard is the real backstop;
        // for the auto-pick, a sensible default beats a junk default.
        const firstFile = files.find((entry) => {
          const slashIndex = entry.path.lastIndexOf("/");
          const basename = slashIndex >= 0 ? entry.path.slice(slashIndex + 1) : entry.path;
          return !basename.startsWith(".");
        });
        if (!firstFile) {
          setState({ status: "error", message: "No files found in this project." });
          return;
        }
        const readResult = await api.projects.readFile({
          cwd: activeCwd,
          relativePath: firstFile.path,
        });
        if (cancelled) {
          return;
        }
        setState({
          status: "ready",
          contents: readResult.contents,
          relativePath: readResult.relativePath,
          truncated: readResult.truncated,
          fileCount: files.length,
        });
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to open file.";
        setState({ status: "error", message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [environmentId, activeCwd]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileCode2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="shrink-0 text-base font-medium">Editor</span>
          {state.status === "ready" ? (
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {state.relativePath}
              {state.truncated ? " (truncated)" : ""}
            </span>
          ) : null}
          {state.status === "ready" ? (
            <span className="shrink-0 text-xs text-muted-foreground/60">
              {state.fileCount} {state.fileCount === 1 ? "file" : "files"}
            </span>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={props.onExitToChat} className="shrink-0">
          <ArrowLeftIcon className="size-3.5" aria-hidden />
          Back to Chat
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {state.status === "ready" ? (
          <MonacoEditor
            value={state.contents}
            language={languageFromPath(state.relativePath)}
            readOnly
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
            {state.status === "loading"
              ? "Loading file..."
              : state.status === "error"
                ? state.message
                : "No project workspace available for this thread."}
          </div>
        )}
      </div>
    </div>
  );
}
