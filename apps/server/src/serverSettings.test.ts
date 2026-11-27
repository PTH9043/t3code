import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type ThreadModelTeam,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);
const decodeSettingsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

const makeFailingSecretStoreLayer = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );

it.layer(NodeServices.layer)("monitoring action permission serialization", (it) => {
  for (const mode of ["persistent", "test-layer"] as const) {
    it.effect(`serializes OFF and action dispatch (${mode})`, () => {
      const test = Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        yield* settings.updateSettings({
          workspaceProgramPermissions: { monitoringAutoActions: true },
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const updateStarted = yield* Deferred.make<void>();
        const updateDone = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const count = yield* Ref.make(0);
        const action = yield* settings
          .runMonitoringAutoAction(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* Ref.update(count, (value) => value + 1);
              return "dispatched";
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const update = yield* Effect.gen(function* () {
          yield* Deferred.succeed(updateStarted, undefined);
          const result = yield* settings.updateSettings({
            workspaceProgramPermissions: { monitoringAutoActions: false },
          });
          yield* Deferred.succeed(updateDone, undefined);
          return result;
        }).pipe(Effect.forkChild);
        yield* Deferred.await(updateStarted);
        yield* Effect.yieldNow;
        const laterAction = yield* Effect.gen(function* () {
          yield* Deferred.succeed(secondStarted, undefined);
          return yield* settings.runMonitoringAutoAction(Ref.update(count, (value) => value + 1));
        }).pipe(Effect.forkChild);
        yield* Deferred.await(secondStarted);
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(updateDone));
        yield* Deferred.succeed(release, undefined);
        assert.deepEqual(yield* Fiber.join(action), Option.some("dispatched"));
        yield* Fiber.join(update);
        assert.deepEqual(yield* Fiber.join(laterAction), Option.none());
        assert.strictEqual(yield* Ref.get(count), 1);
        assert.deepEqual(
          yield* settings.runMonitoringAutoAction(Ref.update(count, (value) => value + 1)),
          Option.none(),
        );
        assert.strictEqual(yield* Ref.get(count), 1);
      });
      return mode === "persistent"
        ? test.pipe(Effect.provide(makeServerSettingsLayer()))
        : test.pipe(Effect.provide(ServerSettingsModule.layerTest()));
    });
    it.effect(`propagates action failures and releases the lock (${mode})`, () => {
      const test = Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const original = yield* settings.getSettings;
        yield* settings.updateSettings({
          workspaceProgramPermissions: { monitoringAutoActions: true },
        });
        const failure = yield* Effect.result(
          settings.runMonitoringAutoAction(Effect.fail("dispatch failed")),
        );
        assert.strictEqual(failure._tag, "Failure");
        if (failure._tag === "Failure") assert.strictEqual(failure.failure, "dispatch failed");
        const disabled = yield* settings.updateSettings({
          workspaceProgramPermissions: { monitoringAutoActions: false },
        });
        assert.deepEqual(
          disabled.textGenerationModelSelection,
          original.textGenerationModelSelection,
        );
        const { monitoringAutoActions: _before, ...beforePermissions } =
          original.workspaceProgramPermissions;
        const { monitoringAutoActions: _after, ...afterPermissions } =
          disabled.workspaceProgramPermissions;
        assert.deepEqual(afterPermissions, beforePermissions);
      });
      return mode === "persistent"
        ? test.pipe(Effect.provide(makeServerSettingsLayer()))
        : test.pipe(Effect.provide(ServerSettingsModule.layerTest()));
    });
    it.effect(`does not release the permission lock during dispatch cancellation (${mode})`, () => {
      const test = Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        yield* settings.updateSettings({
          workspaceProgramPermissions: { monitoringAutoActions: true },
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const dispatchDone = yield* Deferred.make<void>();
        const updateStarted = yield* Deferred.make<void>();
        const updateDone = yield* Deferred.make<void>();
        const action = yield* settings
          .runMonitoringAutoAction(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* Deferred.succeed(dispatchDone, undefined);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const interruption = yield* Fiber.interrupt(action).pipe(Effect.forkChild);
        const update = yield* Effect.gen(function* () {
          yield* Deferred.succeed(updateStarted, undefined);
          yield* settings.updateSettings({
            workspaceProgramPermissions: { monitoringAutoActions: false },
          });
          yield* Deferred.succeed(updateDone, undefined);
        }).pipe(Effect.forkChild);
        yield* Deferred.await(updateStarted);
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(updateDone));
        assert.isFalse(yield* Deferred.isDone(dispatchDone));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interruption);
        yield* Fiber.join(update);
        assert.isTrue(yield* Deferred.isDone(dispatchDone));
        assert.deepEqual(
          yield* settings.runMonitoringAutoAction(Effect.succeed("never")),
          Option.none(),
        );
      });
      return mode === "persistent"
        ? test.pipe(Effect.provide(makeServerSettingsLayer()))
        : test.pipe(Effect.provide(ServerSettingsModule.layerTest()));
    });
  }
});

