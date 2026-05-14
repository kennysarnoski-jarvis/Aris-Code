import { ArrowLeftIcon, FileCode2Icon } from "lucide-react";

import { Button } from "../ui/button";

/**
 * EditorModeView — the V2 editor mode shell.
 *
 * Slice 1 deliverable: this is intentionally an empty, labeled shell. It
 * proves the main-window Chat/Editor mode switch works end-to-end (route
 * search param → conditional render → back out). Monaco, the file tree,
 * tabs, theming, and agent-edit reflection land in Slices 2–6.
 *
 * It renders in place of `<ChatView>` inside the thread route's
 * `<SidebarInset>` when `?view=editor` is set. `onExitToChat` clears that
 * param (the route owns navigation, so the callback is passed down rather
 * than this component reaching for the router itself).
 */
export function EditorModeView(props: { onExitToChat: () => void }) {
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
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <FileCode2Icon className="mx-auto mb-3 size-8 text-muted-foreground/40" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Editor mode is taking shape. The file tree and Monaco editor land in the next slices —
            for now this shell just proves the Chat/Editor switch works.
          </p>
        </div>
      </div>
    </div>
  );
}
