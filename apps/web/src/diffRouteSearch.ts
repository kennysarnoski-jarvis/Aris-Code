// NOTE (2026-05-14, V2 editor): this module started life owning only the
// diff panel's search params, but it's the thread route's single
// `validateSearch` entry point, so the V2 editor mode's `view` param
// lives here too rather than fragmenting the route's search parsing
// across files. A rename to `threadRouteSearch.ts` (+ `ThreadRouteSearch`
// / `parseThreadRouteSearch`) is the clean follow-up — deferred so Slice 1
// doesn't drag a 5-file rename along with it.
import { TurnId } from "@t3tools/contracts";

/** The thread route's full search surface — diff panel state + V2 view mode. */
export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  /**
   * Main-window view mode. Absent (the default) = chat. `"editor"` swaps
   * the main window to the V2 Monaco editor mode. URL-persistent so a
   * refresh keeps you where you were, same as `diff`.
   */
  view?: "editor" | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeViewValue(value: unknown): "editor" | undefined {
  return value === "editor" ? "editor" : undefined;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> {
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const view = normalizeViewValue(search.view);

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(view ? { view } : {}),
  };
}