it.layer(NodeServices.layer)("thread model team initialization", (it) => {
  const room = ThreadId.make("accepted");
  const other = ThreadId.make("other");
  const account = ProviderInstanceId.make("codex");
  const member = {
    instanceId: ProviderInstanceId.make("worker"),
    model: "a",
    role: "worker" as const,
  };
  const team: ThreadModelTeam = {
    threadId: room,
    answeringInstanceId: account,
    forModel: "main",
    members: [member],
  };
  const second = { ...team, forModel: "second" };
  const disabled = {
    ...team,
    answeringInstanceId: ProviderInstanceId.make("another-account"),
    members: [],
  };
  const otherRoom = { ...team, threadId: other };

  it.effect("persists a room's watch revocation across re-enable and restart", () => {
    const fresh = () =>
      Layer.fresh(ServerSettingsModule.layer.pipe(Layer.provide(ServerSecretStore.layer)));
    return Effect.gen(function* () {
      const cutoff = yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        assert.deepEqual((yield* settings.getSettings).backgroundWatchThreadIds, []);
        for (const threadId of [room, other])
          yield* settings.updateSettings({
            backgroundWatchThreadUpdate: { threadId, enabled: true },
          });
        const off = yield* settings.updateSettings({
          backgroundWatchThreadUpdate: { threadId: room, enabled: false },
        });
        assert.deepEqual(off.backgroundWatchThreadIds, [other]);
        assert.isNumber(off.backgroundWatchRevokedAtMs?.[room]);
        yield* settings.updateSettings({
          backgroundWatchThreadUpdate: { threadId: room, enabled: true },
        });
        return off.backgroundWatchRevokedAtMs?.[room];
      }).pipe(Effect.provide(fresh()));
      yield* Effect.gen(function* () {
        const saved = yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings;
        assert.deepEqual(saved.backgroundWatchThreadIds, [other, room]);
        assert.deepEqual(saved.backgroundWatchRevokedAtMs, { [room]: cutoff });
      }).pipe(Effect.provide(fresh()));
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-watch-restart-" })),
    );
  });

  it.effect(
    "persists one global roster and independent thread choices across restart and draft seed retries",
    () => {
      const fresh = () =>
        Layer.fresh(ServerSettingsModule.layer.pipe(Layer.provide(ServerSecretStore.layer)));
      return Effect.gen(function* () {
        const member = {
          instanceId: ProviderInstanceId.make("exact-account"),
          model: "exact-model",
          role: "advisor" as const,
        };
        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          yield* service.updateSettings({ globalSubordinateTeam: [member] });
          yield* service.updateSettings({
            threadSubordinateTeamUpdate: { threadId: other, members: null },
          });
          yield* service.initializeThreadModelTeams(room, [], undefined, []);
          yield* service.initializeThreadModelTeams(other, [], undefined, [member]);
        }).pipe(Effect.provide(fresh()));
        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const state = yield* service.getSettings;
          assert.deepEqual(state.globalSubordinateTeam, [member]);
          assert.deepEqual(state.threadSubordinateTeams, { [room]: [], [other]: null });
          assert.deepEqual(state.threadModelTeams, []);
          yield* service.initializeThreadModelTeams(room, [], undefined, [member]);
          const cleared = yield* service.updateSettings({ globalSubordinateTeam: [] });
          assert.deepEqual(cleared.globalSubordinateTeam, []);
          assert.deepEqual(cleared.threadSubordinateTeams, state.threadSubordinateTeams);
        }).pipe(Effect.provide(fresh()));
      }).pipe(
        Effect.scoped,
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-global-team-" })),
      );
    },
  );

  it.effect("preserves edits and resets before and after seeding across service restarts", () => {
    const freshService = () =>
      Layer.fresh(ServerSettingsModule.layer.pipe(Layer.provide(ServerSecretStore.layer)));
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      // Simulate a settings file from before initialization receipts existed.
      yield* fs.writeFileString(
        config.settingsPath,
        '{"threadModelTeams":[{"threadId":"accepted","answeringInstanceId":"codex","forModel":"second","members":[]}]}',
      );
      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* service.updateSettings({ threadModelTeamUpdate: { ...team, members: [] } });
        yield* service.updateSettings({
          threadModelTeamUpdate: { ...second, forModel: "SECOND", members: null },
        });
        yield* service.updateSettings({ threadModelTeamUpdate: { ...otherRoom, members: null } });
      }).pipe(Effect.provide(freshService()));
      const untouched = { ...team, forModel: "additional" };
      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* service.subscribeChanges;
        yield* service.initializeThreadModelTeams(room, [team, second, disabled, untouched]);
        const first = yield* service.getSettings;
        assert.deepEqual(first.threadModelTeams, [{ ...team, members: [] }, disabled, untouched]);
        assert.deepEqual(first.threadModelTeamInitialization?.initializedThreads, [room]);
        assert.equal(first.threadModelTeamInitialization?.resetScopes.length, 1);
        assert.deepEqual(
          Option.getOrThrow(yield* changes.pipe(Stream.runHead)).threadModelTeams,
          first.threadModelTeams,
        );
        yield* service.updateSettings({
          threadModelTeamUpdate: { ...disabled, members: [member] },
        });
        yield* service.updateSettings({ threadModelTeamUpdate: { ...untouched, members: null } });
      }).pipe(Effect.provide(freshService()));
      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const before = yield* fs.readFileString(config.settingsPath);
        yield* service.initializeThreadModelTeams(room, [
          team,
          second,
          disabled,
          untouched,
          { ...team, forModel: "late" },
        ]);
        assert.equal(yield* fs.readFileString(config.settingsPath), before);
        yield* service.initializeThreadModelTeams(other, [
          otherRoom,
          { ...untouched, threadId: other },
        ]);
        assert.deepEqual((yield* service.getSettings).threadModelTeams, [
          { ...team, members: [] },
          { ...disabled, members: [member] },
          { ...untouched, threadId: other },
        ]);
      }).pipe(Effect.provide(freshService()));
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-seed-restart-" })),
    );
  });

  for (const mode of ["persistent", "test-layer"] as const) {
    it.effect(`preserves concurrent edits and applies only one seed per room (${mode})`, () => {
      const scenario = Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* Effect.all(
          [
            service.initializeThreadModelTeams(room, [team, second, disabled]),
            service.updateSettings({ threadModelTeamUpdate: { ...team, members: null } }),
            service.updateSettings({ threadModelTeamUpdate: { ...second, members: [] } }),
            service.initializeThreadModelTeams(room, [team, second, disabled]),
            service.initializeThreadModelTeams(other, [otherRoom]),
          ],
          { concurrency: "unbounded" },
        );
        const after = yield* service.getSettings;
        assert.sameDeepMembers(
          [...after.threadModelTeams],
          [{ ...second, members: [] }, disabled, otherRoom],
        );
        assert.sameMembers(
          [...(after.threadModelTeamInitialization?.initializedThreads ?? [])],
          [room, other],
        );
      });
      return mode === "persistent"
        ? scenario.pipe(Effect.provide(makeServerSettingsLayer()))
        : scenario.pipe(Effect.provide(ServerSettingsModule.layerTest()));
    });
  }

  it.effect("applies one complete batch when competing first seeds differ", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* Effect.all(
        [
          service.initializeThreadModelTeams(room, [team, second]),
          service.initializeThreadModelTeams(room, [disabled]),
        ],
        { concurrency: "unbounded" },
      );
      const current = yield* service.getSettings;
      assert.deepEqual(
        current.threadModelTeams,
        current.threadModelTeams.length === 1 ? [disabled] : [team, second],
      );
      assert.deepEqual(current.threadModelTeamInitialization?.initializedThreads, [room]);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "commits all teams and the receipt in one rename, retries a failed write, and leaves stored credentials alone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const initial =
          '{"providerInstances":{"codex":{"driver":"codex","environment":[{"name":"FIXTURE","value":"","sensitive":true,"valueRedacted":true}]}}}';
        yield* fs.writeFileString(config.settingsPath, initial);
        let renames = 0;
        const observedFs = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) => {
            if (to === config.settingsPath && ++renames === 1)
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  description: "injected test failure",
                }),
              );
            return fs.rename(from, to);
          },
        });
        const unexpected = () => Effect.die(new Error("Seeding accessed the secret store"));
        const secrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
          get: unexpected,
          set: unexpected,
          create: unexpected,
          getOrCreateRandom: unexpected,
          remove: unexpected,
        });
        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const seed = service.initializeThreadModelTeams(room, [team, disabled]);
          assert.equal((yield* Effect.flip(seed)).operation, "write-file");
          assert.equal(yield* fs.readFileString(config.settingsPath), initial);
          yield* seed;
          yield* seed;
          assert.equal(renames, 2); // One failed rename, one successful rename, no replay write.
          const saved = yield* decodeSettingsFile(yield* fs.readFileString(config.settingsPath));
          assert.deepEqual(saved.threadModelTeams, [team, disabled]);
          assert.deepEqual(saved.threadModelTeamInitialization, {
            initializedThreads: [room],
            resetScopes: [],
          });
          assert.deepEqual(saved.providerInstances[account]?.environment, [
            { name: "FIXTURE", value: "", sensitive: true, valueRedacted: true },
          ]);
          assert.isUndefined(
            ServerSettingsModule.redactServerSettingsForClient(saved).threadModelTeamInitialization,
          );
        }).pipe(
          Effect.provide(ServerSettingsModule.layer.pipe(Layer.provide(secrets))),
          Effect.provideService(FileSystem.FileSystem, observedFs),
        );
      }).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-seed-atomic-" })),
      ),
  );

  it.effect(
    "rejects a mixed-thread batch without consuming the receipt and records an empty first seed",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const result = yield* service
          .initializeThreadModelTeams(room, [team, otherRoom])
          .pipe(Effect.flip);
        assert.equal(result.operation, "normalize");
        assert.isFalse(yield* fs.exists(config.settingsPath));
        yield* service.initializeThreadModelTeams(room, []);
        yield* service.initializeThreadModelTeams(room, [team]);
        assert.deepEqual((yield* service.getSettings).threadModelTeams, []);
        assert.deepEqual(
          (yield* service.getSettings).threadModelTeamInitialization?.initializedThreads,
          [room],
        );
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("isolates an unreadable provider secret and preserves its reference", () => {
    const platformCause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFile",
      pathOrDescriptor: "provider environment secret",
      description: "Secret backend unavailable.",
    });
    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: "provider environment secret",
      cause: platformCause,
    });
    const configLayer = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-server-settings-secret-failure-test-",
      }),
    );
    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(makeFailingSecretStoreLayer(cause)),
      Layer.provideMerge(configLayer),
    );

    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"OPENROUTER_API_KEY","value":"","sensitive":true,"valueRedacted":true}],"config":{}},"codex_other":{"driver":"codex","environment":[{"name":"TEST_SETTING","value":"still-available","sensitive":false}],"config":{}}}}',
      );

      const loaded = yield* serverSettings.getSettings;
      assert.equal(
        loaded.providerInstances[ProviderInstanceId.make("codex_other")]?.environment?.[0]?.value,
        "still-available",
      );
      assert.equal(
        loaded.providerInstances[ProviderInstanceId.make("codex_personal")]?.environment?.[0]
          ?.value,
        "",
      );
      const updated = yield* serverSettings.updateSettings({});
      assert.isTrue(
        updated.providerInstances[ProviderInstanceId.make("codex_personal")]?.environment?.[0]
          ?.valueRedacted,
      );
      assert.equal(
        updated.providerInstances[ProviderInstanceId.make("codex_other")]?.environment?.[0]?.value,
        "still-available",
      );
    }).pipe(Effect.provide(settingsLayer));
  });

  it.effect("decodes nested settings patches", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* decodeSettingsPatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }),
        {
          providers: { codex: { binaryPath: "/tmp/codex" } },
        },
      );

      assert.deepEqual(
        yield* decodeSettingsPatch({
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        }),
        {
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        },
      );
    }),
  );

  it.effect(
    "decodes legacy object-shaped textGenerationModelSelection.options from settings.json",
    () =>
      Effect.gen(function* () {
        const decoded = yield* decodeServerSettings({
          textGenerationModelSelection: {
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5.4-mini",
            options: { reasoningEffort: "low" },
          },
        });

        assert.deepEqual(decoded.textGenerationModelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
      }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/julius/.codex",
          },
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/julius/.codex",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/usr/local/bin/claude",
        homePath: "",
        customModels: ["claude-custom"],
        launchArgs: "",
      });
      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(
          ProviderInstanceId.make("codex"),
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: false },
          ],
        ),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("buffers changes after a subscription is acquired but before it is consumed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        yield* serverSettings.updateSettings({
          providers: {
            codex: {
              binaryPath: "/usr/local/bin/codex-next",
            },
          },
        });

        const firstChange = yield* changes.pipe(Stream.runHead, Effect.timeout("1 second"));
        assert.equal(
          Option.getOrUndefined(firstChange)?.providers.codex.binaryPath,
          "/usr/local/bin/codex-next",
        );
      }),
    ).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      // Start with Claude text generation selection
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-sonnet-4-6",
            [{ id: "effort", value: "high" }],
          ).options!,
        },
      });

      // Switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "high" },
          ]).options!,
        },
      });

      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
        ]),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves custom provider instance text generation selections", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("claude_openrouter")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude_openrouter"),
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "uses explicit provider instance enabled state over legacy provider enabled state",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("claude_openrouter");

        const next = yield* serverSettings.updateSettings({
          providers: {
            claudeAgent: {
              enabled: false,
            },
          },
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { customModels: ["openai/gpt-5.5"] },
            },
          },
          textGenerationModelSelection: {
            instanceId,
            model: "openai/gpt-5.5",
          },
        });

        assert.deepEqual(next.textGenerationModelSelection, {
          instanceId,
          model: "openai/gpt-5.5",
        });
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves enabled text generation selections for non-built-in drivers", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("openrouter_text");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("openrouter"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId,
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId,
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "preserves the source control writer selection when its provider instance is disabled",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const instanceId = ProviderInstanceId.make("codex_writer");
        const sourceControlWriterModelSelection = {
          instanceId,
          model: "gpt-5.4-mini",
        };

        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
          sourceControlWriterModelSelection,
        });

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
              config: {},
            },
          },
        });

        assert.deepEqual(next.sourceControlWriterModelSelection, sourceControlWriterModelSelection);
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(next),
          next.textGenerationModelSelection,
        );
        assert.deepEqual(
          (yield* serverSettings.getSettings).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.deepEqual(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.parse(raw).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const restored = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
        });
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(restored),
          sourceControlWriterModelSelection,
        );
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("drops stale text generation options when resetting model selection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("replaces provider instance maps when clearing optional fields", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            accentColor: "#7c3aed",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex Work",
        enabled: true,
        config: { homePath: "~/.codex" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
          },
          opencode: {
            binaryPath: "  /opt/homebrew/bin/opencode  ",
            serverUrl: "  http://127.0.0.1:4096  ",
            serverPassword: "  secret-password  ",
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        homePath: "",
        customModels: [],
        launchArgs: "",
      });
      assert.deepEqual(next.providers.opencode, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "secret-password",
        customModels: [],
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "  ~/Development  ",
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      });

      assert.equal(next.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes only non-default server settings to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
        automaticGitFetchInterval: Duration.seconds(10),
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
        backgroundActivity: {
          schemaVersion: 1,
          profile: "custom",
          baseProfile: "balanced",
          overrides: {
            automaticGitFetchInterval: 10_000,
          },
        },
        automaticGitFetchInterval: 10_000,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores sensitive provider instance environment values outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "sk-or-secret",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Personal",
            environment: [
              { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-or-secret",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "forces Claude API credentials into sensitive storage and redacts client responses",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const instanceId = ProviderInstanceId.make("claude_api_test");
        const next = yield* settings.updateSettings({
          providerInstancesToUpsert: {
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { authMode: "api-key" },
              environment: [
                { name: "ANTHROPIC_API_KEY", value: "test-api-secret", sensitive: false },
              ],
            },
          },
        });
        const variable = next.providerInstances[instanceId]?.environment?.[0];
        assert.equal(variable?.sensitive, true);
        assert.equal(variable?.value, "test-api-secret");
        const publicView = ServerSettingsModule.redactServerSettingsForClient(next);
        assert.equal(publicView.providerInstances[instanceId]?.environment?.[0]?.value, "");
        assert.notInclude(
          yield* fileSystem.readFileString(serverConfig.settingsPath),
          "test-api-secret",
        );
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores an OpenAI account key separately and preserves it across redacted edits", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const server = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const before = yield* settings.getSettings;
      const id = ProviderInstanceId.make("openai_api_test");
      const name = "T3_OPENAI_API_KEY";
      const instance = {
        driver: ProviderDriverKind.make("opencode"),
        config: {
          apiConnection: {
            providerId: "t3_openai",
            baseUrl: "https://api.openai.com/v1",
            protocol: "responses",
            models: ["Exact-1"],
          },
        },
        environment: [{ name, value: "synthetic-openai-credential", sensitive: false }],
      };
      const saved = yield* settings.updateSettings({
        providerInstancesToUpsert: { [id]: instance },
      });
      const publicView = ServerSettingsModule.redactServerSettingsForClient(saved);
      const publicAccount = publicView.providerInstances[id]!;
      assert.deepEqual(publicAccount.environment, [
        { name, value: "", sensitive: true, valueRedacted: true },
      ]);
      assert.notInclude(
        yield* fs.readFileString(server.settingsPath),
        "synthetic-openai-credential",
      );
      const edited = yield* settings.updateSettings({
        providerInstancesToUpsert: { [id]: { ...publicAccount, displayName: "Edited" } },
      });
      assert.equal(
        edited.providerInstances[id]?.environment?.[0]?.value,
        "synthetic-openai-credential",
      );
      assert.deepEqual(edited.providers, before.providers);
      assert.deepEqual(edited.textGenerationModelSelection, before.textGenerationModelSelection);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves a legacy Claude key when a redacted settings view is saved", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("claude_api_legacy");
      yield* fs.writeFileString(
        config.settingsPath,
        '{"providerInstances":{"claude_api_legacy":{"driver":"claudeAgent","config":{"authMode":"api-key"},"environment":[{"name":"ANTHROPIC_API_KEY","value":"synthetic-legacy-key","sensitive":false}]}}}',
      );
      const before = yield* settings.getSettings;
      const publicView = ServerSettingsModule.redactServerSettingsForClient(before);
      const updated = yield* settings.updateSettings({
        providerInstances: publicView.providerInstances,
      });
      assert.equal(
        updated.providerInstances[instanceId]?.environment?.[0]?.value,
        "synthetic-legacy-key",
      );
      assert.notInclude(yield* fs.readFileString(config.settingsPath), "synthetic-legacy-key");
      assert.equal(
        (yield* settings.getSettings).providerInstances[instanceId]?.environment?.[0]?.value,
        "synthetic-legacy-key",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("rejects a redacted provider credential that has no stored value", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("claude_api_missing");
      const error = yield* Effect.flip(
        settings.updateSettings({
          providerInstancesToUpsert: {
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { authMode: "api-key" },
              environment: [
                { name: "ANTHROPIC_API_KEY", value: "", sensitive: true, valueRedacted: true },
              ],
            },
          },
        }),
      );
      assert.equal(error.operation, "read-secret");
      assert.isUndefined((yield* settings.getSettings).providerInstances[instanceId]);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("restores earlier provider keys if a later credential write fails", () => {
    const a = ProviderInstanceId.make("claude_api_a");
    const b = ProviderInstanceId.make("claude_api_b");
    const name = "ANTHROPIC_API_KEY";
    const key = (id: string) =>
      `provider-env-${Buffer.from(id).toString("base64url")}-${Buffer.from(name).toString("base64url")}`;
    const encoder = new TextEncoder();
    const stored = new Map([
      [key(a), encoder.encode("synthetic-old-a")],
      [key(b), encoder.encode("synthetic-old-b")],
    ]);
    let failB = true;
    const secretLayer = Layer.succeed(
      ServerSecretStore.ServerSecretStore,
      ServerSecretStore.ServerSecretStore.of({
        get: (id) => Effect.succeed(Option.fromUndefinedOr(stored.get(id))),
        set: (id, value) =>
          Effect.suspend(() => {
            if (id === key(b) && failB) {
              failB = false;
              return Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: "synthetic credential",
                  cause: "injected failure",
                }),
              );
            }
            stored.set(id, Uint8Array.from(value));
            return Effect.void;
          }),
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
        remove: (id) =>
          Effect.sync(() => {
            stored.delete(id);
          }),
      }),
    );
    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(secretLayer),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-settings-rollback-" }),
      ),
    );
    return Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const original =
        '{"providerInstances":{"claude_api_a":{"driver":"claudeAgent","config":{"authMode":"api-key"},"environment":[{"name":"ANTHROPIC_API_KEY","value":"","sensitive":true,"valueRedacted":true}]},"claude_api_b":{"driver":"claudeAgent","config":{"authMode":"api-key"},"environment":[{"name":"ANTHROPIC_API_KEY","value":"","sensitive":true,"valueRedacted":true}]}}}';
      yield* fs.writeFileString(config.settingsPath, original);
      const error = yield* Effect.flip(
        settings.updateSettings({
          providerInstancesToUpsert: {
            [a]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { authMode: "api-key" },
              environment: [{ name, value: "synthetic-new-a", sensitive: true }],
            },
            [b]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { authMode: "api-key" },
              environment: [{ name, value: "synthetic-new-b", sensitive: true }],
            },
          },
        }),
      );
      assert.equal(error.operation, "write-secret");
      assert.equal(new TextDecoder().decode(stored.get(key(a))), "synthetic-old-a");
      assert.equal(new TextDecoder().decode(stored.get(key(b))), "synthetic-old-b");
      assert.equal(yield* fs.readFileString(config.settingsPath), original);
    }).pipe(Effect.provide(settingsLayer));
  });

  it.effect("keeps character selections independent across conversations", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.updateSettings({ threadCharacters: { "thread-a": "pixel" } });
      yield* settings.updateSettings({ threadCharacters: { "thread-b": "vrm" } });
      yield* settings.updateSettings({ threadCharacters: { "thread-c": "agustina" } });
      assert.deepEqual((yield* settings.getSettings).threadCharacters, {
        "thread-a": "pixel",
        "thread-b": "vrm",
        "thread-c": "agustina",
      });
      yield* settings.updateSettings({ threadCharacters: { "thread-a": "off" } });
      assert.deepEqual((yield* settings.getSettings).threadCharacters, {
        "thread-a": "off",
        "thread-b": "vrm",
        "thread-c": "agustina",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists each conversation's assistant profile without replacing the others", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.updateSettings({
        threadAssistantProfiles: { "thread-a": { name: "A", instructions: "research" } },
      });
      yield* settings.updateSettings({
        threadAssistantProfiles: { "thread-b": { name: "B", instructions: "code" } },
      });
      assert.deepEqual((yield* settings.getSettings).threadAssistantProfiles, {
        "thread-a": { name: "A", instructions: "research" },
        "thread-b": { name: "B", instructions: "code" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "preserves global and custom profiles separately through mode switches and old-client edits",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const profile = { name: "A", instructions: "research" };
        yield* settings.updateSettings({
          globalAssistantProfile: profile,
          threadAssistantProfiles: { a: { name: "B", instructions: "code", mode: "global" } },
        });
        yield* settings.updateSettings({
          threadAssistantProfiles: { a: { name: "C", instructions: "review" } },
        });
        const read = yield* settings.getSettings;
        assert.deepEqual(read.threadAssistantProfiles.a, { name: "C", instructions: "review" });
        assert.deepEqual(read.globalAssistantProfile, profile);
        yield* settings.updateSettings({ globalAssistantProfile: null });
        const cleared = yield* settings.getSettings;
        assert.strictEqual(cleared.globalAssistantProfile, null);
        assert.deepEqual(cleared.threadAssistantProfiles, read.threadAssistantProfiles);
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes the conversation computer identity to the settings file for recovery", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const computer = {
        containerId: "a".repeat(64),
        ownerId: "12345678-1234-1234-1234-123456789abc",
        image: "node:24-alpine",
        network: "none" as const,
      };
      yield* settings.updateSettings({ threadAssistantComputers: { "thread-a": computer } });
      const persisted = yield* fs.readFileString(config.settingsPath);
      const decoded = yield* decodeSettingsFile(persisted);
      assert.deepEqual(decoded.threadAssistantComputers["thread-a"], computer);
      yield* settings.updateSettings({ threadAssistantComputers: { "thread-a": null } });
      assert.isNull((yield* settings.getSettings).threadAssistantComputers["thread-a"]);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores HTTP MCP headers outside settings, redacts clients and preserves edits", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const server = {
        name: "apps",
        label: "Apps",
        enabled: true,
        providers: ["codex" as const],
        workspaceRoot: null,
        transport: "http" as const,
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer private-token", "X-Empty": "" },
      };
      const saved = yield* settings.updateSettings({ customMcpServersToUpsert: { apps: server } });
      assert.notInclude(yield* fs.readFileString(config.settingsPath), "private-token");
      const live = saved.customMcpServers.apps;
      assert.strictEqual(live?.transport, "http");
      if (live?.transport !== "http") return;
      assert.strictEqual(live.headers.Authorization, "Bearer private-token");
      const publicSettings = ServerSettingsModule.redactServerSettingsForClient(saved);
      const publicServer = publicSettings.customMcpServers.apps;
      assert.strictEqual(publicServer?.transport, "http");
      if (publicServer?.transport !== "http") return;
      assert.deepEqual(publicServer.headers, { Authorization: "", "X-Empty": "" });
      assert.deepEqual(publicServer.redactedHeaders, ["Authorization"]);

      const toggled = yield* settings.updateSettings({
        customMcpServersToUpsert: { apps: { ...publicServer, enabled: false } },
      });
      const toggledServer = toggled.customMcpServers.apps;
      assert.strictEqual(toggledServer?.transport, "http");
      if (toggledServer?.transport !== "http") return;
      assert.strictEqual(toggledServer.headers.Authorization, "Bearer private-token");

      const { redactedHeaders: _oldClientDoesNotKnowThisField, ...oldClientServer } = publicServer;
      const oldClientUpdate = yield* settings.updateSettings({
        customMcpServersToUpsert: { apps: { ...oldClientServer, enabled: true } },
      });
      const oldClientResult = oldClientUpdate.customMcpServers.apps;
      assert.strictEqual(oldClientResult?.transport, "http");
      if (oldClientResult?.transport !== "http") return;
      assert.strictEqual(oldClientResult.headers.Authorization, "Bearer private-token");

      const changed = yield* settings.updateSettings({
        customMcpServersToUpsert: {
          apps: { ...publicServer, headers: { Authorization: "Bearer replacement" } },
        },
      });
      const changedServer = changed.customMcpServers.apps;
      assert.strictEqual(changedServer?.transport, "http");
      if (changedServer?.transport !== "http") return;
      assert.strictEqual(changedServer.headers.Authorization, "Bearer replacement");
      assert.notInclude(yield* fs.readFileString(config.settingsPath), "Bearer replacement");

      yield* settings.updateSettings({ customMcpServerIdsToRemove: ["apps"] });
      const secretPath = `${config.secretsDir}/mcp-header-YXBwcw-QXV0aG9yaXphdGlvbg.bin`;
      assert.isFalse(yield* fs.exists(secretPath));
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("migrates legacy plaintext MCP headers on a settings update", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        '{"customMcpServers":{"apps":{"name":"apps","label":"Apps","enabled":true,"providers":["codex"],"workspaceRoot":null,"transport":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer legacy"}}}}',
      );
      const initial = yield* settings.getSettings;
      const visible =
        ServerSettingsModule.redactServerSettingsForClient(initial).customMcpServers.apps;
      assert.strictEqual(visible?.transport, "http");
      if (visible?.transport !== "http") return;
      assert.strictEqual(visible.headers.Authorization, "");
      const updated = yield* settings.updateSettings({
        customMcpServersToUpsert: { apps: { ...visible, enabled: false } },
      });
      assert.notInclude(yield* fs.readFileString(config.settingsPath), "Bearer legacy");
      const migrated = updated.customMcpServers.apps;
      assert.strictEqual(migrated?.transport, "http");
      if (migrated?.transport === "http")
        assert.strictEqual(migrated.headers.Authorization, "Bearer legacy");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
