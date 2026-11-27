// @effect-diagnostics nodeBuiltinImport:off - Match the same local workspace boundaries as the MCP resolver.
import * as NodePath from "node:path";
import NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  OpenCodeSettings,
  ProviderInstanceConfigMap,
  ServerSettingsError,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderExecutionContext,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import { ServerConfig } from "../config.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { startWatchdogMcpRelay } from "../mcp/WatchdogMcpRelay.ts";
import { makeWatchdogOfflineTools } from "../mcp/WatchdogOfflineTools.ts";
import { DELEGATE_NODE_PREFIX } from "../mcp/toolkits/workspaceDelegate.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { makeProviderInstanceRegistry } from "../provider/Layers/ProviderInstanceRegistryLive.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../provider/Layers/ProviderEventLoggers.ts";
import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { WatchdogJournal } from "./WatchdogJournal.ts";
import { runWatchdogProviderWorker } from "./WatchdogProviderWorker.ts";

export function canUseLocalWatchdogRelay(
  instance: ProviderInstanceConfig,
  upgradeRoom = false,
): boolean {
  // The Antigravity CLI, Claude SDK, and Codex CLI run locally and reach a loopback relay.
  if (
    instance.driver === "codex" ||
    instance.driver === "gemini" ||
    (upgradeRoom && instance.driver === "claudeAgent")
  )
    return true;
  if (instance.driver !== "opencode") return false;
  const config = Schema.decodeUnknownOption(OpenCodeSettings)(instance.config ?? {});
  return Option.isSome(config) && !config.value.serverUrl?.trim();
}

/** Only the selected instance's materialized credentials cross the process boundary. */
export function watchdogSettingsSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly settings: ServerSettings;
  readonly cwd: string;
}): ServerSettings {
  const providerInstances = Schema.decodeUnknownSync(ProviderInstanceConfigMap)({
    [input.instanceId]: input.instance,
  });
  const normalize = (value: string) => {
    const path = NodePath.resolve(value).replace(/[\\/]+$/, "");
    return NodeProcess.platform === "win32" ? path.toLowerCase() : path;
  };
  const cwd = normalize(input.cwd);
  const applies = (root: string) => {
    const parent = normalize(root);
    return cwd === parent || cwd.startsWith(`${parent}${NodePath.sep}`);
  };
  const customMcpServers = Object.fromEntries(
    Object.entries(input.settings.customMcpServers).filter(
      ([, server]) =>
        server.enabled &&
        server.providers.some((provider) => provider === input.instance.driver) &&
        (!server.workspaceRoot || applies(server.workspaceRoot)),
    ),
  ) as ServerSettings["customMcpServers"];
  const mcpProjectProfiles = Object.fromEntries(
    Object.entries(input.settings.mcpProjectProfiles).filter(([, profile]) =>
      applies(profile.workspaceRoot),
    ),
  ) as ServerSettings["mcpProjectProfiles"];
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        binaryPath: input.settings.providers.claudeAgent.binaryPath,
      },
    },
    mcpTools: input.settings.mcpTools,
    customMcpServers,
    mcpProjectProfiles,
    backgroundActivity: input.settings.backgroundActivity,
    providerHealthRefreshInterval: input.settings.providerHealthRefreshInterval,
    enableProviderUpdateChecks: input.settings.enableProviderUpdateChecks,
  };
}

