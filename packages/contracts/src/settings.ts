import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";
import {
  ArisModelOptions,
  ClaudeModelOptions,
  CodexModelOptions,
  DeepSeekModelOptions,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
} from "./model";
import { ModelSelection } from "./orchestration";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const ClientSettingsSchema = Schema.Struct({
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("claude"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  launchArgs: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const ArisSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  baseUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("http://localhost:8001"))),
  // The user's email (used for sign-in). Stored so we can show who is signed in.
  email: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Session key returned by Aris's /v1/auth/login. Sent as `X-Aris-Key` header
  // on every request. Empty string means "not signed in". Key is a 256-bit
  // random token; only its SHA-256 hash is persisted server-side.
  apiKey: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // User id returned by /v1/auth/login alongside the key. Kept for display
  // ("Signed in as user #N") only — NOT the auth credential. 0 means
  // "not signed in".
  userId: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ArisSettings = typeof ArisSettings.Type;

/**
 * Slice 33a — DeepSeek provider settings (cloud-billed shape).
 *
 * Architecturally distinct from `ArisSettings` because DeepSeek is routed
 * through the cloud trusted-caller proxy (youraris.com) for Stripe-metered
 * token billing — Aris Code never holds the DeepSeek API key. The cloud
 * authenticates the request via the user's Aris session key (`X-Aris-Key`
 * from `ArisSettings.apiKey`), so we don't duplicate that field here. All
 * we need locally is:
 *
 *   - `enabled`: can the user reach the picker for this provider?
 *   - `cloudBaseUrl`: where the trusted-caller endpoint lives. Defaults to
 *      empty so a misconfigured client surfaces "not configured" instead
 *      of silently hammering localhost. Kenny sets the production URL.
 *   - `enabledModels`: which V4 variants show up in the picker. V4-Pro
 *      (premium positioning) shipped first per Kenny's call; V4-Flash
 *      can be enabled when the cost-pill UI lands so users can pick
 *      "fast cheap" mode.
 *   - `customModels`: future-proofing for distill / FT variants.
 */
export const DeepSeekSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Default to V1 cloud's prod URL so the user just needs to paste
   * their subscription key to activate. Override for staging / local
   * dev FastAPI.
   */
  cloudBaseUrl: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("https://youraris.com")),
  ),
  /**
   * Long-lived `local_api_key` issued by V1 cloud after exchanging a
   * `subscription_key` via `POST {cloudBaseUrl}/api/local/auth`. Sent
   * as `Authorization: Bearer <local_api_key>` on every DeepSeek
   * dispatch — the same pattern V1 desktop Aris uses for all its
   * cloud calls.
   *
   * Why not the user's Aris session key (X-Aris-Key)?
   * The session key lives in aris_server's (POD's) `user_sessions`
   * table. Cloud has no visibility into that table — validating
   * X-Aris-Key would require cloud to phone the POD, which couples
   * DeepSeek to "POD must be online." The local_api_key lives in
   * cloud's own DB, so cloud validates it independently and DeepSeek
   * runs whenever cloud is up; the POD can be cold all day.
   *
   * No expiry beyond the user's subscription lifetime — there's no
   * refresh-token dance, no 1-hour TTL. If the subscription lapses,
   * cloud rejects the bearer and Aris Code re-prompts for a new
   * subscription_key.
   */
  cloudToken: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  enabledModels: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(["deepseek-v4-pro"])),
  ),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type DeepSeekSettings = typeof DeepSeekSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        provider: "codex" as const,
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
      }),
    ),
  ),

  // Provider specific settings
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    aris: ArisSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    deepseek: DeepSeekSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const CodexModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(CodexModelOptions.fields.reasoningEffort),
  fastMode: Schema.optionalKey(CodexModelOptions.fields.fastMode),
});

const ClaudeModelOptionsPatch = Schema.Struct({
  thinking: Schema.optionalKey(ClaudeModelOptions.fields.thinking),
  effort: Schema.optionalKey(ClaudeModelOptions.fields.effort),
  fastMode: Schema.optionalKey(ClaudeModelOptions.fields.fastMode),
  contextWindow: Schema.optionalKey(ClaudeModelOptions.fields.contextWindow),
});

const ArisModelOptionsPatch = Schema.Struct({
  thinking: Schema.optionalKey(ArisModelOptions.fields.thinking),
});

const DeepSeekModelOptionsPatch = Schema.Struct({
  effort: Schema.optionalKey(DeepSeekModelOptions.fields.effort),
});

const ModelSelectionPatch = Schema.Union([
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("codex")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(CodexModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("claudeAgent")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ClaudeModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("aris")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ArisModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("deepseek")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(DeepSeekModelOptionsPatch),
  }),
]);

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(Schema.String),
});

const ArisSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  baseUrl: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
  userId: Schema.optionalKey(Schema.Number),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const DeepSeekSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  cloudBaseUrl: Schema.optionalKey(Schema.String),
  cloudToken: Schema.optionalKey(Schema.String),
  enabledModels: Schema.optionalKey(Schema.Array(Schema.String)),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  addProjectBaseDirectory: Schema.optionalKey(Schema.String),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      aris: Schema.optionalKey(ArisSettingsPatch),
      deepseek: Schema.optionalKey(DeepSeekSettingsPatch),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;
