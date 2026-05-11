/**
 * DeepSeekProviderLive — snapshot service for DeepSeek's status.
 *
 * Mirrors `ArisProviderLive`'s shape but the probe is simpler: there's
 * no local server to /health-check. DeepSeek dispatches go through V1
 * cloud's trusted-caller proxy, so the snapshot just verifies the
 * config gates the user can actually fix from the settings panel:
 *
 *   - `enabled` flag flipped on
 *   - `cloudBaseUrl` populated (defaults to https://youraris.com)
 *   - `cloudToken` present (long-lived `local_api_key` from
 *     /api/local/auth subscription_key exchange)
 *
 * If all three pass we report `ready` — first real dispatch will
 * surface upstream errors (cloud down, subscription lapsed, balance
 * exhausted, DeepSeek rate-limited, etc.) via the standard error
 * path. A dedicated cloud health probe could be added later but
 * isn't worth the round-trip on every settings refresh.
 *
 * @module DeepSeekProviderLive
 */
import type { ModelCapabilities, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { ServerSettingsError } from "@t3tools/contracts";
import type { DeepSeekSettings } from "@t3tools/contracts/settings";
import { Effect, Equal, Layer, Stream } from "effect";

import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { DeepSeekProvider } from "../Services/DeepSeekProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "deepseek" as const;

const DEFAULT_DEEPSEEK_MODEL_CAPABILITIES: ModelCapabilities = {
  // The picker UI renders these labels; wire values match
  // `DEEPSEEK_REASONING_EFFORT_OPTIONS` from contracts/model.ts.
  reasoningEffortLevels: [
    { value: "light", label: "Think (light)" },
    { value: "high", label: "High (default)", isDefault: true },
    { value: "max", label: "Max (deep)" },
  ],
  supportsFastMode: false,
  // DeepSeek's "thinking" toggle is graduated (3 effort levels), not
  // binary — surfaced through reasoningEffortLevels above. The binary
  // toggle is for Aris/Qwen3.6 which only knows on/off.
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

// Cosmetic relabel (2026-05-10): user-facing model names surface as
// "Aris V4 Pro/Flash". The slugs (`deepseek-v4-pro`, `deepseek-v4-flash`)
// stay unchanged — they're load-bearing across the cloud trusted-caller,
// effort-resolution, settings persistence, and existing thread state.
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "deepseek-v4-pro",
    name: "Aris V4 Pro",
    isCustom: false,
    capabilities: DEFAULT_DEEPSEEK_MODEL_CAPABILITIES,
  },
  {
    slug: "deepseek-v4-flash",
    name: "Aris V4 Flash",
    isCustom: false,
    capabilities: DEFAULT_DEEPSEEK_MODEL_CAPABILITIES,
  },
];

export function getDeepSeekModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((m) => m.slug === slug)?.capabilities ??
    DEFAULT_DEEPSEEK_MODEL_CAPABILITIES
  );
}

export const checkDeepSeekProviderStatus = Effect.fn("checkDeepSeekProviderStatus")(
  function* (): Effect.fn.Return<ServerProvider, ServerSettingsError, ServerSettingsService> {
    const allSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((s) => s.getSettings),
    );
    const deepseekSettings = allSettings.providers.deepseek;
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      deepseekSettings.customModels,
      DEFAULT_DEEPSEEK_MODEL_CAPABILITIES,
    );

    if (!deepseekSettings.enabled) {
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
          message: "DeepSeek is disabled in Aris Code settings.",
        },
      });
    }

    if (!deepseekSettings.cloudBaseUrl) {
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
          message: "DeepSeek cloud base URL is not configured.",
        },
      });
    }

    if (!deepseekSettings.cloudToken || deepseekSettings.cloudToken.length === 0) {
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
          message: "Activate DeepSeek from Settings — paste your subscription key.",
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
        auth: { status: "authenticated" },
      },
    });
  },
);

const makePendingDeepSeekProvider = (deepseekSettings: DeepSeekSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    deepseekSettings.customModels,
    DEFAULT_DEEPSEEK_MODEL_CAPABILITIES,
  );

  if (!deepseekSettings.enabled) {
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
        message: "DeepSeek is disabled in Aris Code settings.",
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
      message: "DeepSeek provider status has not been checked in this session yet.",
    },
  });
};

export const DeepSeekProviderLive = Layer.effect(
  DeepSeekProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;

    const checkProvider = checkDeepSeekProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
    );

    return yield* makeManagedServerProvider<DeepSeekSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((s) => s.providers.deepseek),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(Stream.map((s) => s.providers.deepseek)),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingDeepSeekProvider,
      checkProvider,
    });
  }),
);
