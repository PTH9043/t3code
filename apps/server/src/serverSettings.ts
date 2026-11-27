/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  OPENAI_API_CREDENTIAL_ENV,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  findThreadModelTeam,
  type ThreadId,
  type ThreadModelTeam,
  type ThreadTeamMember,
  ThreadResponseStyle,
  type ThreadResponseStyleSeed,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import { readLastKnownGoodConfig, saveLastKnownGoodConfig } from "./configRecoveryGuard.ts";
import { readUpgradeGlobals, watchUpgradeCatalog } from "./provider/upgradeCatalog.ts";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@t3tools/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  applyServerSettingsPatch,
  isModelSelectionProviderEnabled,
} from "@t3tools/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

export { resolveSourceControlWriterModelSelection } from "@t3tools/shared/serverSettings";

const patchSettings = Effect.fnUntraced(function* (
  current: ServerSettings,
  patch: ServerSettingsPatch,
) {
  const preset = patch.threadSettingsPresetSave;
  if (preset) {
    const nameKey = (name: string) => name.trim().normalize("NFKC").toLowerCase();
    if (
      current.threadSettingsPresets.some(
        (saved) => saved.id !== preset.id && nameKey(saved.name) === nameKey(preset.name),
      )
    ) {
      return yield* new ServerSettingsError({
        settingsPath: "<thread settings presets>",
        operation: "normalize",
        cause: "A preset with this name already exists.",
      });
    }
  }
  const next = applyServerSettingsPatch(current, patch);
  const change = patch.backgroundWatchThreadUpdate;
  if (!change || change.enabled || !current.backgroundWatchThreadIds.includes(change.threadId))
    return next;
  return {
    ...next,
    backgroundWatchRevokedAtMs: {
      ...current.backgroundWatchRevokedAtMs,
      [change.threadId]: DateTime.toEpochMillis(yield* DateTime.now),
    },
  };
});

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsJson = Schema.encodeUnknownEffect(fromJsonStringPretty(ServerSettings));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

const sameRoomStyle = Schema.toEquivalence(Schema.NullOr(ThreadResponseStyle));

function seedThreadModelTeams(
  settings: ServerSettings,
  threadId: ThreadId,
  teams: readonly ThreadModelTeam[],
  style?: ThreadResponseStyleSeed,
  customSubordinateTeam?: readonly ThreadTeamMember[],
) {
  const previous = settings.threadModelTeamInitialization;
  if (previous?.initializedThreads.includes(threadId)) return Effect.succeed(settings);
  if (teams.some((team) => team.threadId !== threadId)) {
    return Effect.fail(
      new ServerSettingsError({
        settingsPath: "<thread model teams>",
        operation: "normalize",
        cause: "A team belongs to a different thread.",
      }),
    );
  }
  const merged = [...settings.threadModelTeams];
  for (const team of teams) {
    if (!findThreadModelTeam(merged, team) && !findThreadModelTeam(previous?.resetScopes, team)) {
      merged.push(team);
    }
  }
  return Effect.succeed({
    ...settings,
    threadModelTeams: merged,
    ...(customSubordinateTeam !== undefined &&
    !Object.hasOwn(settings.threadSubordinateTeams, threadId)
      ? {
          threadSubordinateTeams: {
            ...settings.threadSubordinateTeams,
            [threadId]: customSubordinateTeam,
          },
        }
      : {}),
    ...(style && sameRoomStyle(settings.threadResponseStyles[threadId] ?? null, style.previous)
      ? { threadResponseStyles: { ...settings.threadResponseStyles, [threadId]: style.value } }
      : {}),
    threadModelTeamInitialization: {
      initializedThreads: [...(previous?.initializedThreads ?? []), threadId],
      resetScopes: (previous?.resetScopes ?? []).filter((scope) => scope.threadId !== threadId),
    },
  });
}

function runPermittedMonitoringAction<A, E, R>(
  semaphore: Semaphore.Semaphore,
  readSettings: Effect.Effect<ServerSettings, ServerSettingsError>,
  action: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E | ServerSettingsError, R> {
  return semaphore.withPermits(1)(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const settings = yield* readSettings;
        if (!settings.workspaceProgramPermissions.monitoringAutoActions) return Option.none<A>();
        return Option.some(yield* action);
      }),
    ),
  );
}

