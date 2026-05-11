import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface ArisProviderShape extends ServerProviderShape {}

export class ArisProvider extends Context.Service<ArisProvider, ArisProviderShape>()(
  "t3/provider/Services/ArisProvider",
) {}
