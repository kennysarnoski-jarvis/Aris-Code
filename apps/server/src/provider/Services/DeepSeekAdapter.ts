/**
 * DeepSeekAdapter — DeepSeek implementation of the generic provider
 * adapter contract.
 *
 * This service owns DeepSeek runtime/session semantics (HTTP streaming
 * against V1 cloud's `/api/local/deepseek/v1/chat/completions`
 * trusted-caller proxy) and emits canonical Aris bus events.
 *
 * Mirrors `ArisAdapter`'s Service shape exactly — `provider: "deepseek"`
 * is the only structural difference. The adapter Layer
 * (`DeepSeekAdapterLive`) wires the implementation; the Service tag is
 * the dependency-injection handle the registry uses.
 *
 * @module DeepSeekAdapter
 */
import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * DeepSeekAdapterShape — Service API for the DeepSeek provider adapter.
 */
export interface DeepSeekAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "deepseek";
}

/**
 * DeepSeekAdapter — Service tag for DeepSeek provider adapter operations.
 */
export class DeepSeekAdapter extends Context.Service<DeepSeekAdapter, DeepSeekAdapterShape>()(
  "t3/provider/Services/DeepSeekAdapter",
) {}
