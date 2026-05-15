import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";

import "../../lib/monaco/monacoSetup";
import { applyMonacoTheme } from "../../lib/monaco/monacoTheme";
import { useTheme } from "../../hooks/useTheme";
import { readLocalApi } from "../../localApi";

/**
 * MonacoEditor — thin React wrapper around `monaco.editor.create()`.
 *
 * Deliberately hand-rolled rather than pulling `@monaco-editor/react`:
 * that package adds a CDN-loader abstraction we don't want in an offline
 * Electron app. This wrapper is the whole surface — mount, dispose,
 * swap models, theme.
 *
 * Model-driven (Slice 6a): the editor instance is created once and
 * lives as long as editor mode is open; each open file is a separate
 * `ITextModel` owned by `EditorModeView`, swapped in via `setModel` on
 * tab switch. That's what preserves per-tab undo history, cursor, and
 * scroll position — re-`setValue`-ing one shared model would drop all
 * three. `EditorModeView` owns model creation/disposal; this component
 * only displays whichever model it's handed (or `null` for none).
 *
 * `automaticLayout: true` makes Monaco watch its own container size, so
 * the editor reflows when the V2 panel resizes without us wiring a
 * ResizeObserver.
 *
 * Cmd-S is bound at the window level in `EditorModeView` so it works
 * regardless of where focus is (file tree, tab strip, anywhere in
 * editor mode) — not on this editor instance.
 *
 * Slice 7c quality-of-life: bracket-pair colorization is on, word wrap
 * is driven by the `wordWrap` prop (toggled from the editor header),
 * and Shift-Alt-F / Shift-Opt-F runs Monaco's format-document action
 * (effective for languages whose workers are wired — JSON/TS/CSS/HTML).
 */
