/**
 * monacoTheme — bridges Aris Code's CSS-variable palette into Monaco's
 * theme system.
 *
 * Monaco's `defineTheme` only accepts concrete color strings — it can't
 * read `var(--background)`, `color-mix()`, or `oklch()`. Rather than
 * hardcoding a copy of the palette (which would drift the moment
 * `index.css` changes), we resolve the *live computed values* off the
 * DOM at apply time via a throwaway probe element. The probe inherits
 * the current `.dark` class state, so the same code path produces the
 * light or dark palette depending on what the app is currently showing.
 *
 * `inherit: true` keeps VS Code's well-tuned syntax token colors
 * (keywords / strings / comments) — we only re-skin the editor *chrome*
 * (background, gutter, line highlight, cursor) so the editor surface
 * blends into the app instead of sitting on VS-Code grey.
 */
import * as monaco from "monaco-editor";

const LIGHT_THEME = "aris-light";
const DARK_THEME = "aris-dark";

/**
 * App palette variables the editor chrome maps onto. Resolved together
 * in one probe pass so a theme apply is a single DOM round-trip.
 */
const PALETTE_VARS = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--border",
  "--card",
] as const;

type PaletteVar = (typeof PALETTE_VARS)[number];

/**
 * Resolve the app palette variables to concrete `#RRGGBB(AA)` hex
 * strings Monaco can consume.
 *
 * Each var is read through a probe `<span>` whose `color` is set to
 * `color-mix(in srgb, var(--x), var(--x))`. The `color-mix(in srgb, …)`
 * wrapper is load-bearing: mixing a color with itself is an identity
 * op, but doing it *in srgb* forces the browser to perform every
 * color-space conversion for us — Tailwind v4's palette is oklch-based,
 * and this collapses it to sRGB. Chromium then serialises the computed
 * value as `color(srgb r g b [/ a])` with channels in **0–1**, which
 * `colorToHex` scales to 0–255.
 *
 * Earlier attempts died here. A bare `var(--x)` comes back as
 * `oklch(…)`; and a `<canvas>` `fillStyle` round-trip does *not*
 * normalise it — current Chromium hands `color(srgb …)` straight back
 * out of the getter untouched, so the fractional channels got misread
 * as 0–255 and floored to `#000000`.
 */
function resolvePalette(): Map<PaletteVar, string> {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.opacity = "0";
  probe.style.pointerEvents = "none";
  document.body.append(probe);
  const resolved = new Map<PaletteVar, string>();
  try {
    for (const cssVar of PALETTE_VARS) {
      probe.style.color = `color-mix(in srgb, var(${cssVar}), var(${cssVar}))`;
      resolved.set(cssVar, colorToHex(getComputedStyle(probe).color));
    }
  } finally {
    probe.remove();
  }
  return resolved;
}

/**
 * Convert a computed sRGB color string to a hex string Monaco accepts
 * (`#RRGGBB`, or `#RRGGBBAA` when translucent).
 *
 * Handles the shapes the `color-mix(in srgb, …)` probe can yield:
 *  - `color(srgb r g b [/ a])` — RGB channels in 0–1
 *  - `rgb(r g b [/ a])` / `rgba(r, g, b, a)` — RGB channels in 0–255
 * plus a passthrough for an already-hex value. The alpha channel is
 * 0–1 in every notation, so it is never scaled with the RGB channels.
 */
function colorToHex(value: string): string {
  const v = value.trim();
  if (v.startsWith("#")) {
    return v;
  }
  const nums = v.match(/[\d.]+/g)?.map(Number) ?? [];
  const [c0 = 0, c1 = 0, c2 = 0, alpha] = nums;
  // `color(srgb …)` channels are 0–1; `rgb()/rgba()` are already 0–255.
  const rgbScale = v.startsWith("color(") ? 255 : 1;
  const toHex = (n: number) =>
    Math.min(255, Math.max(0, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  const base = `#${toHex(c0 * rgbScale)}${toHex(c1 * rgbScale)}${toHex(c2 * rgbScale)}`;
  if (alpha === undefined || alpha >= 1) {
    return base;
  }
  return `${base}${toHex(alpha * 255)}`;
}

/**
 * Define + activate the Monaco theme matching the app's current
 * resolved theme. Safe to call repeatedly — `defineTheme` is idempotent
 * on a given name, and `setTheme` is the global switch. Call this on
 * editor mount and whenever the app's resolved theme flips.
 */
export function applyMonacoTheme(resolved: "light" | "dark"): void {
  const palette = resolvePalette();
  const isDark = resolved === "dark";
  const pick = (cssVar: PaletteVar, fallback: string) => palette.get(cssVar) ?? fallback;

  const background = pick("--background", isDark ? "#0a0a0a" : "#ffffff");
  const foreground = pick("--foreground", isDark ? "#f5f5f5" : "#262626");
  const border = pick("--border", isDark ? "#ffffff10" : "#00000014");

  const themeName = isDark ? DARK_THEME : LIGHT_THEME;
  monaco.editor.defineTheme(themeName, {
    base: isDark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": background,
      "editorGutter.background": background,
      "editor.foreground": foreground,
      "editorCursor.foreground": foreground,
      "editorLineNumber.foreground": pick("--muted-foreground", "#888888"),
      "editorLineNumber.activeForeground": foreground,
      "editor.lineHighlightBackground": pick("--muted", isDark ? "#ffffff0a" : "#0000000a"),
      // The base themes draw a box around the active line; with our
      // subtle line-highlight fill that border just reads as noise.
      "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background": border,
      "editorWhitespace.foreground": border,
      "editorWidget.background": pick("--card", background),
      "editorWidget.border": border,
    },
  });
  monaco.editor.setTheme(themeName);
}