/** Build one exact selected provider in the process that will own its session. */
export function runWatchdogWithProvider(input: {
  readonly journal: WatchdogJournal;
  readonly jobId: string;
  readonly capability: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly serverConfig: ServerConfig["Service"];
  readonly settings: ServerSettings;
  readonly execution: ProviderExecutionContext;
  readonly start: ProviderSessionStartInput;
  readonly turn: ProviderSendTurnInput;
  readonly worker: {
    readonly workerId: string;
    readonly pid: number;
    readonly attestation?: {
      readonly publicKey: string;
      readonly sign: (message: Uint8Array) => Uint8Array;
    };
  };
  readonly mcp?: McpProviderSession.McpProviderSessionConfig;
}) {
  const settings = watchdogSettingsSnapshot({
    instanceId: input.providerInstanceId,
    instance: input.instance,
    settings: input.settings,
    cwd: input.start.cwd ?? input.serverConfig.cwd,
  });
  const rejectSettingsWrite = () =>
    Effect.fail(
      new ServerSettingsError({
        settingsPath: "<watchdog-snapshot>",
        operation: "write-file",
        cause: "Read-only snapshot",
      }),
    );
  const settingsLayer = Layer.succeed(ServerSettingsService, {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(settings),
    updateSettings: rejectSettingsWrite,
    initializeThreadModelTeams: rejectSettingsWrite,
    runMonitoringAutoAction: () =>
      Effect.fail(
        new ServerSettingsError({
          settingsPath: "<watchdog-snapshot>",
          operation: "read-file",
          cause: "Monitoring actions require live settings",
        }),
      ),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  });
  const hostPowerLayer = Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make());
  const backgroundLayer = BackgroundPolicy.layer.pipe(
    Layer.provide(Layer.merge(hostPowerLayer, settingsLayer)),
  );
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Layer.succeed(ServerConfig, input.serverConfig),
    settingsLayer,
    backgroundLayer,
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    OpenCodeRuntimeLive.pipe(Layer.provide(NodeServices.layer)),
  );
  return Effect.gen(function* () {
    if (
      input.instance.enabled === false ||
      input.instance.driver !== input.start.provider ||
      input.providerInstanceId !== input.start.providerInstanceId ||
      input.providerInstanceId !== input.start.modelSelection?.instanceId ||
      input.providerInstanceId !== input.turn.modelSelection?.instanceId ||
      (input.instance.environment ?? []).some(
        (entry) => entry.sensitive && entry.valueRedacted && entry.value.length === 0,
      )
    )
      throw new Error(
        "The selected watchdog provider is unavailable or does not match the execution.",
      );
    if (
      input.mcp &&
      (input.mcp.threadId !== input.start.threadId ||
        input.mcp.providerInstanceId !== input.providerInstanceId)
    )
      throw new Error("The watchdog MCP session does not match the selected execution.");
    let awaitTools: (() => Promise<boolean>) | undefined;
    let mcp = input.mcp;
    const upgradeRoom = input.journal.upgradeRoomJob(input.jobId) !== undefined;
    // A remote provider cannot reach a loopback relay on the T3 host.
    if (mcp && canUseLocalWatchdogRelay(input.instance, upgradeRoom)) {
      const relay = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startWatchdogMcpRelay({
            endpoint: mcp!.endpoint,
            authorizationHeader: mcp!.authorizationHeader,
            ...(upgradeRoom
              ? {
                  fallback: makeWatchdogOfflineTools({
                    dbPath: input.serverConfig.dbPath,
                    settingsPath: input.serverConfig.settingsPath,
                    stateDir: input.serverConfig.stateDir,
                    ownerThreadId: input.execution.ownerThreadId,
                    cwd: input.start.cwd ?? input.serverConfig.cwd,
                    providerInstanceId: input.providerInstanceId,
                    model: input.turn.modelSelection?.model,
                    runtimeMode: input.start.runtimeMode,
                    interactionMode: input.turn.interactionMode,
                    nested: input.execution.nodeId.startsWith(DELEGATE_NODE_PREFIX),
                  }),
                }
              : {}),
          }),
        ),
        (relay) => Effect.promise(() => relay.close()),
      );
      mcp = { ...mcp, endpoint: relay.endpoint };
      if (input.instance.driver === "codex") awaitTools = () => relay.ready;
    }
    if (mcp) {
      yield* Effect.acquireRelease(
        Effect.sync(() => McpProviderSession.setMcpProviderSession(mcp!)),
        () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(input.start.threadId)),
      );
    }
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: BUILT_IN_DRIVERS,
      configMap: settings.providerInstances,
    });
    const instance = yield* registry.getInstance(input.providerInstanceId);
    if (!instance || !instance.enabled || instance.driverKind !== input.instance.driver)
      throw new Error("The selected watchdog provider could not be started.");
    return yield* runWatchdogProviderWorker({
      journal: input.journal,
      jobId: input.jobId,
      capability: input.capability,
      providerInstanceId: input.providerInstanceId,
      execution: input.execution,
      start: input.start,
      turn: input.turn,
      worker: input.worker,
      ...(awaitTools ? { awaitTools } : {}),
      adapter: instance.adapter,
    });
  }).pipe(Effect.scoped, Effect.provide(dependencies));
}
