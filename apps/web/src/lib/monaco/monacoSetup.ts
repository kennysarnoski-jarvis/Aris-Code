/**
 * monacoSetup — wires Monaco's web-worker environment.
 *
 * Monaco spawns its language services in web workers and looks up
 * `globalThis.MonacoEnvironment.getWorker` to construct them when an
 * editor is created. The read-first V2 editor only needs the **core
 * editor worker** — the language-specific workers (ts/json/css/html)
 * power IntelliSense / diagnostics, which read mode doesn't use. Adding
 * those later (when hand-editing lands) is a one-line-per-worker change
 * here.
 *
 * Wired through Vite's native `?worker` import rather than
 * `vite-plugin-monaco-editor` — the plugin has historically lagged Vite
 * major versions and this project is on Vite 8. The `?worker` form
 * bundles the worker correctly for Electron's BrowserWindow (loads from
 * local disk, no CDN fetch).
 *
 * Side-effect module: importing it once (MonacoEditor.tsx does) sets the
 * global before any `monaco.editor.create()` call runs.
 */
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { Environment } from "monaco-editor";

const monacoEnvironment: Environment = {
  getWorker: () => new EditorWorker(),
};

// monaco-editor's own type declarations expose `MonacoEnvironment` as an
// ambient global, so this assignment is type-checked against
// `Environment`. The `globalThis` access keeps it explicit.
globalThis.MonacoEnvironment = monacoEnvironment;
