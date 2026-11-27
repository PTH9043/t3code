import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { isWindowsProtectedCredential } from "./WindowsCredentialProtection.ts";

const makeServerConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const makeServerSecretStoreLayer = () =>
  Layer.provide(ServerSecretStore.layer, makeServerConfigLayer());

const PermissionDeniedFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makePermissionDeniedSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(PermissionDeniedFileSystemLayer),
  );

const RenameFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeRenameFailureSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(RenameFailureFileSystemLayer),
  );

const RemoveFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeRemoveFailureSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(RemoveFailureFileSystemLayer),
  );

const ConcurrentReadMissFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        String(path).endsWith("/session-signing-key.bin")
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeConcurrentCreateSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(ConcurrentReadMissFileSystemLayer),
  );

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("returns Option.none when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(makeConcurrentCreateSecretStoreLayer())),
  );

  it.effect("uses restrictive permissions for the secret directory and files", () =>
    Effect.gen(function* () {
      const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = [];
      const recordingFileSystemLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          return {
            ...fileSystem,
            makeDirectory: () => Effect.void,
            readDirectory: () => Effect.succeed([]),
            writeFile: () => Effect.void,
            rename: () => Effect.void,
            chmod: (path, mode) =>
              Effect.sync(() => {
                chmodCalls.push({ path: String(path), mode });
              }),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      const secretStore = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(makeServerConfigLayer()),
            Layer.provideMerge(recordingFileSystemLayer),
          ),
        ),
      );

      yield* secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3]));

      assert.isTrue(
        chmodCalls.some(
          (call) => call.mode === 0o700 && call.path.replaceAll("\\", "/").endsWith("/secrets"),
        ),
      );
      assert.isAtLeast(chmodCalls.filter((call) => call.mode === 0o600).length, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(makePermissionDeniedSecretStoreLayer())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(makeRenameFailureSecretStoreLayer())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      assert.instanceOf(error, ServerSecretStore.SecretStoreRemoveError);
      assert.include(error.message, "Failed to remove secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(makeRemoveFailureSecretStoreLayer())),
  );

  it.effect("encrypts provider keys and migrates an existing plaintext key on Windows", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-credential-protection-" });
      const secretsDir = path.join(baseDir, "userdata", "secrets");
      yield* fs.makeDirectory(secretsDir, { recursive: true });
      const name = "provider-env-test-key";
      const original = new TextEncoder().encode("synthetic-api-key-한글");
      const secretPath = path.join(secretsDir, `${name}.bin`);
      yield* fs.writeFile(secretPath, original);

      const secrets = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
      const encrypted = yield* fs.readFile(secretPath);
      assert.isTrue(isWindowsProtectedCredential(encrypted));
      assert.notInclude(new TextDecoder().decode(encrypted), "synthetic-api-key");
      assert.deepEqual(
        Array.from(Option.getOrThrow(yield* secrets.get(name))),
        Array.from(original),
      );

      const updated = new TextEncoder().encode("synthetic-updated-key");
      yield* secrets.set(name, updated);
      assert.isTrue(isWindowsProtectedCredential(yield* fs.readFile(secretPath)));
      assert.deepEqual(
        Array.from(Option.getOrThrow(yield* secrets.get(name))),
        Array.from(updated),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an encrypted credential copied under a different name", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-credential-name-" });
      const secrets = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
      yield* secrets.set("provider-env-original", new TextEncoder().encode("synthetic-key"));
      const dir = path.join(baseDir, "userdata", "secrets");
      yield* fs.copyFile(
        path.join(dir, "provider-env-original.bin"),
        path.join(dir, "provider-env-other.bin"),
      );
      const error = yield* Effect.flip(secrets.get("provider-env-other"));
      assert.instanceOf(error, ServerSecretStore.SecretStoreDecodeError);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a modified encrypted credential", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-credential-modified-" });
      const secrets = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
      const name = "provider-env-tampered";
      yield* secrets.set(name, new TextEncoder().encode("synthetic-key"));
      const secretPath = path.join(baseDir, "userdata", "secrets", `${name}.bin`);
      const encrypted = yield* fs.readFile(secretPath);
      encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1] ?? 0) ^ 1;
      yield* fs.writeFile(secretPath, encrypted);
      const error = yield* Effect.flip(secrets.get(name));
      assert.instanceOf(error, ServerSecretStore.SecretStoreDecodeError);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not replace ciphertext when its envelope is damaged", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-credential-header-" });
      const secrets = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
      const name = "provider-env-damaged-header";
      yield* secrets.set(name, new TextEncoder().encode("synthetic-key"));
      const secretPath = path.join(baseDir, "userdata", "secrets", `${name}.bin`);
      const damaged = yield* fs.readFile(secretPath);
      damaged[0] = (damaged[0] ?? 0) ^ 1;
      yield* fs.writeFile(secretPath, damaged);
      const error = yield* Effect.flip(secrets.get(name));
      assert.instanceOf(error, ServerSecretStore.SecretStoreDecodeError);
      assert.deepEqual(Array.from(yield* fs.readFile(secretPath)), Array.from(damaged));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the original key if migration cannot replace its file", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-credential-failed-migration-",
      });
      const dir = path.join(baseDir, "userdata", "secrets");
      yield* fs.makeDirectory(dir, { recursive: true });
      const name = "provider-env-migration-failure";
      const original = new TextEncoder().encode("synthetic-keep-original");
      const secretPath = path.join(dir, `${name}.bin`);
      yield* fs.writeFile(secretPath, original);
      const secrets = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
            Layer.provideMerge(RenameFailureFileSystemLayer),
          ),
        ),
      );
      const failure = yield* Effect.flip(secrets.get(name));
      assert.instanceOf(failure, ServerSecretStore.SecretStorePersistError);
      assert.deepEqual(Array.from(yield* fs.readFile(secretPath)), Array.from(original));
      assert.deepEqual(yield* fs.readDirectory(dir), [`${name}.bin`]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not overwrite a credential changed during migration", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-credential-race-" });
      const dir = path.join(baseDir, "userdata", "secrets");
      yield* fs.makeDirectory(dir, { recursive: true });
      const name = "provider-env-migration-race";
      const secretPath = path.join(dir, `${name}.bin`);
      const replacement = new TextEncoder().encode("synthetic-replacement-key");
      yield* fs.writeFile(secretPath, new TextEncoder().encode("synthetic-old-key"));
      const competingWrite = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const underlying = yield* FileSystem.FileSystem;
          return {
            ...underlying,
            writeFile: (target, data, options) =>
              underlying
                .writeFile(target, data, options)
                .pipe(
                  Effect.flatMap(() =>
                    String(target).endsWith(".tmp")
                      ? underlying.writeFile(secretPath, replacement)
                      : Effect.void,
                  ),
                ),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
            Layer.provideMerge(competingWrite),
          ),
        ),
      );
      assert.deepEqual(Array.from(yield* fs.readFile(secretPath)), Array.from(replacement));
      assert.deepEqual(yield* fs.readDirectory(dir), [`${name}.bin`]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
