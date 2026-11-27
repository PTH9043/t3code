/**
 * ProviderInstanceRegistryHydration — derive a `ProviderInstanceConfigMap`
 * from `ServerSettings` and keep `ProviderInstanceRegistry` in sync with it.
 *
 * The server still reads two shapes:
 *
 *   1. `settings.providerInstances` — the new driver-agnostic map the
 *      registry expects. Keyed by `ProviderInstanceId`, values are
 *      `ProviderInstanceConfig` envelopes.
 *   2. `settings.providers.<kind>` — the legacy single-instance-per-driver
 *      fields (`providers.codex`, `providers.claudeAgent`, …). These are
 *      the source of truth for every deployment that hasn't been migrated
 *      yet to an explicit `providerInstances` entry.
 *
 * This module bridges (2) into (1) and wires the resulting map into a
 * mutable registry. For every built-in driver whose id is not already
 * present in `providerInstances` (keyed on
 * `defaultInstanceIdForDriver(driverKind)` — literally the driver kind as a
 * routing slug), we synthesize an envelope from the legacy field. The
 * registry decodes both flavours through the same `configSchema` and ends
 * up with one uniform `ProviderInstance` per entry.
 *
 * Explicit `providerInstances` entries always win — users can already
 * override the legacy `providers.<kind>` blob by authoring a
 * `providerInstances.codex` entry with a matching driver, and we don't
 * want the synthesized envelope to silently stomp their config.
 *
 * Hot-reload
 * ----------
 * On layer build we:
 *   1. Read the current `ServerSettings` once and use it to seed the
 *      registry's initial state via `ProviderInstanceRegistryMutableLayer`.
 *   2. Fork a daemon fiber (lifetime tied to the layer's scope) that
 *      subscribes to `ServerSettingsService.streamChanges` and calls
 *      `ProviderInstanceRegistryMutator.reconcile` on every emission.
 *
 * Failures inside the watcher are logged and swallowed so a single bad
 * settings emission cannot kill the registry. Unknown drivers and invalid
 * configs already round-trip through the registry's own "unavailable"
 * shadow bucket.
 *
 * @module provider/Layers/ProviderInstanceRegistryHydration
 */
import {
  defaultInstanceIdForDriver,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverLocalOllama, withLocalOllama } from "../localOllama.ts";
import { ServerConfig } from "../../config.ts";
import {
  readUpgradeInstances,
  materializeUpgradeInstance,
  isUpgradeInstanceEnabled,
  watchUpgradeCatalog,
} from "../upgradeCatalog.ts";

import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "../builtInDrivers.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { ProviderInstanceRegistryMutableLayer } from "./ProviderInstanceRegistryLive.ts";

/**
 * Synthesize a `ProviderInstanceConfigMap` from a `ServerSettings` snapshot.
 *
 * Strategy:
 *   1. Copy all explicit `settings.providerInstances` entries verbatim.
 *   2. For each built-in driver whose `defaultInstanceIdForDriver(id)` key
 *      is *not* already in the explicit map, synthesize an entry from the
 *      matching legacy `settings.providers.<kind>` blob.
 *
 * The returned map is the input the registry consumes; pure & exported
 * separately so the hydration logic can be exercised by unit tests
 * without layering.
 */
export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) {
      // Explicit `providerInstances` entry for this slot — user-authored
      // config always wins over the legacy mirror.
      continue;
    }

    // Only built-in drivers have a legacy mirror; the registry's
    // `providers` struct is keyed on the same literal slug as
    // `driverKind`. Access is dynamic (the driver kind is a branded string),
    // but it's constrained to `keyof settings.providers` by the union of
    // built-in driver kinds.
    const legacyKey = driver.driverKind as keyof ServerSettings["providers"];
    const legacyConfig = settings.providers[legacyKey];
    if (legacyConfig === undefined) {
      continue;
    }

    merged[instanceId] = {
      driver: driver.driverKind,
      config: legacyConfig,
    };
  }

  return merged as ProviderInstanceConfigMap;
};

/**
 * Layer that consumes `ProviderInstanceRegistryMutator` and forks a
 * settings-watcher fiber. The fiber's lifetime is tied to the enclosing
 * layer scope (process lifetime in production), so it is interrupted on
 * shutdown without leaking.
 *
 * Errors inside the watcher are logged and swallowed — the registry's own
 * "unavailable" bucket already absorbs unknown drivers and invalid
 * configs, so the only way the watcher could fail is a settings stream
 * tear-down, which logs and exits cleanly.
 */
