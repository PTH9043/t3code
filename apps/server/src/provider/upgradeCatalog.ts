import * as Path from "effect/Path";
import {
  OpenCodeApiConnection,
  ProviderDriverKind,
  type ProviderInstanceId,
  ServerSettings,
  ServerSettingsError,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { unprotectWindowsCredential } from "../auth/WindowsCredentialProtection.ts";
import { LOCAL_OLLAMA_INSTANCE, LOCAL_OLLAMA_PROVIDER, withLocalOllama } from "./localOllama.ts";
import { providerEnvironmentSecretName } from "../serverSettings.ts";
import { orderProviderSnapshots, readProviderStatusCache } from "./providerStatusCache.ts";

const isApiConnection = Schema.is(OpenCodeApiConnection);

const decodeProviders = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      providers: ServerSettings.fields.providers,
      providerInstances: ServerSettings.fields.providerInstances,
    }),
  ),
);

const decodeGlobals = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      globalAssistant: ServerSettings.fields.globalAssistant,
      globalSubordinateTeam: ServerSettings.fields.globalSubordinateTeam,
      globalAssistantProfile: ServerSettings.fields.globalAssistantProfile,
      globalResponseStyle: ServerSettings.fields.globalResponseStyle,
    }),
  ),
);

export const readUpgradeGlobals = Effect.fn("readUpgradeGlobals")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const raw = yield* fs.readFileString(join(home, "userdata", "settings.json"));
  return yield* decodeGlobals(raw);
});

/** Read only the two provider fields. Never feed primary room settings or secrets into the client. */
export const readUpgradeInstances = Effect.fn("readUpgradeInstances")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const raw = yield* fs.readFileString(join(home, "userdata", "settings.json"));
  const { providers, providerInstances } = yield* decodeProviders(raw).pipe(
    Effect.mapError(
      () =>
        new ServerSettingsError({
          settingsPath: join(home, "userdata", "settings.json"),
          operation: "read-file",
          cause: "Invalid primary T3 provider settings.",
        }),
    ),
  );
  const entries: Record<string, ProviderInstanceConfig> = { ...providerInstances };
  for (const [driver, config] of Object.entries(providers)) {
    entries[driver] ??= { driver: ProviderDriverKind.make(driver), config };
  }
  const instances = entries as ProviderInstanceConfigMap;
  if (Object.hasOwn(instances, LOCAL_OLLAMA_INSTANCE)) return instances;
  const local = yield* readProviderStatusCache(
    join(home, "caches", LOCAL_OLLAMA_INSTANCE + ".json"),
  );
  if (!local || local.instanceId !== LOCAL_OLLAMA_INSTANCE || local.driver !== "opencode")
    return instances;
  const prefix = LOCAL_OLLAMA_PROVIDER + "/";
  const tags = local.models
    .filter((model) => model.slug.startsWith(prefix))
    .map((model) => model.slug.slice(prefix.length));
  return withLocalOllama(instances, tags);
});

/** Directory watches also observe atomic file replacements. Never create primary directories. */
export const watchUpgradeCatalog = (home: string, includeModels = false) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const watch = (directory: string, matches: (name: string) => boolean) =>
        fs.watch(path.join(home, directory)).pipe(
          Stream.filter((event) => matches(path.basename(event.path))),
          Stream.retry(Schedule.spaced("1 second")),
        );
      const settings = watch("userdata", (name) => name === "settings.json");
      return (
        includeModels
          ? Stream.merge(
              settings,
              watch("caches", (name) => name.endsWith(".json")),
            )
          : settings
      ).pipe(Stream.debounce("100 millis"));
    }),
  );

export function isUpgradeInstanceEnabled(entry: ProviderInstanceConfig) {
  const config = entry.config;
  return (
    entry.enabled ??
    !(config && typeof config === "object" && "enabled" in config && config.enabled === false)
  );
}

/** Only an explicitly invoked adapter receives its credential, in memory. Never migrate primary files. */
export const materializeUpgradeInstance = Effect.fn("materializeUpgradeInstance")(function* (
  home: string,
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const environment = yield* Effect.forEach(instance.environment ?? [], (variable) =>
    Effect.gen(function* () {
      if (!variable.valueRedacted) return variable;
      const name = providerEnvironmentSecretName({ instanceId, name: variable.name });
      const bytes = yield* fs.readFile(join(home, "userdata", "secrets", name + ".bin"));
      const value = yield* Effect.try(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(unprotectWindowsCredential(name, bytes)),
      );
      if (!value)
        return yield* new ServerSettingsError({
          settingsPath: home,
          operation: "read-secret",
          cause: "Empty account credential.",
        });
      return { ...variable, value };
    }),
  );
  return { ...instance, environment };
});

export const readUpgradeProviders = Effect.fn("readUpgradeProviders")(function* (home: string) {
  const instances = yield* readUpgradeInstances(home);
  const { join } = yield* Path.Path;
  const providers: ServerProvider[] = [];
  for (const [id, entry] of Object.entries(instances)) {
    const cached = yield* readProviderStatusCache(join(home, "caches", id + ".json"));
    if (!cached || cached.instanceId !== id || cached.driver !== entry.driver) continue;
    const config = entry.config;
    const customModels =
      config &&
      typeof config === "object" &&
      "customModels" in config &&
      Array.isArray(config.customModels)
        ? config.customModels.filter((m): m is string => typeof m === "string" && !!m.trim())
        : [];
    const models = cached.models.filter((m) => !m.isCustom || customModels.includes(m.slug));
    for (const slug of customModels) {
      if (!models.some((model) => model.slug === slug))
        models.push({ slug, name: slug, isCustom: true, capabilities: null });
    }
    const connection =
      entry.driver === "opencode" &&
      config &&
      typeof config === "object" &&
      "apiConnection" in config
        ? config.apiConnection
        : undefined;
    if (connection !== undefined && !isApiConnection(connection)) continue;
    const accountModels = connection
      ? connection.models.map((model) => {
          const slug = connection.providerId + "/" + model;
          return (
            models.find((m) => m.slug === slug) ?? {
              slug,
              name: model,
              isCustom: false,
              capabilities: null,
            }
          );
        })
      : models;
    providers.push({
      instanceId: cached.instanceId,
      driver: cached.driver,
      ...((entry.displayName ?? cached.displayName) !== undefined
        ? { displayName: entry.displayName ?? cached.displayName }
        : {}),
      ...((entry.accentColor ?? cached.accentColor) !== undefined
        ? { accentColor: entry.accentColor ?? cached.accentColor }
        : {}),
      ...(cached.badgeLabel !== undefined ? { badgeLabel: cached.badgeLabel } : {}),
      enabled: isUpgradeInstanceEnabled(entry) && cached.enabled,
      installed: cached.installed,
      ...(cached.availability !== undefined ? { availability: cached.availability } : {}),
      version: cached.version,
      status: cached.status,
      auth: cached.auth,
      checkedAt: cached.checkedAt,
      ...(cached.requiresNewThreadForModelChange !== undefined
        ? { requiresNewThreadForModelChange: cached.requiresNewThreadForModelChange }
        : {}),
      ...(cached.showInteractionModeToggle !== undefined
        ? { showInteractionModeToggle: cached.showInteractionModeToggle }
        : {}),
      models: accountModels,
      skills: [],
      slashCommands: [],
    });
  }
  return orderProviderSnapshots(providers);
});
