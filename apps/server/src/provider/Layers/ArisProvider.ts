import type {
  ArisSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { ServerSettingsError } from "@t3tools/contracts";
import { Effect, Equal, Layer, Result, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  providerModelsFromSettings,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { ArisProvider } from "../Services/ArisProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "aris" as const;

const DEFAULT_ARIS_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: true,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "aris-qwen-3.6",
    name: "Aris Qwen 3.6",
    isCustom: false,
    capabilities: DEFAULT_ARIS_MODEL_CAPABILITIES,
  },
];

export function getArisModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((m) => m.slug === slug)?.capabilities ?? DEFAULT_ARIS_MODEL_CAPABILITIES
  );
}

export const checkArisProviderStatus = Effect.fn("checkArisProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    HttpClient.HttpClient | ServerSettingsService
  > {
    const arisSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((s) => s.getSettings),
      Effect.map((s) => s.providers.aris),
    );
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      arisSettings.customModels,
      DEFAULT_ARIS_MODEL_CAPABILITIES,
    );

    if (!arisSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Aris is disabled in Aris Code settings.",
        },
      });
    }

    if (!arisSettings.baseUrl) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Aris base URL is not configured.",
        },
      });
    }

    const httpClient = yield* HttpClient.HttpClient;
    const healthUrl = `${arisSettings.baseUrl.replace(/\/+$/, "")}/health`;
    const healthProbe = yield* httpClient
      .get(healthUrl)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
        Effect.result,
      );

    if (Result.isFailure(healthProbe)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `Could not reach Aris at ${healthUrl}. Is the server running?`,
        },
      });
    }

    if (!arisSettings.userId || arisSettings.userId < 1) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unauthenticated" },
          message: "Sign in to Aris in Settings.",
        },
      });
    }

    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "ready",
        auth: {
          status: "authenticated",
          ...(arisSettings.email ? { label: arisSettings.email } : {}),
        },
      },
    });
  },
);

const makePendingArisProvider = (arisSettings: ArisSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    arisSettings.customModels,
    DEFAULT_ARIS_MODEL_CAPABILITIES,
  );

  if (!arisSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Aris is disabled in Aris Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Aris provider status has not been checked in this session yet.",
    },
  });
};

export const ArisProviderLive = Layer.effect(
  ArisProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;

    const checkProvider = checkArisProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

    return yield* makeManagedServerProvider<ArisSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((s) => s.providers.aris),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(Stream.map((s) => s.providers.aris)),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingArisProvider,
      checkProvider,
    });
  }),
);
