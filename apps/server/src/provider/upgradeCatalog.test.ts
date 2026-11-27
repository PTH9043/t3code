import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import { ProviderRegistryLive } from "./Layers/ProviderRegistry.ts";
import { upgradeInstanceRegistryLayer } from "./Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "./Services/ProviderInstanceRegistryMutator.ts";
import { account } from "./testUtils/providerAccountFixture.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.live(
  "tracks saved primary inventory and global settings after room startup without copying primary data",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const primary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-primary-catalog-" });
        const config = yield* Config.ServerConfig;
        const file = join(primary, "userdata", "settings.json");
        const cache = join(primary, "caches", "secondary.json");
        yield* fs.makeDirectory(join(primary, "userdata"));
        yield* fs.makeDirectory(join(primary, "caches"));
        const id = ProviderInstanceId.make("secondary");
        const member = { instanceId: id, model: "first", role: "advisor" };
        const profile = { name: "Global", instructions: "Global role" };
        const entry = {
          driver: "codex",
          displayName: "First",
          config: { customModels: ["first"] },
          environment: [{ name: "TEST_VAR", value: "fixture-private" }],
        };
        const initial = {
          providerInstances: { [id]: entry },
          globalSubordinateTeam: [member],
          globalAssistantProfile: profile,
          threadAssistantProfiles: { foreign: profile },
        };
        const writePrimary = (settings: unknown) => fs.writeFileString(file, json(settings));
        const snapshot = (model: string) =>
          json(
            account(id, {
              models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
              message: "fixture-private",
              skills: [{ name: "private", path: "/private", enabled: true }],
            }),
          );
        yield* writePrimary(initial);
        yield* fs.writeFileString(cache, snapshot("installed"));
        const roomRaw = json({
          threadSubordinateTeams: { local: [] },
          threadAssistantProfiles: { local: { name: "Room", instructions: "Room role" } },
        });
        yield* fs.writeFileString(config.settingsPath, roomRaw);
        let active: ProviderInstanceConfigMap = {};
        const instances = upgradeInstanceRegistryLayer(primary).pipe(
          Layer.provide(
            Layer.merge(
              Layer.mock(ProviderInstanceRegistry)({
                getInstance: () => Effect.succeed(undefined),
              }),
              Layer.succeed(ProviderInstanceRegistryMutator, {
                reconcile: (next) =>
                  Effect.sync(() => {
                    active = next;
                  }),
              }),
            ),
          ),
        );
        const room = Layer.merge(
          Settings.layer.pipe(Layer.provide(SecretStore.layer)),
          ProviderRegistryLive.pipe(Layer.provideMerge(instances)),
        ).pipe(
          Layer.provide(
            Layer.succeed(Config.ServerConfig, {
              ...config,
              upgradeRoom: { primaryHome: primary, projectRoot: config.cwd },
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry;
          const adapters = yield* ProviderInstanceRegistry;
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.start;
          const providers = yield* registry.getProviders;
          expect(JSON.parse(json(providers))).toStrictEqual(providers);
          expect(providers.map((p) => p.instanceId)).toEqual([id]);
          expect(providers[0]?.models.map((m) => m.slug)).toEqual(["installed", "first"]);
          expect(providers[0]?.skills).toEqual([]);
          expect(providers[0]?.usage).toBeUndefined();
          expect(json(providers)).not.toContain("fixture-private");
          const view = yield* settings.getSettings;
          expect(view.globalAssistantProfile).toEqual(profile);
          expect(view.globalSubordinateTeam).toEqual([member]);
          expect(view.threadSubordinateTeams).toEqual({ local: [] });
          expect(Object.keys(view.threadAssistantProfiles)).toEqual(["local"]);
          expect(view.providerInstances[id]).toBeUndefined();
          expect(active).toEqual({});
          yield* fs.writeFileString(file, "{");
          expect(yield* registry.getProviders).toEqual(providers);
          expect((yield* settings.getSettings).globalAssistantProfile).toEqual(profile);
          expect(yield* adapters.getInstance(id)).toBeUndefined();
          expect(active).toEqual({});
          yield* writePrimary(initial);
          yield* adapters.getInstance(id);
          expect(active[id]?.displayName).toBe("First");

          const cacheChanged = yield* Deferred.make<void>();
          yield* registry.streamChanges.pipe(
            Stream.runForEach((rows) =>
              rows.some((p) => p.models.some((m) => m.slug === "new-installed"))
                ? Deferred.succeed(cacheChanged, undefined)
                : Effect.void,
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* fs.writeFileString(cache, snapshot("new-installed"));
          yield* Deferred.await(cacheChanged);
          const globalsCleared = yield* Deferred.make<void>();
          const updates = yield* settings.subscribeChanges;
          yield* updates.pipe(
            Stream.runForEach((next) =>
              next.globalAssistantProfile === null && next.globalSubordinateTeam.length === 0
                ? Deferred.succeed(globalsCleared, undefined)
                : Effect.void,
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          const updated = {
            ...entry,
            displayName: "Changed",
            config: { customModels: ["second"] },
          };
          yield* writePrimary({ providerInstances: { [id]: updated } });
          yield* Deferred.await(globalsCleared);
          const current = yield* registry.refreshInstance(id);
          expect(current[0]?.displayName).toBe("Changed");
          expect(current[0]?.models.map((m) => m.slug)).toEqual(["new-installed", "second"]);
          yield* adapters.getInstance(id);
          expect(active[id]?.displayName).toBe("Changed");
          const cleared = yield* settings.getSettings;
          expect(cleared.globalAssistantProfile).toBeNull();
          expect(cleared.globalSubordinateTeam).toEqual([]);
          expect(Object.keys(cleared.threadAssistantProfiles)).toEqual(["local"]);

          const added = ProviderInstanceId.make("added");
          yield* fs.writeFileString(join(primary, "caches", "added.json"), json(account(added)));
          yield* writePrimary({
            providerInstances: { [added]: { driver: "codex", enabled: true } },
          });
          expect((yield* registry.refresh()).map((p) => p.instanceId)).toEqual([added]);
          yield* adapters.getInstance(id);
          expect(active).toEqual({});
          yield* adapters.getInstance(added);
          expect(Object.keys(active)).toEqual([added]);
          yield* writePrimary({});
          expect(yield* registry.getProviders).toEqual([]);
          yield* adapters.getInstance(id);
          expect(active).toEqual({});
          expect(yield* fs.readFileString(file)).toBe("{}");
          expect(yield* fs.readFileString(cache)).toBe(snapshot("new-installed"));
          expect(yield* fs.readFileString(config.settingsPath)).toBe(roomRaw);
          if (yield* fs.exists(config.secretsDir)) {
            expect(yield* fs.readDirectory(config.secretsDir)).toEqual([]);
          }
          expect(yield* fs.readDirectory(join(primary, "userdata"))).toEqual(["settings.json"]);
        }).pipe(Effect.provide(room));
      }).pipe(Effect.provide(Config.layerTest(process.cwd(), { prefix: "t3-room-catalog-" }))),
    ).pipe(Effect.provide(NodeServices.layer)),
);
