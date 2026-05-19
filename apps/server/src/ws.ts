import { Cause, Duration, Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect";
import {
  ARIS_WS_METHODS,
  ArisApprovalDecideError,
  ArisArchiveReadError,
  ArisFactsReadError,
  type AuthAccessStreamEvent,
  AuthSessionId,
  CommandId,
  EPHEMERAL_WS_METHODS,
  EventId,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectListTreeError,
  ProjectReadFileError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  FilesystemBrowseError,
  ThreadId,
  type TerminalEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { ArisEventBus } from "./aris/Services/ArisEventBus";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { ArisAdapter } from "./provider/Services/ArisAdapter";
import { DeepSeekAdapter } from "./provider/Services/DeepSeekAdapter";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { GitManager } from "./git/Services/GitManager";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { normalizeDispatchCommand } from "./orchestration/Normalizer";
import { EphemeralBroadcast } from "./orchestration/Services/EphemeralBroadcast";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import {
  makeRollingWindowConfig,
  readActiveWindow,
  type RollingWindowConfig,
} from "./provider/Layers/RollingWindowMemory";
import { makeFactsConfig, readFacts, type FactsConfig } from "./provider/Layers/FactsMemory.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { TerminalManager } from "./terminal/Services/Manager";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner";
import { RepositoryIdentityResolver } from "./project/Services/RepositoryIdentityResolver";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment";
import { AuthError, ServerAuth } from "./auth/Services/ServerAuth";
import {
  BootstrapCredentialService,
  type BootstrapCredentialChange,
} from "./auth/Services/BootstrapCredentialService";
import {
  SessionCredentialService,
  type SessionCredentialChange,
} from "./auth/Services/SessionCredentialService";
import { respondToAuthError } from "./auth/http";

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

function toAuthAccessStreamEvent(
  change: BootstrapCredentialChange | SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (
  currentSessionId: AuthSessionId,
  factsConfig: FactsConfig,
  rollingWindowConfig: RollingWindowConfig,
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const keybindings = yield* Keybindings;
      const open = yield* Open;
      const gitManager = yield* GitManager;
      const git = yield* GitCore;
      const gitStatusBroadcaster = yield* GitStatusBroadcaster;
      const ephemeralBroadcast = yield* EphemeralBroadcast;
      const arisEventBus = yield* ArisEventBus;
      const arisAdapter = yield* ArisAdapter;
      const deepseekAdapter = yield* DeepSeekAdapter;
      const terminalManager = yield* TerminalManager;
      const providerRegistry = yield* ProviderRegistry;
      const config = yield* ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const serverSettings = yield* ServerSettingsService;
      const startup = yield* ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
      const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* ServerAuth;
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const sessions = yield* SessionCredentialService;
      const serverCommandId = (tag: string) =>
        CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks().pipe(Effect.orDie),
          clientSessions: serverAuth.listClientSessions(currentSessionId).pipe(Effect.orDie),
        });

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("setup-script-activity"),
          threadId: input.threadId,
          activity: {
            id: EventId.make(crypto.randomUUID()),
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });

      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        Schema.is(OrchestrationDispatchCommandError)(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
            });

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return Schema.is(OrchestrationDispatchCommandError)(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
            });
      };

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                (yield* orchestrationEngine.getReadModel()).projects.find(
                  (project) => project.id === event.payload.projectId,
                )?.workspaceRoot ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            });
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return projectionSnapshotQuery
              .getThreadShellById(ThreadId.make(event.aggregateId))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
        }
      };

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? orchestrationEngine
                  .dispatch({
                    type: "thread.delete",
                    commandId: serverCommandId("bootstrap-thread-delete"),
                    threadId: command.threadId,
                  })
                  .pipe(Effect.ignoreCause({ log: true }))
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: unknown;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail =
              input.error instanceof Error ? input.error.message : "Unknown setup failure.";
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) => {
            const payload = {
              scriptId: input.scriptId,
              scriptName: input.scriptName,
              terminalId: input.terminalId,
              worktreePath: input.worktreePath,
            };
            return Effect.all([
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: input.requestedAt,
                payload,
                tone: "info",
              }),
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: new Date().toISOString(),
                payload,
                tone: "info",
              }),
            ]).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logWarning(
                  "bootstrap turn start launched setup script but failed to record setup activity",
                  {
                    threadId: command.threadId,
                    worktreePath: input.worktreePath,
                    scriptId: input.scriptId,
                    terminalId: input.terminalId,
                    detail: error.message,
                  },
                ),
              ),
            );
          };

          const runSetupProgram = () =>
            bootstrap?.runSetupScript && targetWorktreePath
              ? (() => {
                  const worktreePath = targetWorktreePath;
                  const requestedAt = new Date().toISOString();
                  return projectSetupScriptRunner
                    .runForThread({
                      threadId: command.threadId,
                      ...(targetProjectId ? { projectId: targetProjectId } : {}),
                      ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                      worktreePath,
                    })
                    .pipe(
                      Effect.matchEffect({
                        onFailure: (error) =>
                          recordSetupScriptLaunchFailure({
                            error,
                            requestedAt,
                            worktreePath,
                          }),
                        onSuccess: (setupResult) => {
                          if (setupResult.status !== "started") {
                            return Effect.void;
                          }
                          return recordSetupScriptStarted({
                            requestedAt,
                            worktreePath,
                            scriptId: setupResult.scriptId,
                            scriptName: setupResult.scriptName,
                            terminalId: setupResult.terminalId,
                          });
                        },
                      }),
                    );
                })()
              : Effect.void;

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              const worktree = yield* git.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                branch: bootstrap.prepareWorktree.baseBranch,
                newBranch: bootstrap.prepareWorktree.branch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.branch,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = yield* serverSettings.getSettings;
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: resolveAvailableEditors(),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        gitStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                Schema.is(OrchestrationDispatchCommandError)(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.replayEvents,
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.flatMap(enrichOrchestrationEvents),
              Effect.mapError(
                (cause) =>
                  new OrchestrationReplayEventsError({
                    message: "Failed to replay orchestration events",
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.mapError(
                  (_cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                    }),
                ),
              );

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.mapEffect(toShellStreamEvent),
                Stream.flatMap((event) =>
                  Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                ),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const [threadDetail, snapshotSequence] = yield* Effect.all([
                projectionSnapshotQuery.getThreadDetailById(input.threadId).pipe(
                  Effect.mapError(
                    (_cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                      }),
                  ),
                ),
                orchestrationEngine
                  .getReadModel()
                  .pipe(Effect.map((readModel) => readModel.snapshotSequence)),
              ]);

              if (Option.isNone(threadDetail)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                });
              }

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(
                  (event) =>
                    event.aggregateKind === "thread" &&
                    event.aggregateId === input.threadId &&
                    isThreadDetailEvent(event),
                ),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event,
                })),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: {
                    snapshotSequence,
                    thread: threadDetail.value,
                  },
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            providerRegistry.refresh().pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetSettings, serverSettings.getSettings, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(WS_METHODS.serverUpdateSettings, serverSettings.updateSettings(patch), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    message: `Failed to search workspace entries: ${cause.detail}`,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError((cause) => {
                const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                  ? "Workspace file path must stay within the project root."
                  : "Failed to write workspace file";
                return new ProjectWriteFileError({
                  message,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError((cause) => {
                const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                  ? "Workspace file path must stay within the project root."
                  : cause.detail || "Failed to read workspace file";
                return new ProjectReadFileError({
                  message,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListTree]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListTree,
            workspaceEntries.listTree(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListTreeError({
                    message: `Failed to list workspace tree: ${cause.detail}`,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, open.openInEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    message: cause.detail,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeGitStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeGitStatus,
            gitStatusBroadcaster.streamStatus(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitRefreshStatus,
            gitStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPull,
            git.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitManager
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(WS_METHODS.gitResolvePullRequest, gitManager.resolvePullRequest(input), {
            "rpc.aggregate": "git",
          }),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitManager
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitListBranches]: (input) =>
          observeRpcEffect(WS_METHODS.gitListBranches, git.listBranches(input), {
            "rpc.aggregate": "git",
          }),
        [WS_METHODS.gitCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCreateWorktree,
            git.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitRemoveWorktree,
            git.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitCreateBranch]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCreateBranch,
            git.createBranch(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitCheckout]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCheckout,
            Effect.scoped(git.checkoutBranch(input)).pipe(
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitInit,
            git.initRepo(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* Effect.all(
                [
                  providerRegistry.refresh("aris"),
                  providerRegistry.refresh("codex"),
                  providerRegistry.refresh("claudeAgent"),
                ],
                {
                  concurrency: "unbounded",
                  discard: true,
                },
              ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [EPHEMERAL_WS_METHODS.subscribeEphemeralReasoning]: (input) =>
          observeRpcStream(
            EPHEMERAL_WS_METHODS.subscribeEphemeralReasoning,
            ephemeralBroadcast.streamForThread(input.threadId),
            { "rpc.aggregate": "ephemeral" },
          ),
        [ARIS_WS_METHODS.subscribeArisEvents]: (input) =>
          observeRpcStream(
            ARIS_WS_METHODS.subscribeArisEvents,
            arisEventBus.streamForThread(input.threadId),
            { "rpc.aggregate": "aris" },
          ),
        [ARIS_WS_METHODS.decideApproval]: (input) =>
          observeRpcEffect(
            ARIS_WS_METHODS.decideApproval,
            // The aris.* RPC namespace is shared between Aris and DS
            // (per the shared-bus architecture). Approval decisions
            // could target either adapter — we don't know which one
            // owns the thread without a lookup. Try Aris first; if
            // Aris reports the thread as unknown, fall through to
            // DeepSeek. This mirrors the parity intent without
            // requiring a separate `deepseek.approval.decide` RPC.
            arisAdapter.respondToRequest(input.threadId, input.approvalId, input.decision).pipe(
              Effect.catch((arisErr) => {
                const arisErrMsg = arisErr instanceof Error ? arisErr.message : String(arisErr);
                // Heuristic: "Unknown aris adapter thread" is the
                // recognizable signal that the thread isn't owned
                // by Aris — try DeepSeek next. Any other Aris-side
                // failure (e.g. malformed input) we surface as-is
                // because retrying on DS won't help.
                const isUnknownThread = /unknown.*thread/i.test(arisErrMsg);
                if (!isUnknownThread) {
                  return Effect.fail(new ArisApprovalDecideError({ detail: arisErrMsg }));
                }
                return deepseekAdapter
                  .respondToRequest(input.threadId, input.approvalId, input.decision)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ArisApprovalDecideError({
                          detail: cause instanceof Error ? cause.message : String(cause),
                        }),
                    ),
                  );
              }),
            ),
            { "rpc.aggregate": "aris" },
          ),
        // RW-2.5 — Hydrate prior DS messages from the on-disk rolling
        // window so they survive app restart. Reads ~/.aris/projects/
        // <key>/sessions/<thread>/active.jsonl, transforms each
        // PersistedMessage into the ArisArchiveMessage wire shape (which
        // maps cleanly into the client's ChatMessage type). Returns an
        // empty messages array when the file doesn't exist yet (fresh
        // thread that's never sent a turn).
        [ARIS_WS_METHODS.readArchive]: (input) =>
          observeRpcEffect(
            ARIS_WS_METHODS.readArchive,
            Effect.tryPromise({
              try: async () => {
                const persisted = await readActiveWindow(
                  rollingWindowConfig,
                  input.cwd,
                  input.threadId,
                );
                return {
                  messages: persisted.map((m) => {
                    // Persisted messageId is already in the
                    // canonical "user:turnId" / "assistant:turnId-..."
                    // form (see DeepSeekAdapter RW-1 writes), so we
                    // pass it through directly. The brand cast is
                    // safe because the runtime shape is identical to
                    // MessageId.
                    //
                    // Forward image-attachment metadata when present
                    // (added 2026-05-13). The persisted shape mirrors
                    // ChatImageAttachment so we just hand the array
                    // straight through — Schema.optional means the
                    // field stays absent on the wire when there are
                    // no attachments, preserving prefix-cache for
                    // assistant-message rows. Built as a single
                    // mutable object (rather than spread-from-base) to
                    // satisfy oxlint's `no-map-spread` rule.
                    const out: {
                      id: never;
                      role: typeof m.role;
                      content: string;
                      turnId: string | null;
                      createdAt: string;
                      attachments?: NonNullable<typeof m.attachments>;
                    } = {
                      id: m.messageId as never,
                      role: m.role,
                      content: m.content,
                      turnId: m.turnId ?? null,
                      createdAt: m.timestamp,
                    };
                    if (m.attachments && m.attachments.length > 0) {
                      out.attachments = m.attachments;
                    }
                    return out;
                  }),
                };
              },
              catch: (cause) =>
                new ArisArchiveReadError({
                  detail: cause instanceof Error ? cause.message : String(cause),
                }),
            }),
            { "rpc.aggregate": "aris" },
          ),
        // Memory panel snapshot — reads user-global facts.jsonl. Empty
        // input (facts aren't thread- or project-scoped). Returns an
        // empty facts array when the file doesn't exist yet (fresh
        // user, never saved a fact).
        [ARIS_WS_METHODS.readFacts]: (_input) =>
          observeRpcEffect(
            ARIS_WS_METHODS.readFacts,
            Effect.tryPromise({
              try: async () => {
                const facts = await readFacts(factsConfig);
                return { facts };
              },
              catch: (cause) =>
                new ArisFactsReadError({
                  detail: cause instanceof Error ? cause.message : String(cause),
                }),
            }),
            { "rpc.aggregate": "aris" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                BootstrapCredentialChange | SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
      });
    }),
  );

/**
 * Slice E.2 / H-2A fix (2026-05-16) — owner-only WS RPC policy gate.
 *
 * Pre-Slice-E.2, `makeWsRpcLayer` accepted `session.sessionId` but
 * ignored `session.role`. Both owner and client sessions got identical
 * unrestricted RPC power: file writes, terminal exec, server settings
 * mutation, git ops, orchestration dispatch. A pairing-link client
 * token issued for a second device could therefore take full server
 * control — bypassing the owner-only gate the HTTP layer already
 * enforces (see `authenticateOwnerSession` in auth/http.ts).
 *
 * Aris Code's product model is single-user / single-device — the
 * T3 Code "share session with paired device" feature is unused
 * surface here. Closing the WS to non-owner sessions is the
 * simplest defensible default: one gate, mirrors the HTTP pattern,
 * zero ongoing per-method audit debt. If a deliberate phone-mirror
 * UX is ever wanted, the right shape is a read-only push channel
 * (server → device events only), built from scratch — not a
 * half-trusted bidirectional pipe with a per-method ACL.
 *
 * Returns `null` when the session is allowed to open the WS, or an
 * `AuthError` (status 403) when the upgrade must be refused. Exported
 * for direct unit-testing — the call site below just yields the
 * error when non-null.
 */
export function checkWebSocketUpgradePolicy(session: {
  readonly role: "owner" | "client";
}): AuthError | null {
  if (session.role !== "owner") {
    return new AuthError({
      message: "Client sessions cannot establish WebSocket RPC connections — owner-only.",
      status: 403,
    });
  }
  return null;
}

/**
 * Slice J.5 / M3-5 fix (2026-05-16) — Cross-Site WebSocket Hijacking
 * (CSWSH) defense. A malicious page the user visits in a browser can
 * call `new WebSocket("ws://localhost:<port>/ws")` and ride the user's
 * authenticated cookie — there is no Same-Origin Policy for
 * WebSockets. The standard fix is to check the `Origin` header on
 * upgrade and reject anything that isn't a known-safe origin.
 *
 * Allowed origins:
 *   - **Missing / null** — Electron renderer often sends no Origin
 *     header at all (custom protocol). Accept.
 *   - **`file://`** — Electron production renderer when loaded from
 *     disk. Accept.
 *   - **Same host as the request's `Host` header** — the typical
 *     same-origin case for the standalone web build.
 *   - **`localhost` / `127.0.0.1` / `[::1]`** — dev origins (Vite at
 *     a different port than the server).
 *
 * Anything else is a cross-origin upgrade and gets a 403. Exported
 * for direct unit-testing.
 */
const LOCAL_HOSTS_ALLOWLIST = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function checkWebSocketOrigin(input: {
  readonly origin: string | undefined;
  readonly host: string | undefined;
}): AuthError | null {
  const { origin, host } = input;
  if (!origin) return null;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return new AuthError({
      message: "WebSocket upgrade rejected — malformed Origin header.",
      status: 403,
    });
  }
  if (originUrl.protocol === "file:") return null;
  if (host && originUrl.host === host) return null;
  if (LOCAL_HOSTS_ALLOWLIST.has(originUrl.hostname)) return null;
  return new AuthError({
    message: `Cross-origin WebSocket upgrade rejected from ${origin}`,
    status: 403,
  });
}

/**
 * Slice J.5 / M3-3 fix (2026-05-16) — cap on simultaneous WebSocket
 * RPC connections. Pre-Slice-J the server accepted unlimited
 * concurrent upgrades; a hostile (or buggy) client could open
 * connections faster than they close, exhausting the event loop and
 * the per-connection fiber pool.
 *
 * Aris Code's product model is single-user / single-Electron, so one
 * connection at steady state. 10 is a generous ceiling that absorbs
 * page reloads, hot-reload churn during dev, and the occasional
 * second Electron window without affecting any legitimate workflow.
 *
 * Implementation: module-level counter, mutated synchronously
 * (Node.js single-threaded, so increment/decrement are atomic). The
 * `tryAcquireWsConnectionSlot` returns a release function the route
 * wires into `Effect.acquireUseRelease` so the slot is freed on
 * close (normal exit, error, or revocation interrupt).
 */
const MAX_CONCURRENT_WS_CONNECTIONS = 10;
let activeWsConnectionCount = 0;
export function tryAcquireWsConnectionSlot(): {
  readonly acquired: boolean;
  readonly release: () => void;
} {
  if (activeWsConnectionCount >= MAX_CONCURRENT_WS_CONNECTIONS) {
    return { acquired: false, release: () => undefined };
  }
  activeWsConnectionCount += 1;
  let released = false;
  return {
    acquired: true,
    release: () => {
      if (released) return;
      released = true;
      activeWsConnectionCount -= 1;
    },
  };
}

/** @internal Test-only: reset the global counter. Not exported via index. */
export function __resetWsConnectionCountForTests(): void {
  activeWsConnectionCount = 0;
}

/**
 * Slice E.3 / H-2D fix (2026-05-16) — revocation-watcher effect.
 *
 * Pre-Slice-E.3, revoking a session via `POST /api/auth/clients/revoke`
 * (or `revoke-others`) updated the DB row and the in-memory connected-
 * sessions ref, but the WebSocket fiber for that session kept running
 * with full RPC access. An admin who revoked a compromised session
 * had no way to actually kick the attacker — the socket stayed alive
 * until the attacker chose to disconnect.
 *
 * `SessionCredentialService.streamChanges` already broadcasts a
 * `clientRemoved` event on every revoke (it backs the auth-access
 * live-stream the desktop UI subscribes to). We piggy-back on that
 * signal: each WS upgrade spawns a sibling effect that subscribes to
 * the change stream, filters for the connection's own `sessionId`,
 * and completes when the matching event arrives. The route races
 * the RPC effect against this watcher — whichever finishes first
 * wins; the loser is interrupted, the `acquireUseRelease` release
 * still runs, `markDisconnected` cleans up.
 *
 * The watcher never errors and never produces a value — it either
 * blocks forever (the typical case: the session is never revoked
 * during this connection's lifetime, so the watcher gets interrupted
 * when the RPC side closes normally) or completes silently the
 * instant the revoke fires (so the race's other side gets
 * interrupted and the socket drops).
 *
 * Exported for direct unit-testing without spinning up the full HTTP
 * / RPC graph.
 */
export function watchOwnSessionRevocation(
  changes: Stream.Stream<SessionCredentialChange>,
  sessionId: AuthSessionId,
): Effect.Effect<never> {
  return changes.pipe(
    Stream.filter((change) => change.type === "clientRemoved" && change.sessionId === sessionId),
    Stream.take(1),
    Stream.runDrain,
    Effect.orDie,
    // Terminate the fiber once the matching revoke arrives. The race
    // partner (the RPC effect) is interrupted, the acquireUseRelease
    // release runs `markDisconnected`, the WS closes. We never return
    // a value here — typed `never` so race's success union collapses
    // to whatever the RPC side produces.
    Effect.flatMap(() => Effect.interrupt),
  );
}

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;

        // Slice J.5 / M3-5 — Origin allowlist BEFORE auth so a
        // cross-origin browser tab can't even get to the credential
        // check. Closes CSWSH at the door.
        const originError = checkWebSocketOrigin({
          origin: request.headers["origin"],
          host: request.headers["host"],
        });
        if (originError !== null) {
          return yield* originError;
        }

        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const factsConfig = makeFactsConfig();
        // Slice L / M3-2 — same composition-root pattern. One
        // `homedir()` call per WS upgrade; threaded through every
        // RPC handler that touches `~/.aris/projects/<key>/sessions`.
        const rollingWindowConfig = makeRollingWindowConfig();
        const policyError = checkWebSocketUpgradePolicy(session);
        if (policyError !== null) {
          return yield* policyError;
        }

        // Slice J.5 / M3-3 — try to acquire a WS connection slot. If
        // the cap is hit, return 503; otherwise reserve the slot and
        // release it via `acquireUseRelease` below on connection
        // close.
        const wsSlot = tryAcquireWsConnectionSlot();
        if (!wsSlot.acquired) {
          return yield* new AuthError({
            message: `WebSocket connection limit reached (${MAX_CONCURRENT_WS_CONNECTIONS}).`,
            status: 503,
          });
        }
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          spanPrefix: "ws.rpc",
          spanAttributes: {
            "rpc.transport": "websocket",
            "rpc.system": "effect-rpc",
          },
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session.sessionId, factsConfig, rollingWindowConfig).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
            ),
          ),
        );
        // Slice E.3 / H-2D — race the RPC effect against the
        // revocation watcher. If `POST /api/auth/clients/revoke` fires
        // for this session while the WS is alive, the watcher
        // completes, race wins, the RPC fiber is interrupted, the
        // `acquireUseRelease` release runs `markDisconnected`, and
        // the socket drops. If the RPC closes normally first, the
        // watcher is interrupted (no-op cleanup).
        const revocationWatcher = watchOwnSessionRevocation(
          sessions.streamChanges,
          session.sessionId,
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => Effect.race(rpcWebSocketHttpEffect, revocationWatcher),
          () =>
            // Release BOTH the session-connected mark and the
            // module-level WS slot counter (Slice J.5 / M3-3). Order
            // doesn't matter — they're independent counters.
            sessions
              .markDisconnected(session.sessionId)
              .pipe(Effect.tap(() => Effect.sync(() => wsSlot.release()))),
        );
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