export function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

function mcpHeaderSecretName(server: string, header: string): string {
  return `mcp-header-${Buffer.from(server, "utf8").toString("base64url")}-${Buffer.from(header, "utf8").toString("base64url")}`;
}

function protectProviderApiCredential(
  instance: ProviderInstanceConfig,
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  if (variable.name.toUpperCase() === OPENAI_API_CREDENTIAL_ENV)
    return { ...variable, sensitive: true };
  const config = instance.config;
  return instance.driver === "claudeAgent" &&
    typeof config === "object" &&
    config !== null &&
    "authMode" in config &&
    config.authMode === "api-key" &&
    variable.name.toUpperCase() === "ANTHROPIC_API_KEY"
    ? { ...variable, sensitive: true }
    : variable;
}

function redactProviderEnvironmentVariable(
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  if (!variable.sensitive) {
    const { valueRedacted: _omit, ...rest } = variable;
    return rest;
  }
  return {
    ...variable,
    value: "",
    ...(variable.value.length > 0 || variable.valueRedacted ? { valueRedacted: true } : {}),
  };
}

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
      instanceId,
      instance.environment
        ? {
            ...instance,
            environment: instance.environment.map((variable) =>
              redactProviderEnvironmentVariable(protectProviderApiCredential(instance, variable)),
            ),
          }
        : instance,
    ]),
  );
  const customMcpServers = Object.fromEntries(
    Object.entries(settings.customMcpServers).map(([id, server]) => {
      if (server.transport !== "http") return [id, server];
      const redactedHeaders = new Set(server.redactedHeaders ?? []);
      const headers = Object.fromEntries(
        Object.entries(server.headers).map(([name, value]) => {
          if (value.length > 0) redactedHeaders.add(name);
          return [name, redactedHeaders.has(name) ? "" : value];
        }),
      );
      return [id, { ...server, headers, redactedHeaders: [...redactedHeaders] }];
    }),
  );
  const { threadModelTeamInitialization: _receipt, ...publicSettings } = settings;
  return {
    ...publicSettings,
    threadSettingsPresets: [],
    threadSettingsInheritedTeamScopes: [],
    providerInstances,
    customMcpServers,
  };
}

type WatchPolicy = Pick<ServerSettings, "backgroundWatchThreadIds" | "backgroundWatchRevokedAtMs">;

function watchPolicySource(
  current: Effect.Effect<ServerSettings, ServerSettingsError>,
  changes: PubSub.PubSub<ServerSettings>,
) {
  const select = (settings: ServerSettings): WatchPolicy => ({
    backgroundWatchThreadIds: settings.backgroundWatchThreadIds,
    ...(settings.backgroundWatchRevokedAtMs
      ? { backgroundWatchRevokedAtMs: settings.backgroundWatchRevokedAtMs }
      : {}),
  });
  return {
    current: current.pipe(
      Effect.map(select),
      Effect.catch((error) =>
        Effect.logWarning("Could not read conversation watch consent", {
          operation: error.operation,
        }).pipe(Effect.as<WatchPolicy>({ backgroundWatchThreadIds: [] })),
      ),
    ),
    subscribe: PubSub.subscribe(changes).pipe(
      Effect.map((subscription) => Stream.map(Stream.fromSubscription(subscription), select)),
    ),
  };
}

/** Restricted services without a watch policy have no opted-in conversations. */
export const backgroundWatchPolicy = (settings: ServerSettingsService["Service"]) =>
  settings.backgroundWatchPolicy ?? {
    current: Effect.succeed<WatchPolicy>({ backgroundWatchThreadIds: [] }),
    subscribe: Effect.succeed(Stream.empty as Stream.Stream<WatchPolicy>),
  };

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    /** Start the settings runtime and attach file watching. */
    readonly start: Effect.Effect<void, ServerSettingsError>;

    /** Await settings runtime readiness. */
    readonly ready: Effect.Effect<void, ServerSettingsError>;

    /** Read the current settings. */
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Watch-only snapshot and subscription; neither materializes provider secrets. */
    readonly backgroundWatchPolicy?: ReturnType<typeof watchPolicySource>;

    /** Apply draft overrides once, after the turn is accepted. */
    readonly initializeThreadModelTeams: (
      threadId: ThreadId,
      teams: readonly ThreadModelTeam[],
      style?: ThreadResponseStyleSeed,
      customSubordinateTeam?: readonly ThreadTeamMember[],
    ) => Effect.Effect<void, ServerSettingsError>;

    /** Patch settings and persist. Returns the new full settings object. */
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    /**
     * Check global monitoring permission and finish dispatch while settings
     * writes wait. None means disabled; a failure is propagated.
     * Once started, the action is uninterruptible until it settles; it must not
     * call updateSettings or otherwise re-enter this lock.
     */
    readonly runMonitoringAutoAction: <A, E, R>(
      action: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E | ServerSettingsError, R>;

    /** Stream of settings change events. */
    readonly streamChanges: Stream.Stream<ServerSettings>;

    /**
     * Acquire a settings change subscription synchronously in the current
     * fiber. Use this before reading a snapshot when changes between the
     * snapshot and a lazily started stream must not be lost.
     */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  }
