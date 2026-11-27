import { MuseSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeMuseTextGeneration } from "../../textGeneration/MuseTextGeneration.ts";
import { makeMuseCloudTextGeneration } from "../../textGeneration/MuseCloudTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeMuseAdapter } from "../Layers/MuseAdapter.ts";
import { makeMuseCloudAdapter } from "../Layers/MuseCloudAdapter.ts";
import {
  buildInitialMuseProviderSnapshot,
  checkMuseProviderStatus,
  enrichMuseSnapshot,
} from "../Layers/MuseProvider.ts";
import {
  buildInitialMuseCloudProviderSnapshot,
  checkMuseCloudProviderStatus,
} from "../Layers/MuseCloudProvider.ts";
import {
  hasMuseApiKeyInEnv,
  makeMuseContinuationGroupKey,
  makeMuseEnvironment,
  resolveMuseBinaryPath,
} from "./MuseHome.ts";
import {
  makeMuseCloudContinuationGroupKey,
  makeMuseCloudEnvironment,
  resolveMuseCloudBinaryPath,
} from "./MuseCloudHome.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);

const DRIVER_KIND = ProviderDriverKind.make("muse");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type MuseDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
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

export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Muse",
    supportsMultipleInstances: true,
  },
  configSchema: MuseSettings,
  defaultConfig: (): MuseSettings => decodeMuseSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const baseProcessEnv = mergeProviderInstanceEnvironment(environment);
      const isCloudBackend = config.backendMode === "cloud";

      if (isCloudBackend) {
        const effectiveConfig = {
          ...config,
          enabled,
          backendMode: "cloud" as const,
        } satisfies MuseSettings;
        const processEnv = yield* makeMuseCloudEnvironment(effectiveConfig, baseProcessEnv);
        if (effectiveConfig.homePath.trim().length > 0) {
          yield* fileSystem
            .makeDirectory(
              path.join(processEnv.USERPROFILE ?? effectiveConfig.homePath, ".config", "muse-cli"),
              {
                recursive: true,
              },
            )
            .pipe(Effect.ignore);
        }
        const continuationKey = yield* makeMuseCloudContinuationGroupKey(
          effectiveConfig,
          processEnv,
        );
        const continuationIdentity = {
          ...defaultProviderContinuationIdentity({
            driverKind: DRIVER_KIND,
            instanceId,
          }),
          continuationKey,
        };
        const safeCloudDisplayName =
          displayName && !displayName.includes("\uFFFD") ? displayName : undefined;
        const stampIdentity = withInstanceIdentity({
          instanceId,
          displayName: safeCloudDisplayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          UPDATE,
          {
            binaryPath: resolveMuseCloudBinaryPath(effectiveConfig.cloudBinaryPath),
            env: processEnv,
          },
        );

        const adapter = yield* makeMuseCloudAdapter(effectiveConfig, {
          environment: processEnv,
          instanceId,
        });
        const textGeneration = yield* makeMuseCloudTextGeneration(effectiveConfig, processEnv);

        const checkProvider = checkMuseCloudProviderStatus(effectiveConfig, processEnv).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MuseSettings>>({
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            buildInitialMuseCloudProviderSnapshot(settings.provider).pipe(
              Effect.map(stampIdentity),
            ),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
            enrichMuseSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
              httpClient,
            }),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to build muse.ai cloud snapshot: ${cause.message ?? String(cause)}`,
                cause,
              }),
          ),
        );

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
      }

      const isCustomApiKeyInstance =
        String(instanceId) !== String(DRIVER_KIND) &&
        hasMuseApiKeyInEnv(baseProcessEnv) &&
        config.homePath.trim().length === 0 &&
        !baseProcessEnv.XDG_CONFIG_HOME?.trim();
      const autoIsolatedApiHome = isCustomApiKeyInstance
        ? path.join(serverConfig.stateDir, "provider-instances", String(instanceId), "muse-home")
        : "";
      const effectiveConfig = {
        ...config,
        enabled,
        ...(autoIsolatedApiHome ? { homePath: autoIsolatedApiHome } : {}),
      } satisfies MuseSettings;
      const processEnv = yield* makeMuseEnvironment(effectiveConfig, baseProcessEnv);
      if (effectiveConfig.homePath.trim().length > 0 && processEnv.XDG_CONFIG_HOME) {
        yield* fileSystem
          .makeDirectory(path.join(processEnv.XDG_CONFIG_HOME, "muse"), { recursive: true })
          .pipe(Effect.ignore);
      }
      const continuationKey = yield* makeMuseContinuationGroupKey(effectiveConfig, processEnv);
      const continuationIdentity = {
        ...defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        }),
        continuationKey,
      };
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: resolveMuseBinaryPath(effectiveConfig.binaryPath, processEnv),
        env: processEnv,
      });

      const adapter = yield* makeMuseAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeMuseTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkMuseProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MuseSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialMuseProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichMuseSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Muse snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

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
