/**
 * ArisAdapter - Aris implementation of the generic provider adapter contract.
 *
 * This service owns Aris runtime/session semantics (HTTP streaming against
 * ArisLLM's OpenAI-compatible /v1/chat/completions endpoint) and emits
 * canonical provider runtime events. It does not perform cross-provider
 * routing, shared event fan-out, or checkpoint orchestration.
 *
 * Uses Effect `Context.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "aris"` context.
 *
 * @module ArisAdapter
 */
import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ArisAdapterShape - Service API for the Aris provider adapter.
 */
export interface ArisAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "aris";
}

/**
 * ArisAdapter - Service tag for Aris provider adapter operations.
 */
export class ArisAdapter extends Context.Service<ArisAdapter, ArisAdapterShape>()(
  "t3/provider/Services/ArisAdapter",
) {}
