import { useCallback, useRef, useState } from "react";

/**
 * useResizablePaneWidth — drag-to-resize width state for an editor-mode
 * pane, persisted to localStorage so the user's choice survives reloads.
 *
 * Returns the current `width` (px) and an `onResizeHandleMouseDown`
 * handler to wire onto a thin divider element. The drag attaches
 * window-level listeners (so the pointer can outrun the handle without
 * the drag dropping) and forces a global `col-resize` cursor + disables
 * text selection for the duration.
 *
 * localStorage-backed width persistence mirrors the bespoke `Sidebar`
 * system's `resizable.storageKey` pattern — same idea, lighter weight,
 * since editor mode's tree pane isn't part of that offcanvas system.
 */
interface ResizablePaneWidthOptions {
  readonly storageKey: string;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
}

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") {
    return fallback;
  }
  const raw = window.localStorage.getItem(key);
  if (raw === null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? clampWidth(parsed, min, max) : fallback;
}

export function useResizablePaneWidth(options: ResizablePaneWidthOptions): {
  readonly width: number;
  readonly onResizeHandleMouseDown: (event: React.MouseEvent) => void;
} {
  const { storageKey, defaultWidth, minWidth, maxWidth } = options;
  const [width, setWidth] = useState(() =>
    readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth),
  );
  // Latest width in a ref so the mouseup persist handler reads the final
  // value without `width` being in the drag closure (which would re-bind
  // listeners on every resize pixel).
  const widthRef = useRef(width);
  widthRef.current = width;

  const onResizeHandleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        setWidth(clampWidth(startWidth + (moveEvent.clientX - startX), minWidth, maxWidth));
      };
      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
        window.localStorage.setItem(storageKey, String(widthRef.current));
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      // Force the resize cursor + kill text selection globally for the
      // duration of the drag so it feels solid even when the pointer
      // moves faster than the thin handle can follow.
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [storageKey, minWidth, maxWidth],
  );

  return { width, onResizeHandleMouseDown };
}
