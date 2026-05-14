import { ArrowLeftIcon, FileCode2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { MonacoEditor } from "./MonacoEditor";

/**
 * EditorModeView — the V2 editor mode shell.
 *
 * Slice 2: Monaco now renders inside the shell, read-only, with syntax
 * highlighting, fed hardcoded content. This proves the worker wiring +
 * mount lifecycle work inside Electron's BrowserWindow. Real file
 * opening (file tree + `projects.readFile` RPC) lands in Slice 3; tabs,
 * theming, and agent-edit reflection follow in 4–6.
 *
 * Renders in place of `<ChatView>` inside the thread route's
 * `<SidebarInset>` when `?view=editor` is set. `onExitToChat` clears that
 * param (the route owns navigation, so the callback comes down as a prop
 * rather than this component reaching for the router itself).
 *
 * Default export so the thread route can `React.lazy` it — that keeps
 * Monaco (~5MB) out of the cold-start bundle, only loaded when the user
 * actually switches into editor mode.
 */

// Slice 2 placeholder content — replaced by real file contents in Slice 3.
const PLACEHOLDER_CONTENT = `// Aris Code — V2 editor (Slice 2)
//
// This is hardcoded placeholder content. It exists to prove Monaco
// mounts, the web-worker wiring resolves inside Electron, and syntax
// highlighting works. Slice 3 wires the file tree + projects.readFile
// RPC so this becomes the actual file you clicked.

interface EditorSlicePlan {
  slice: number;
  title: string;
  done: boolean;
}

const plan: EditorSlicePlan[] = [
  { slice: 1, title: "Chat/Editor mode toggle", done: true },
  { slice: 2, title: "Monaco renders in Editor mode", done: true },
  { slice: 3, title: "File tree + projects.readFile RPC", done: false },
  { slice: 4, title: "Multi-tab editor", done: false },
  { slice: 5, title: "Monaco theming bridge", done: false },
  { slice: 6, title: "Agent-edit reflection", done: false },
];

export function nextSlice(): EditorSlicePlan | undefined {
  return plan.find((entry) => !entry.done);
}
`;

export default function EditorModeView(props: { onExitToChat: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileCode2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-base font-medium">Editor</span>
        </div>
        <Button variant="outline" size="sm" onClick={props.onExitToChat} className="shrink-0">
          <ArrowLeftIcon className="size-3.5" aria-hidden />
          Back to Chat
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        <MonacoEditor value={PLACEHOLDER_CONTENT} language="typescript" readOnly />
      </div>
    </div>
  );
}