export function MonacoEditor(props: {
  model: monaco.editor.ITextModel | null;
  readOnly?: boolean;
  wordWrap?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const { resolvedTheme } = useTheme();

  // Theme effect — declared *before* the mount effect so the global
  // Monaco theme is defined + active before `monaco.editor.create()`
  // runs (no white-flash on first paint), and re-applied whenever the
  // app's resolved theme flips between light and dark.
  useEffect(() => {
    applyMonacoTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Create the editor exactly once on mount. Models are the swappable
  // unit — recreating the editor per file would drop the widget, its
  // DOM, and its view state. The `setModel` effect below attaches
  // whatever model is active.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const editor = monaco.editor.create(container, {
      model: props.model,
      readOnly: props.readOnly ?? false,
      automaticLayout: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      fontSize: 13,
      lineNumbersMinChars: 3,
      renderLineHighlight: "all",
      bracketPairColorization: { enabled: true },
      wordWrap: props.wordWrap ? "on" : "off",
      // Use Electron's native context menu (cut/copy/paste/selectAll
      // via main.ts's `webContents.on('context-menu')`) instead of
      // Monaco's. Monaco's built-in paste action calls
      // `document.execCommand('paste')`, which Chromium silently blocks
      // for security; the native one routes through `webContents.paste()`
      // and actually pastes. The trade is losing Monaco's right-click
      // menu items (Command Palette, Go to Symbol, etc.) — all reachable
      // via their keyboard shortcuts.
      contextmenu: false,
    });
    editorRef.current = editor;
    // Right-click on a non-empty selection should preserve that
    // selection so the native context menu's Copy/Cut acts on the
    // highlighted text — not on the single word under the click.
    // Monaco's default mousedown otherwise collapses the selection to
    // where you clicked. Capture-phase + stopPropagation runs before
    // Monaco's own listener; only fires for right-clicks landing inside
    // an existing selection so left-click and out-of-selection
    // right-click behave normally.
    const onContainerMouseDown = (event: MouseEvent) => {
      if (event.button !== 2) {
        return;
      }
      const selection = editor.getSelection();
      if (!selection || selection.isEmpty()) {
        return;
      }
      const target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
      if (target?.position && selection.containsPosition(target.position)) {
        event.stopPropagation();
      }
    };
    container.addEventListener("mousedown", onContainerMouseDown, { capture: true });
    // Custom right-click menu. Monaco's selection lives in its internal
    // model — Chromium has no view of it (the visible text is plain
    // <div>s, not contenteditable), so the OS-level
    // `webContents.cut/copy/paste()` can't act on it (active element on
    // right-click is <body>; `window.getSelection()` is empty). We
    // intercept the contextmenu event, suppress the native menu, and
    // show our own via `api.contextMenu.show` — its actions go through
    // Monaco's API (`getValueInRange`, `executeEdits`) and the standard
    // navigator.clipboard, so they actually work on the real selection.
    const onContainerContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      void (async () => {
        const api = readLocalApi();
        if (!api) {
          return;
        }
        const sel = editor.getSelection();
        const model = editor.getModel();
        const hasSelection = !!(sel && !sel.isEmpty());
        const clicked = await api.contextMenu.show(
          [
            { id: "cut" as const, label: "Cut", disabled: !hasSelection },
            { id: "copy" as const, label: "Copy", disabled: !hasSelection },
            { id: "paste" as const, label: "Paste" },
            { id: "selectAll" as const, label: "Select All" },
          ],
          { x: event.clientX, y: event.clientY },
        );
        if (!clicked || !model) {
          return;
        }
        if (clicked === "copy" || clicked === "cut") {
          if (!sel || sel.isEmpty()) {
            return;
          }
          const text = model.getValueInRange(sel);
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            // Permission / focus issue — leave the editor untouched
            // rather than half-doing the cut.
            return;
          }
          if (clicked === "cut") {
            editor.executeEdits("editor-context-menu", [
              { range: sel, text: "", forceMoveMarkers: true },
            ]);
          }
          editor.focus();
          return;
        }
        if (clicked === "paste") {
          let text: string;
          try {
            text = await navigator.clipboard.readText();
          } catch {
            return;
          }
          if (!text) {
            return;
          }
          // Replace the selection if there is one, otherwise insert at
          // the cursor as a zero-width range.
          let insertRange: monaco.IRange;
          if (sel && !sel.isEmpty()) {
            insertRange = sel;
          } else {
            const pos = editor.getPosition();
            if (!pos) {
              return;
            }
            insertRange = new monaco.Range(
              pos.lineNumber,
              pos.column,
              pos.lineNumber,
              pos.column,
            );
          }
          editor.executeEdits("editor-context-menu", [
            { range: insertRange, text, forceMoveMarkers: true },
          ]);
          editor.focus();
          return;
        }
        if (clicked === "selectAll") {
          editor.setSelection(model.getFullModelRange());
          editor.focus();
        }
      })();
    };
    container.addEventListener("contextmenu", onContainerContextMenu);
    // Cmd-S is bound at the window level in `EditorModeView` (capture
    // phase) so it works regardless of focus — we don't add it here so
    // we don't risk double-firing the save callback.
    // Shift-Alt-F (Shift-Opt-F on Mac) formats the document via Monaco's
    // built-in action — a no-op for languages without a registered
    // formatter.
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
      void editor.getAction("editor.action.formatDocument")?.run();
    });
    return () => {
      container.removeEventListener("mousedown", onContainerMouseDown, { capture: true });
      container.removeEventListener("contextmenu", onContainerContextMenu);
      editor.dispose();
      editorRef.current = null;
    };
    // Mount-once: props are intentionally excluded — see sync effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the active model in on tab switch. `setModel` keeps each
  // model's own undo stack / cursor / scroll, which is the whole reason
  // editor mode uses a model per open file. The identity guard avoids a
  // redundant re-set on mount (the editor was already created with it).
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getModel() !== props.model) {
      editor.setModel(props.model);
    }
  }, [props.model]);

  // Keep read-only state in sync.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: props.readOnly ?? false });
  }, [props.readOnly]);

  // Keep word wrap in sync with the header toggle.
  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: props.wordWrap ? "on" : "off" });
  }, [props.wordWrap]);

  return <div ref={containerRef} className="h-full w-full" />;
}
