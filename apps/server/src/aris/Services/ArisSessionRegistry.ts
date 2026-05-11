/**
 * ArisSessionRegistry — derived in-memory status for every Aris thread the
 * apps/server process has seen during its lifetime.
 *
 * Subscribes to `ArisEventBus` and folds events into a per-thread snapshot
 * so the sidebar can answer "is thread X currently running?" without
 * touching state.sqlite or the orchestration engine. Replaces the
 * `projection_threads.status` / `projection_threads.activeTurnId` columns
 * for Aris-provider threads under Cut C.
 *
 * Resets on apps/server restart — correct, because Aris turns are HTTP
 * streams that cannot survive a process restart anyway.
 *
 * @module ArisSessionRegistry
 */
import { Context } from "effect";
import type { Effect } from "effect";

import type { RuntimeMode, ThreadId, TurnId } from "@t3tools/contracts";

/**
 * Coarse status fed to the sidebar's working indicator.
 *
 * - `idle`: the registry has seen the thread but no turn is active.
 * - `running`: a turn is currently in flight; `activeTurnId` is set.
 * - `ready`: the most recent turn completed successfully.
 * - `error`: the most recent session/turn ended in failure;
 *   `lastError` carries the user-facing message.
 */
export type ArisSessionStatus = "idle" | "running" | "ready" | "error";

export interface ArisSessionSnapshot {
  readonly threadId: ThreadId;
  readonly status: ArisSessionStatus;
  readonly activeTurnId: TurnId | null;
  readonly lastError: string | null;
  /**
   * The runtime mode in effect at the start of the most recent turn,
   * or null if the registry has not yet seen a turn for this thread.
   * Sidebar displays this as a small mode badge alongside the title.
   */
  readonly runtimeMode: RuntimeMode | null;
  /** ISO 8601 timestamp of the most recent event that touched this snapshot. */
  readonly updatedAt: string;
}

export interface ArisSessionRegistryShape {
  /** Look up the current snapshot for a single thread. */
  readonly getSnapshot: (threadId: ThreadId) => Effect.Effect<ArisSessionSnapshot | null>;
  /** Snapshot of every thread the registry has seen this process lifetime. */
  readonly listSnapshots: () => Effect.Effect<ReadonlyArray<ArisSessionSnapshot>>;
}

export class ArisSessionRegistry extends Context.Service<
  ArisSessionRegistry,
  ArisSessionRegistryShape
>()("t3/aris/Services/ArisSessionRegistry") {}
