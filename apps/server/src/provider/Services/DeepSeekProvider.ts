import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface DeepSeekProviderShape extends ServerProviderShape {}

export class DeepSeekProvider extends Context.Service<DeepSeekProvider, DeepSeekProviderShape>()(
  "t3/provider/Services/DeepSeekProvider",
) {}