const settingsWatcherLayer = (localModels: string[]) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const mutator = yield* ProviderInstanceRegistryMutator;
      const serverSettings = yield* ServerSettingsService;
      yield* serverSettings.streamChanges.pipe(
        Stream.runForEach((next) =>
          mutator
            .reconcile(withLocalOllama(deriveProviderInstanceConfigMap(next), localModels))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
              ),
            ),
        ),
        Effect.forkScoped,
      );
    }),
  );

// Opening the picker never starts provider CLIs. Only an explicit lookup materializes an adapter.
export const upgradeInstanceRegistryLayer = (home: string) =>
  Layer.effect(
    ProviderInstanceRegistry,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const registry = yield* ProviderInstanceRegistry;
      const mutator = yield* ProviderInstanceRegistryMutator;
      const lock = yield* Semaphore.make(1);
      const loaded = new Map<
        ProviderInstanceId,
        { configured: ProviderInstanceConfig; resolved: ProviderInstanceConfig }
      >();
      const synchronize = (id?: ProviderInstanceId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const settings = yield* readUpgradeInstances(home).pipe(Effect.option);
            if (Option.isNone(settings)) return undefined;
            for (const [key, active] of loaded) {
              if (!Equal.equals(active.configured, settings.value[key])) loaded.delete(key);
            }
            const entry = id && Object.hasOwn(settings.value, id) ? settings.value[id] : undefined;
            if (id && entry && isUpgradeInstanceEnabled(entry)) {
              // Re-read an invoked adapter's protected input even when only its secret changed.
              const result = yield* materializeUpgradeInstance(home, id, entry).pipe(Effect.option);
              if (Option.isSome(result))
                loaded.set(id, { configured: entry, resolved: result.value });
              else loaded.delete(id);
            }
            yield* mutator.reconcile(
              Object.fromEntries(
                [...loaded].map(([key, item]) => [key, item.resolved]),
              ) as ProviderInstanceConfigMap,
            );
            return id && loaded.has(id) ? yield* registry.getInstance(id) : undefined;
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
        );
      yield* watchUpgradeCatalog(home).pipe(
        Stream.runForEach(() => synchronize()),
        Effect.forkScoped,
      );
      return ProviderInstanceRegistry.of({ ...registry, getInstance: (id) => synchronize(id) });
    }),
  );

/**
 * Hydrate `ProviderInstanceRegistry` from `ServerSettings` and keep it in
 * sync with subsequent `streamChanges` emissions.
 *
 * The Layer's two halves:
 *   - `ProviderInstanceRegistryMutableLayer` produces the registry +
 *     mutator from the initial config map. Its scope owns every
 *     per-instance child scope created during reconcile.
 *   - `SettingsWatcherLive` consumes the mutator and runs a daemon fiber
 *     in the same scope.
 *
 * Composing via `Layer.provideMerge` makes the watcher's deps available
 * from the mutable layer while still surfacing the registry as an output.
 * The mutator tag is technically also exposed; only this module imports
 * it, so the visibility leak is harmless in practice.
 */
export const ProviderInstanceRegistryHydrationLive: Layer.Layer<
  ProviderInstanceRegistry,
  never,
  BuiltInDriversEnv | ServerSettingsService
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
    if (config?.upgradeRoom) {
      const home = config.upgradeRoom.primaryHome;
      return upgradeInstanceRegistryLayer(home).pipe(
        Layer.provide(
          ProviderInstanceRegistryMutableLayer({ drivers: BUILT_IN_DRIVERS, configMap: {} }),
        ),
      );
    }
    const serverSettings = yield* ServerSettingsService;
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const localModels = initialSettings ? yield* Effect.promise(discoverLocalOllama) : [];
    const initialConfigMap =
      initialSettings === undefined
        ? ({} as ProviderInstanceConfigMap)
        : withLocalOllama(deriveProviderInstanceConfigMap(initialSettings), localModels);

    const mutableLayer = ProviderInstanceRegistryMutableLayer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
    });

    return settingsWatcherLayer(localModels).pipe(Layer.provideMerge(mutableLayer));
  }),
) as Layer.Layer<ProviderInstanceRegistry, never, BuiltInDriversEnv | ServerSettingsService>;
