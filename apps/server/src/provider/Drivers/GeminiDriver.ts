import { GeminiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeGeminiTextGeneration } from "../../textGeneration/GeminiTextGeneration.ts";
import { makeAntigravityEnvironment, resolveAntigravityLaunch } from "./AntigravityLaunch.ts";
import { syncAntigravityIsolatedSkillsConfig } from "./GeminiSkills.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGeminiAdapter } from "../Layers/GeminiAdapter.ts";
import {
  buildInitialGeminiProviderSnapshot,
  checkGeminiProviderStatus,
  clearGeminiAuthCooldown,
} from "../Layers/GeminiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeGeminiSettings = Schema.decodeSync(GeminiSettings);

const DRIVER_KIND = ProviderDriverKind.make("gemini");

export type GeminiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const GeminiDriver: ProviderDriver<GeminiSettings, GeminiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Antigravity CLI",
    supportsMultipleInstances: true,
  },
  configSchema: GeminiSettings,
  defaultConfig: (): GeminiSettings => decodeGeminiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const launch = resolveAntigravityLaunch({
        settings: config,
        instanceId,
        stateDir: serverConfig.stateDir,
      });
      syncAntigravityIsolatedSkillsConfig({ geminiDir: launch.geminiDir });
      const effectiveConfig = { ...config, binaryPath: launch.command, enabled };
      const processEnv = makeAntigravityEnvironment(environment);
      const continuationIdentity = {
        ...defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        }),
        continuationKey: "antigravity:" + instanceId + ":" + launch.profileDirectory,
      };
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const maintenanceCapabilities = { provider: DRIVER_KIND, packageName: null, update: null };

      let refreshSnapshotOnTurnSettled: Effect.Effect<void> = Effect.void;
      const adapter = yield* makeGeminiAdapter(effectiveConfig, {
        launch,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        onTurnSettled: () => refreshSnapshotOnTurnSettled,
      });
      const textGeneration = yield* makeGeminiTextGeneration(effectiveConfig, processEnv, launch);

      const checkProvider = checkGeminiProviderStatus(effectiveConfig, processEnv, launch).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GeminiSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialGeminiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        beforeManualRefresh: Effect.sync(() => clearGeminiAuthCooldown(effectiveConfig, launch)),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Gemini snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      refreshSnapshotOnTurnSettled = Effect.ignore(snapshot.refresh);

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
