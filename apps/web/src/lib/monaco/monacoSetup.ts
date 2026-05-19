/**
 * monacoSetup — wires Monaco's web-worker environment.
 *
 * Monaco spawns language services in web workers and looks up
 * `globalThis.MonacoEnvironment.getWorker(moduleId, label)` to construct
 * one. The `label` says *which* worker is wanted: `"json"`, `"css"`,
 * `"html"`, `"typescript"` / `"javascript"`, or the core `"editor"`.
 *
 * `MonacoEditor.tsx` does `import * as monaco from "monaco-editor"`,
 * which loads Monaco's full `editor.main` entry — and that registers the
 * JSON / CSS / HTML / TypeScript language services unconditionally. Each
 * of those registers folding / link / document-symbol providers that
 * call into *its own* worker. So every `label` has to resolve to the
 * matching worker bundle: handing the bare `editor.worker` to a
 * `"json"` request means `findDocumentLinks` / `getFoldingRanges` /
 * `findDocumentSymbols` don't exist on it, and the editor throws
 * `Missing requestHandler` the moment a JSON/TS/CSS/HTML file is opened.
 *
 * Wired through Vite's native `?worker` import rather than
 * `vite-plugin-monaco-editor` — the plugin has historically lagged Vite
 * major versions and this project is on Vite 8. The `?worker` form
 * bundles each worker correctly for Electron's BrowserWindow (loads from
 * local disk, no CDN fetch).
 *
 * Side-effect module: importing it once (MonacoEditor.tsx does) sets the
 * global before any `monaco.editor.create()` call runs.
 */
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import type { Environment } from "monaco-editor";

const monacoEnvironment: Environment = {
  getWorker(_moduleId, label) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

// monaco-editor's own type declarations expose `MonacoEnvironment` as an
// ambient global, so this assignment is type-checked against
// `Environment`. The `globalThis` access keeps it explicit.
globalThis.MonacoEnvironment = monacoEnvironment;
