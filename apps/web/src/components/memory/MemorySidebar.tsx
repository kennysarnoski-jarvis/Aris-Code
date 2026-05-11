import { memo, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { ScrollArea } from "../ui/scroll-area";
import { useArisMemoryGraph } from "../../useArisMemoryGraph";
import MemoryCard from "./MemoryCard";

interface MemorySidebarProps {
  readonly provider: string | null;
  readonly arisBaseUrl: string;
  readonly arisApiKey: string;
  readonly projectId?: number;
  /**
   * Active thread id + environment id for live event subscription.
   * Threading these through lets `useArisMemoryGraph` listen for
   * `aris.memory.changed` events on the dedicated Aris event channel
   * and auto-refetch when the model saves a memory mid-turn. Optional
   * because non-thread surfaces (preview, etc.) might not have them.
   */
  readonly environmentId?: EnvironmentId | null;
  readonly threadId?: ThreadId | null;
}

/**
 * Width persistence: stored in localStorage so the user's chosen width
 * survives reloads and Electron app restarts. Bounds picked so the panel
 * always fits the four memdir tabs (REFERENCE is the longest label) and
 * never grows past two-thirds of a typical chat window.
 */
const WIDTH_STORAGE_KEY = "t3code:memory-sidebar-width";
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 300;
const MAX_WIDTH = 700;

function clampWidth(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(raw)));
}

function readPersistedWidth(): number {
  // SSR / non-browser fallback. The Electron renderer has window, but the
  // guard keeps the component safe in unit-test environments without DOM.
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    return clampWidth(parseInt(raw, 10));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function writePersistedWidth(width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // localStorage can throw in private browsing or when over quota; the
    // resize still works in-session, just won't persist. Swallow silently.
  }
}

/**
 * MemorySidebar — persistent right-side context panel for Aris-provider
 * threads. Mirrors the structural idiom of PlanSidebar (border-l, ScrollArea
 * content) but adds a left-edge drag handle so the user can widen the panel
 * — REFERENCE entries can be long-form, and the default 340px isn't always
 * enough to keep all four tab labels visible.
 *
 * v1 holds a single Memory card. As more Aris-only context surfaces ship
 * (project context, activity), they drop in here as additional cards
 * conditionally rendered on data availability.
 */
const MemorySidebar = memo(function MemorySidebar({
  provider,
  arisBaseUrl,
  arisApiKey,
  projectId,
  environmentId,
  threadId,
}: MemorySidebarProps) {
  const { nodes, loading, error, upsert, deleteNode } = useArisMemoryGraph({
    provider,
    baseUrl: arisBaseUrl,
    apiKey: arisApiKey,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(environmentId !== undefined ? { environmentId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  });

  const [width, setWidth] = useState<number>(() => readPersistedWidth());

  /**
   * Drag-to-resize on the left edge. The panel sits on the right of the
   * chat column (border-l), so dragging LEFT widens it and dragging RIGHT
   * shrinks it — `delta = startX - currentX` for the widen direction.
   *
   * Pointer capture is set on the handle so the drag survives the cursor
   * leaving the 6px hit area. Persistence happens on pointerup so we don't
   * thrash localStorage on every move.
   */
  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    let lastWidth = startWidth;

    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      lastWidth = clampWidth(startWidth + delta);
      setWidth(lastWidth);
    };
    const onUp = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        // releasePointerCapture throws if the pointer was never captured
        // (e.g. cancel fires before capture is set). Safe to ignore.
      }
      writePersistedWidth(lastWidth);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-l border-border/70 bg-card/50"
      style={{ width: `${width}px` }}
    >
      {/* Drag handle — 6px hit area on the left edge with a 1px hover/active
          accent line so it's discoverable but not visually loud at rest. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Aris Context panel"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        onPointerDown={onHandlePointerDown}
        className="group absolute top-0 bottom-0 left-0 z-10 w-1.5 cursor-ew-resize"
      >
        <div className="absolute top-0 bottom-0 left-0 w-px bg-transparent transition-colors group-hover:bg-border group-active:bg-foreground/40" />
      </div>

      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/60 uppercase">
          Aris Context
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {error ? (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
              <p className="text-[11px] text-red-400/80">Memory failed to load.</p>
              <p className="mt-1 text-[10px] break-all text-muted-foreground/40">{error}</p>
            </div>
          ) : null}

          {nodes && nodes.length > 0 ? (
            <MemoryCard nodes={nodes} onSaveContent={upsert} onDelete={deleteNode} />
          ) : nodes && nodes.length === 0 ? (
            <div className="rounded-lg border border-border/40 bg-background/30 p-4 text-center">
              <p className="text-[12px] text-muted-foreground/50">No memories yet.</p>
              <p className="mt-1 text-[10px] text-muted-foreground/30">
                Aris will start collecting them as you talk.
              </p>
            </div>
          ) : loading ? (
            <div className="rounded-lg border border-border/40 bg-background/30 p-4 text-center">
              <p className="text-[12px] text-muted-foreground/40">Loading memory…</p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default MemorySidebar;
export type { MemorySidebarProps };
