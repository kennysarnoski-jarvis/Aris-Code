/**
 * EditorStatusBar — thin strip along the bottom of the editor pane.
 *
 * Shows cursor position (Ln/Col), the active tab's Monaco language id
 * pretty-printed, and the current word-wrap state. Purely presentational —
 * `EditorModeView` derives all three values and resets them as tabs
 * change.
 */
function formatLanguageName(id: string): string {
  switch (id) {
    case "typescript":
      return "TypeScript";
    case "javascript":
      return "JavaScript";
    case "json":
      return "JSON";
    case "html":
      return "HTML";
    case "css":
      return "CSS";
    case "markdown":
      return "Markdown";
    case "yaml":
      return "YAML";
    case "sql":
      return "SQL";
    case "python":
      return "Python";
    case "rust":
      return "Rust";
    case "go":
      return "Go";
    case "shell":
      return "Shell";
    case "toml":
      return "TOML";
    case "plaintext":
      return "Plain Text";
    default:
      return id.length > 0 ? id.charAt(0).toUpperCase() + id.slice(1) : id;
  }
}

export function EditorStatusBar(props: {
  cursor: { line: number; column: number } | null;
  language: string | null;
  wordWrap: boolean;
}) {
  return (
    <div className="flex h-6 shrink-0 items-center justify-end gap-3 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      {props.cursor ? (
        <span className="tabular-nums">
          Ln {props.cursor.line}, Col {props.cursor.column}
        </span>
      ) : null}
      {props.language ? <span>{formatLanguageName(props.language)}</span> : null}
      <span>Wrap: {props.wordWrap ? "on" : "off"}</span>
    </div>
  );
}