>()("t3/serverSettings/ServerSettingsService") {
  /** @deprecated Import and use `layerTest` from this module. */
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const makeTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Effect.gen(function* () {
    const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
      overrides;
    const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
    const initialSettings = yield* normalizeServerSettings({
      ...merged,
      ...(automaticGitFetchInterval !== undefined
        ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
        : {}),
      ...(providerHealthRefreshInterval !== undefined
        ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
        : {}),
    });
    const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const writeSemaphore = yield* Semaphore.make(1);

    return {
      start: Effect.void,
      ready: Effect.void,
      backgroundWatchPolicy: watchPolicySource(Ref.get(currentSettingsRef), changes),
      getSettings: Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider)),
      initializeThreadModelTeams: (threadId, teams, style, customSubordinateTeam) =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(currentSettingsRef);
            const next = yield* seedThreadModelTeams(
              current,
              threadId,
              teams,
              style,
              customSubordinateTeam,
            );
            if (next !== current)
              yield* Ref.set(currentSettingsRef, yield* normalizeServerSettings(next));
          }),
        ),
      updateSettings: (patch) =>
        writeSemaphore.withPermits(1)(
          Ref.get(currentSettingsRef).pipe(
            Effect.flatMap((currentSettings) => patchSettings(currentSettings, patch)),
            Effect.flatMap(normalizeServerSettings),
            Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
            Effect.tap((nextSettings) => PubSub.publish(changes, nextSettings)),
            Effect.map(resolveTextGenerationProvider),
          ),
        ),
      runMonitoringAutoAction: (action) =>
        runPermittedMonitoringAction(writeSemaphore, Ref.get(currentSettingsRef), action),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    } satisfies ServerSettingsService["Service"];
  });

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(ServerSettingsService, makeTest(overrides));

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(ServerSettingsJson);

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  return isModelSelectionProviderEnabled(settings, settings.textGenerationModelSelection)
    ? settings
    : fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const fallbackEntry = Object.entries(settings.providers).find(([, provider]) => provider.enabled);
  const fallback = fallbackEntry ? ProviderDriverKind.make(fallbackEntry[0]) : undefined;
  if (!fallback) {
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make(fallback),
      model:
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_TEXT_GENERATION_MODEL,
    } satisfies ModelSelection,
  };
}

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "sourceControlWriterModelSelection",
  "textGenerationModelSelection",
]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const make = Effect.gen(function* () {
  const { settingsPath, upgradeRoom } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "check-exists",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
    ),
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    if (!(yield* readConfigExists)) {
      return DEFAULT_SERVER_SETTINGS;
    }

    const raw = yield* readRawConfig;
    const decoded = decodeServerSettingsJsonExit(raw);
    if (decoded._tag === "Failure") {
      if (!settingsPath.startsWith("<")) {
        const lkgRaw = readLastKnownGoodConfig(settingsPath);
        if (lkgRaw !== null) {
          const lkgDecoded = decodeServerSettingsJsonExit(lkgRaw);
          if (lkgDecoded._tag === "Success") {
            yield* Effect.logWarning(
              "failed to parse settings.json, recovered from last-known-good backup",
              {
                path: settingsPath,
                issues: Cause.pretty(decoded.cause),
              },
            );
            return lkgDecoded.value;
          }
        }
      }
      yield* Effect.logWarning("failed to parse settings.json, using defaults", {
        path: settingsPath,
        issues: Cause.pretty(decoded.cause),
        cause: decoded.cause,
      });
      return DEFAULT_SERVER_SETTINGS;
    }
    if (!settingsPath.startsWith("<")) {
      saveLastKnownGoodConfig(settingsPath, raw);
    }
    return decoded.value;
  });

  const settingsCache = yield* Cache.make<typeof cacheKey, ServerSettings, ServerSettingsError>({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);
  const lastUpgradeGlobals = yield* SynchronizedRef.make({
    globalAssistant: DEFAULT_SERVER_SETTINGS.globalAssistant,
    globalSubordinateTeam: DEFAULT_SERVER_SETTINGS.globalSubordinateTeam,
    globalAssistantProfile: DEFAULT_SERVER_SETTINGS.globalAssistantProfile,
    globalResponseStyle: DEFAULT_SERVER_SETTINGS.globalResponseStyle,
  });
  const withUpgradeGlobals = (settings: ServerSettings) =>
    upgradeRoom
      ? SynchronizedRef.updateAndGetEffect(lastUpgradeGlobals, (last) =>
          readUpgradeGlobals(upgradeRoom.primaryHome).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, pathService),
            Effect.orElseSucceed(() => last),
          ),
        ).pipe(Effect.map((globals) => ({ ...settings, ...globals })))
      : Effect.succeed(settings);

  const materializeProviderEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          if (!variable.sensitive || !variable.valueRedacted) {
            environment.push(variable);
            continue;
          }
          const secret = yield* secretStore
            .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to read provider credential", {
                  providerInstanceId: instanceId,
                  environmentVariable: variable.name,
                  errorType: cause._tag,
                }).pipe(Effect.as(Option.none<Uint8Array>())),
              ),
            );
          environment.push({
            ...variable,
            value: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
          });
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }
      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  const materializeMcpHeaders = (settings: ServerSettings) =>
    Effect.gen(function* () {
      const customMcpServers = { ...settings.customMcpServers };
      for (const [id, server] of Object.entries(customMcpServers)) {
        if (server.transport !== "http" || !server.redactedHeaders?.length) continue;
        const headers = { ...server.headers };
        for (const name of server.redactedHeaders) {
          if (!(name in headers)) continue;
          const secret = yield* secretStore.get(mcpHeaderSecretName(id, name)).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-secret",
                  environmentVariable: name,
                  cause,
                }),
            ),
          );
          if (Option.isNone(secret)) {
            return yield* new ServerSettingsError({
              settingsPath,
              operation: "read-secret",
              environmentVariable: name,
              cause: `Missing secret for MCP server ${id}.`,
            });
          }
          headers[name] = textDecoder.decode(secret.value);
        }
        customMcpServers[id] = { ...server, headers };
      }
      return { ...settings, customMcpServers };
    });

  const materializeSettingsSecrets = (settings: ServerSettings) =>
    materializeProviderEnvironmentSecrets(settings).pipe(Effect.flatMap(materializeMcpHeaders));

  const persistMcpHeaders = (current: ServerSettings, next: ServerSettings) =>
    Effect.gen(function* () {
      const customMcpServers = { ...next.customMcpServers };
      for (const [id, server] of Object.entries(customMcpServers)) {
        if (server.transport !== "http") continue;
        const previous = current.customMcpServers[id];
        const headers = { ...server.headers };
        const redactedHeaders: string[] = [];
        for (const [name, supplied] of Object.entries(headers)) {
          const preserve =
            supplied === "" &&
            (server.redactedHeaders?.includes(name) ||
              (previous?.transport === "http" &&
                (previous.redactedHeaders?.includes(name) || Boolean(previous.headers[name]))));
          const legacyValue =
            preserve && previous?.transport === "http" ? previous.headers[name] : undefined;
          const value = preserve && legacyValue ? legacyValue : supplied;
          const secretName = mcpHeaderSecretName(id, name);
          if (value.length > 0) {
            yield* secretStore.set(secretName, textEncoder.encode(value)).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "write-secret",
                    environmentVariable: name,
                    cause,
                  }),
              ),
            );
            headers[name] = "";
            redactedHeaders.push(name);
          } else if (preserve) {
            const secret = yield* secretStore.get(secretName).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "read-secret",
                    environmentVariable: name,
                    cause,
                  }),
              ),
            );
            if (Option.isNone(secret)) {
              return yield* new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                environmentVariable: name,
                cause: `Missing secret for MCP server ${id}.`,
              });
            }
            redactedHeaders.push(name);
          }
        }
        customMcpServers[id] = { ...server, headers, redactedHeaders };
      }
      return { ...next, customMcpServers };
    });

  const removeStaleMcpHeaders = (current: ServerSettings, next: ServerSettings) =>
    Effect.gen(function* () {
      for (const [id, server] of Object.entries(current.customMcpServers)) {
        if (server.transport !== "http") continue;
        const replacement = next.customMcpServers[id];
        for (const name of server.redactedHeaders ?? []) {
          if (replacement?.transport === "http" && replacement.redactedHeaders?.includes(name))
            continue;
          yield* secretStore.remove(mcpHeaderSecretName(id, name)).pipe(Effect.ignore);
        }
      }
    });

  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeSettingsSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize provider environment secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(resolveTextGenerationProvider),
      Stream.mapEffect(withUpgradeGlobals),
    );

  const validateProviderSecretReferences = (current: ServerSettings, next: ServerSettings) =>
    Effect.gen(function* () {
      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        for (const supplied of instance.environment ?? []) {
          const variable = protectProviderApiCredential(instance, supplied);
          if (!variable.sensitive || !variable.valueRedacted) continue;
          const previous = current.providerInstances[
            ProviderInstanceId.make(instanceId)
          ]?.environment?.find((entry) => entry.name === variable.name);
          if (previous?.valueRedacted || (previous && previous.value.length > 0)) continue;
          const secret = yield* secretStore
            .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "read-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
          if (Option.isNone(secret)) {
            return yield* new ServerSettingsError({
              settingsPath,
              operation: "read-secret",
              providerInstanceId: instanceId,
              environmentVariable: variable.name,
              cause: "The existing provider credential is missing.",
            });
          }
        }
      }
    });

  const snapshotChangedProviderSecrets = (current: ServerSettings, next: ServerSettings) =>
    Effect.gen(function* () {
      const changed = new Map<string, { instanceId: string; name: string }>();
      const retained = new Set<string>();
      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        for (const supplied of instance.environment ?? []) {
          const variable = protectProviderApiCredential(instance, supplied);
          const key = providerEnvironmentSecretName({ instanceId, name: variable.name });
          const previous = current.providerInstances[
            ProviderInstanceId.make(instanceId)
          ]?.environment?.find((entry) => entry.name === variable.name);
          if (variable.sensitive) retained.add(key);
          if (
            variable.sensitive
              ? !variable.valueRedacted ||
                (previous && !previous.valueRedacted && previous.value.length > 0)
              : previous?.sensitive
          )
            changed.set(key, { instanceId, name: variable.name });
        }
      }
      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        for (const variable of instance.environment ?? []) {
          const key = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (variable.sensitive && !retained.has(key))
            changed.set(key, { instanceId, name: variable.name });
        }
      }
      const snapshot: Array<{ key: string; value: Option.Option<Uint8Array> }> = [];
      for (const [key, details] of changed) {
        const value = yield* secretStore.get(key).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                providerInstanceId: details.instanceId,
                environmentVariable: details.name,
                cause,
              }),
          ),
        );
        snapshot.push({ key, value });
      }
      return snapshot;
    });

  const persistProviderEnvironmentSecrets = (
    current: ServerSettings,
    next: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };

      const nextSecretKeys = new Set<string>();
      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const suppliedVariable of instance.environment) {
          const variable = protectProviderApiCredential(instance, suppliedVariable);
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          const previousVariable = current.providerInstances[
            ProviderInstanceId.make(instanceId)
          ]?.environment?.find((previous) => previous.name === variable.name);
          if (!variable.sensitive) {
            if (previousVariable?.sensitive) {
              yield* secretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "remove-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
            }
            environment.push(redactProviderEnvironmentVariable(variable));
            continue;
          }

          nextSecretKeys.add(secretName);
          if (!variable.valueRedacted) {
            if (variable.value.length > 0) {
              yield* secretStore.set(secretName, textEncoder.encode(variable.value)).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "write-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
              environment.push({ ...variable, value: "", valueRedacted: true });
            } else {
              yield* secretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "remove-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
              const { valueRedacted: _omit, ...rest } = variable;
              environment.push(rest);
            }
            continue;
          }

          if (
            previousVariable &&
            !previousVariable.valueRedacted &&
            previousVariable.value.length > 0
          ) {
            yield* secretStore.set(secretName, textEncoder.encode(previousVariable.value)).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "write-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
          }
          environment.push(redactProviderEnvironmentVariable(variable));
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        for (const variable of instance.environment ?? []) {
          if (!variable.sensitive) continue;
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (nextSecretKeys.has(secretName)) continue;
          yield* secretStore.remove(secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "remove-stale-secret",
                  providerInstanceId: instanceId,
                  environmentVariable: variable.name,
                  cause,
                }),
            ),
          );
        }
      }

      return {
        ...next,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) ?? {},
      );

      const contents = `${sparseSettingsJson}\n`;
      const written = yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
      if (!settingsPath.startsWith("<")) {
        saveLastKnownGoodConfig(settingsPath, contents);
      }
      return written;
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  const commitSettings = Effect.fnUntraced(function* (candidate: ServerSettings) {
    const next = yield* normalizeServerSettings(candidate);
    yield* writeSettingsAtomically(next);
    yield* Cache.set(settingsCache, cacheKey, next);
    yield* emitChange(next);
    return next;
  }, Effect.uninterruptible);

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);
    const settingsFile = pathService.basename(settingsPath);
    const settingsPathResolved = pathService.resolve(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === settingsFile ||
          event.path === settingsPath ||
          pathService.resolve(settingsDir, event.path) === settingsPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
    if (upgradeRoom) {
      yield* watchUpgradeCatalog(upgradeRoom.primaryHome).pipe(
        Stream.runForEach(() =>
          getSettingsFromCache.pipe(Effect.flatMap(emitChange), Effect.ignore),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
        Effect.forkIn(watcherScope),
      );
    }
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    backgroundWatchPolicy: watchPolicySource(getSettingsFromCache, changesPubSub),
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeSettingsSecrets),
      Effect.map(resolveTextGenerationProvider),
      Effect.flatMap(withUpgradeGlobals),
    ),
    initializeThreadModelTeams: (threadId, teams, style, customSubordinateTeam) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getSettingsFromCache;
          const next = yield* seedThreadModelTeams(
            current,
            threadId,
            teams,
            style,
            customSubordinateTeam,
          );
          if (next !== current) yield* commitSettings(next);
        }),
      ),
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getSettingsFromCache;
          const candidate = yield* patchSettings(current, patch);
          yield* validateProviderSecretReferences(current, candidate);
          const snapshot = yield* snapshotChangedProviderSecrets(current, candidate);
          const next = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const attempt = yield* Effect.exit(
                Effect.gen(function* () {
                  const nextProviders = yield* persistProviderEnvironmentSecrets(
                    current,
                    candidate,
                  );
                  const nextPersisted = yield* persistMcpHeaders(current, nextProviders);
                  return yield* commitSettings(nextPersisted);
                }),
              );
              if (Exit.isSuccess(attempt)) return attempt.value;
              let restorationFailed = false;
              for (const entry of snapshot) {
                const restored = yield* Effect.exit(
                  Option.isSome(entry.value)
                    ? secretStore.set(entry.key, entry.value.value)
                    : secretStore.remove(entry.key),
                );
                if (Exit.isFailure(restored)) restorationFailed = true;
              }
              if (restorationFailed) {
                return yield* new ServerSettingsError({
                  settingsPath,
                  operation: "write-secret",
                  cause: "A provider credential could not be restored after a settings failure.",
                });
              }
              return yield* Effect.failCause(attempt.cause);
            }),
          );
          yield* removeStaleMcpHeaders(current, next);
          const materialized = yield* materializeSettingsSecrets(next);
          return yield* withUpgradeGlobals(resolveTextGenerationProvider(materialized));
        }),
      ),
    runMonitoringAutoAction: (action) =>
      runPermittedMonitoringAction(writeSemaphore, getSettingsFromCache, action),
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(
        Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
      );
    },
  } satisfies ServerSettingsService["Service"];
});

export const layer = Layer.effect(ServerSettingsService, make);
