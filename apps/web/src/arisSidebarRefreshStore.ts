/**
 * arisSidebarRefreshStore — tiny zustand store with a tick counter that
 * `useArisProjectThreads` subscribes to. Anything that mutates Aris threads
 * server-side (rename / delete via `arisThreadsFetch`, or a turn settling
 * which updates `lastActiveAt`) calls `triggerArisSidebarRefresh()` to
 * bump the tick — every mounted sidebar hook then refetches `/v1/threads`.
 *
 * Why a tick counter and not a callback or context: the Aris sidebar hook
 * is mounted per-project inside the sidebar tree, but the producers of
 * refresh signals (action handlers, ChatView's turn-settle effect) are
 * scattered across the app. A global store-backed counter is the simplest
 * way to broadcast "go refetch" without threading callbacks through every
 * component layer.
 *
 * Cut C punch list (Phase 3b).
 */
import { create } from "zustand";

interface ArisSidebarRefreshState {
  readonly tick: number;
  readonly triggerArisSidebarRefresh: () => void;
}

export const useArisSidebarRefreshStore = create<ArisSidebarRefreshState>((set) => ({
  tick: 0,
  triggerArisSidebarRefresh: () => set((state) => ({ tick: state.tick + 1 })),
}));

/**
 * Imperative trigger — for use in non-React contexts (action handler
 * callbacks, effects). Reads the latest store action without subscribing.
 */
export function triggerArisSidebarRefresh(): void {
  useArisSidebarRefreshStore.getState().triggerArisSidebarRefresh();
}
