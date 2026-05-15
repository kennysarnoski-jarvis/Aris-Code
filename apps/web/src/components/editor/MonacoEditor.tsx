import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";

import "../../lib/monaco/monacoSetup";
import { applyMonacoTheme } from "../../lib/monaco/monacoTheme";
import { useTheme } from "../../hooks/useTheme";

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
 */
export function MonacoEditor(props: {
  model: monaco.editor.ITextModel | null;
  readOnly?: boolean;
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
    });
    editorRef.current = editor;
    return () => {
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

  return <div ref={containerRef} className="h-full w-full" />;
}
