import { Layer } from "effect";

import { ArisEventBusLive } from "./Layers/ArisEventBus.ts";
import { ArisSessionRegistryLive } from "./Layers/ArisSessionRegistry.ts";

/**
 * Composed live layer for the Aris runtime path. Provides:
 *
 *   - `ArisEventBus` — pub/sub for ArisEvent values
 *   - `ArisSessionRegistry` — derived per-thread status snapshots
 *
 * Wired into the apps/server runtime composition (alongside
 * `OrchestrationLayerLive`) once Cut C's slice 3d (`ArisAdapter`
 * dual-emission) starts publishing real events. Until then this layer
 * is intentionally unwired — the Services exist but no one produces
 * or consumes events through them.
 */
export const ArisRuntimeLayerLive = Layer.mergeAll(
  ArisEventBusLive,
  ArisSessionRegistryLive.pipe(Layer.provide(ArisEventBusLive)),
);
