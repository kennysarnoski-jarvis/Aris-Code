import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";

import "../../lib/monaco/monacoSetup";

/**
 * MonacoEditor — thin React wrapper around `monaco.editor.create()`.
 *
 * Deliberately hand-rolled rather than pulling `@monaco-editor/react`:
 * that package adds a CDN-loader abstraction we don't want in an offline
 * Electron app. This wrapper is the whole surface — mount, dispose,
 * keep value/language in sync.
 *
 * `automaticLayout: true` makes Monaco watch its own container size, so
 * the editor reflows when the V2 panel resizes without us wiring a
 * ResizeObserver.
 *
 * Slice 2 scope: read-only rendering with syntax highlighting. Theming
 * (Slice 5) and editability (future) layer on top of this without
 * changing the mount/dispose lifecycle.
 */
export function MonacoEditor(props: { value: string; language: string; readOnly?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // Create the editor exactly once on mount. Value/language changes are
  // handled by the sync effects below — recreating the editor on every
  // prop change would drop scroll position, selection, and undo history.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const editor = monaco.editor.create(container, {
      value: props.value,
      language: props.language,
      readOnly: props.readOnly ?? true,
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
    // Mount-once: props are intentionally excluded — see sync effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the editor's content in sync when `value` changes from outside.
  // Guard on equality so we don't stomp the model (and cursor) when the
  // change actually originated inside the editor.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== props.value) {
      editor.setValue(props.value);
    }
  }, [props.value]);

  // Keep syntax highlighting in sync when `language` changes.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, props.language);
    }
  }, [props.language]);

  // Keep read-only state in sync.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: props.readOnly ?? true });
  }, [props.readOnly]);

  return <div ref={containerRef} className="h-full w-full" />;
}
