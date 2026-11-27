// @effect-diagnostics nodeBuiltinImport:off - Compare complete provider selections before IPC handoff.
import { isDeepStrictEqual } from "node:util";
import {
  EnvironmentId,
  ProviderExecutionContext,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { RuntimeMode, ServerConfig, StartupPresentation } from "../config.ts";
import { watchdogSettingsSnapshot } from "./WatchdogProviderRuntime.ts";

const LogLevel = Schema.Literals([
  "All",
  "Fatal",
  "Error",
  "Warn",
  "Info",
  "Debug",
  "Trace",
  "None",
]);
const Config = Schema.Struct({
  stateDir: Schema.String,
  dbPath: Schema.String,
  keybindingsConfigPath: Schema.String,
  settingsPath: Schema.String,
  providerStatusCacheDir: Schema.String,
  worktreesDir: Schema.String,
  attachmentsDir: Schema.String,
  logsDir: Schema.String,
  serverLogPath: Schema.String,
  serverTracePath: Schema.String,
  providerLogsDir: Schema.String,
  providerEventLogPath: Schema.String,
  terminalLogsDir: Schema.String,
  anonymousIdPath: Schema.String,
  environmentIdPath: Schema.String,
  serverRuntimeStatePath: Schema.String,
  secretsDir: Schema.String,
  logLevel: LogLevel,
  traceMinLevel: LogLevel,
  traceTimingEnabled: Schema.Boolean,
  traceBatchWindowMs: Schema.Number,
  traceMaxBytes: Schema.Number,
  traceMaxFiles: Schema.Number,
  otlpTracesUrl: Schema.optionalKey(Schema.String),
  otlpMetricsUrl: Schema.optionalKey(Schema.String),
  otlpExportIntervalMs: Schema.Number,
  otlpServiceName: Schema.String,
  mode: RuntimeMode,
  port: Schema.Number,
  host: Schema.optionalKey(Schema.String),
  cwd: Schema.String,
  baseDir: Schema.String,
  staticDir: Schema.optionalKey(Schema.String),
  devUrl: Schema.optionalKey(Schema.String),
  devAllowedOrigins: Schema.Array(Schema.String),
  noBrowser: Schema.Boolean,
  startupPresentation: StartupPresentation,
  resourceMonitorPath: Schema.optionalKey(Schema.String),
  autoBootstrapProjectFromCwd: Schema.Boolean,
  logWebSocketEvents: Schema.Boolean,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: Schema.Number,
});

const McpCredential = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  endpoint: Schema.String,
  authorizationHeader: Schema.String,
});

/** Encoded settings must contain only the selected provider and applicable tools. */
export const WatchdogWorkerPayload = Schema.Struct({
  journalPath: Schema.String,
  capability: Schema.String,
  providerInstanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
  serverConfig: Config,
  settings: ServerSettings,
  execution: ProviderExecutionContext,
  start: ProviderSessionStartInput,
  turn: ProviderSendTurnInput,
  mcp: Schema.optionalKey(McpCredential),
});
export type WatchdogWorkerPayload = typeof WatchdogWorkerPayload.Type;

/** Produce the JSON-compatible IPC payload without copying unrelated providers. */
export function encodeWatchdogWorkerPayload(
  input: Omit<WatchdogWorkerPayload, "serverConfig"> & {
    readonly serverConfig: ServerConfig["Service"];
  },
): typeof WatchdogWorkerPayload.Encoded {
  const { start, turn, execution, providerInstanceId, instance } = input;
  if (
    start.threadId !== turn.threadId ||
    start.threadId !== String(execution.executionId) ||
    start.provider !== instance.driver ||
    start.providerInstanceId !== providerInstanceId ||
    start.modelSelection?.instanceId !== providerInstanceId ||
    turn.modelSelection?.instanceId !== providerInstanceId ||
    !isDeepStrictEqual(start.modelSelection, turn.modelSelection) ||
    (start.execution !== undefined && !isDeepStrictEqual(start.execution, execution)) ||
    (input.mcp !== undefined &&
      (input.mcp.threadId !== start.threadId ||
        input.mcp.providerInstanceId !== providerInstanceId))
  )
    throw new Error("Watchdog launch does not match the selected execution.");
  return Schema.encodeSync(WatchdogWorkerPayload)({
    ...input,
    serverConfig: watchdogConfigSnapshot(input.serverConfig),
    settings: watchdogSettingsSnapshot({
      instanceId: providerInstanceId,
      instance,
      settings: input.settings,
      cwd: start.cwd ?? input.serverConfig.cwd,
    }),
  });
}

/** Never pass desktop bootstrap tokens or inherited file descriptors to the child. */
export function watchdogConfigSnapshot(config: ServerConfig["Service"]): typeof Config.Type {
  const {
    desktopBootstrapToken: _desktopBootstrapToken,
    desktopTelemetryFd: _desktopTelemetryFd,
    desktopTelemetryControlFd: _desktopTelemetryControlFd,
    desktopDirectRpcInputFd: _desktopDirectRpcInputFd,
    desktopDirectRpcOutputFd: _desktopDirectRpcOutputFd,
    devUrl,
    host,
    staticDir,
    otlpTracesUrl,
    otlpMetricsUrl,
    resourceMonitorPath,
    ...rest
  } = config;
  return {
    ...rest,
    ...(devUrl !== undefined ? { devUrl: devUrl.href } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(staticDir !== undefined ? { staticDir } : {}),
    ...(otlpTracesUrl !== undefined ? { otlpTracesUrl } : {}),
    ...(otlpMetricsUrl !== undefined ? { otlpMetricsUrl } : {}),
    ...(resourceMonitorPath !== undefined ? { resourceMonitorPath } : {}),
  };
}

export function watchdogConfigFromSnapshot(config: typeof Config.Type): ServerConfig["Service"] {
  const { devUrl, host, staticDir, otlpTracesUrl, otlpMetricsUrl, ...rest } = config;
  return ServerConfig.of({
    ...rest,
    devUrl: devUrl === undefined ? undefined : new URL(devUrl),
    host,
    staticDir,
    otlpTracesUrl,
    otlpMetricsUrl,
    desktopBootstrapToken: undefined,
  });
}
