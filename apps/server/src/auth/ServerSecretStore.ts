import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import {
  isProtectedCredentialName,
  isPlausibleLegacyCredential,
  isWindowsProtectedCredential,
  protectWindowsCredential,
  unprotectWindowsCredential,
} from "./WindowsCredentialProtection.ts";

const secretStoreErrorContext = {
  resource: Schema.String,
  cause: Schema.Defect(),
};

export class SecretStoreSecureError extends Schema.TaggedErrorClass<SecretStoreSecureError>()(
  "SecretStoreSecureError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to secure ${this.resource}.`;
  }
}

export class SecretStoreReadError extends Schema.TaggedErrorClass<SecretStoreReadError>()(
  "SecretStoreReadError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource}.`;
  }
}

export class SecretStoreTemporaryPathError extends Schema.TaggedErrorClass<SecretStoreTemporaryPathError>()(
  "SecretStoreTemporaryPathError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to create temporary path for ${this.resource}.`;
  }
}

export class SecretStorePersistError extends Schema.TaggedErrorClass<SecretStorePersistError>()(
  "SecretStorePersistError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to persist ${this.resource}.`;
  }
}

export class SecretStoreRandomGenerationError extends Schema.TaggedErrorClass<SecretStoreRandomGenerationError>()(
  "SecretStoreRandomGenerationError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to generate random bytes for ${this.resource}.`;
  }
}

export class SecretStoreConcurrentReadError extends Schema.TaggedErrorClass<SecretStoreConcurrentReadError>()(
  "SecretStoreConcurrentReadError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource} after concurrent creation.`;
  }
}

export class SecretStoreRemoveError extends Schema.TaggedErrorClass<SecretStoreRemoveError>()(
  "SecretStoreRemoveError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to remove ${this.resource}.`;
  }
}

export class SecretStoreDecodeError extends Schema.TaggedErrorClass<SecretStoreDecodeError>()(
  "SecretStoreDecodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource}.`;
  }
}

export class SecretStoreEncodeError extends Schema.TaggedErrorClass<SecretStoreEncodeError>()(
  "SecretStoreEncodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to encode ${this.resource}.`;
  }
}

export const SecretStoreError = Schema.Union([
  SecretStoreSecureError,
  SecretStoreReadError,
  SecretStoreTemporaryPathError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  SecretStoreConcurrentReadError,
  SecretStoreRemoveError,
  SecretStoreDecodeError,
  SecretStoreEncodeError,
]);
export type SecretStoreError = typeof SecretStoreError.Type;
export const isSecretStoreError = Schema.is(SecretStoreError);

const isPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  Predicate.isTagged(value, "PlatformError");

export const isSecretAlreadyExistsError = (error: SecretStoreError): boolean =>
  "cause" in error && isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists";

export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly create: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<Uint8Array, SecretStoreError>;
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcessPlatform;
  const credentialLock = yield* Semaphore.make(1);
  // Process-lifetime in-memory cache of decrypted secret bytes keyed by file stat fingerprint
  // (`size:mtimeMs`). Eliminates repeated disk reads + Windows DPAPI unprotect calls (~230ms each)
  // on hot paths like `AssetAccess.issueAssetUrl` / `resolveAsset` while still detecting external
  // on-disk modification or corruption immediately.
  const secretCache = new Map<string, { readonly bytes: Uint8Array; readonly statKey: string }>();

  const statKeyForSecret = (name: string) =>
    fileSystem.stat(resolveSecretPath(name)).pipe(
      Effect.map((info) => {
        const mtimeMs = Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0;
        return `${String(info.size)}:${mtimeMs}`;
      }),
      Effect.catch(() => Effect.succeed(null as string | null)),
    );

  const writeCachedSecret = (name: string, value: Uint8Array, statKey: string | null): void => {
    if (statKey === null) {
      secretCache.delete(name);
      return;
    }
    secretCache.set(name, { bytes: Uint8Array.from(value), statKey });
  };

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreSecureError({
          resource: `secrets directory ${serverConfig.secretsDir}`,
          cause,
        }),
    ),
  );

  const resolveSecretPath = (name: string) => path.join(serverConfig.secretsDir, `${name}.bin`);

  const encodeSecret = (name: string, value: Uint8Array) =>
    Effect.try({
      try: () =>
        platform === "win32" && isProtectedCredentialName(name)
          ? protectWindowsCredential(name, value)
          : value,
      catch: (cause) => new SecretStoreEncodeError({ resource: `secret ${name}`, cause }),
    });

  const getUnlocked: ServerSecretStore["Service"]["get"] = (name) =>
    Effect.gen(function* () {
      const currentStatKey = yield* statKeyForSecret(name);
      const cached = secretCache.get(name);
      if (cached !== undefined && currentStatKey !== null && cached.statKey === currentStatKey) {
        return Option.some(Uint8Array.from(cached.bytes));
      }
      if (cached !== undefined && (currentStatKey === null || cached.statKey !== currentStatKey)) {
        secretCache.delete(name);
      }

      const maybeBytes = yield* fileSystem.readFile(resolveSecretPath(name)).pipe(
        Effect.map((bytes): Option.Option<Uint8Array> => Option.some(Uint8Array.from(bytes))),
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none())
            : Effect.fail(
                new SecretStoreReadError({
                  resource: `secret ${name}`,
                  cause,
                }),
              ),
        ),
      );
      if (Option.isNone(maybeBytes)) return Option.none();
      const bytes = maybeBytes.value;
      if (!isProtectedCredentialName(name)) {
        writeCachedSecret(name, bytes, currentStatKey);
        return Option.some(Uint8Array.from(bytes));
      }
      if (isWindowsProtectedCredential(bytes)) {
        const unprotected = yield* Effect.try({
          try: () => unprotectWindowsCredential(name, bytes),
          catch: (cause) => new SecretStoreDecodeError({ resource: `secret ${name}`, cause }),
        });
        writeCachedSecret(name, unprotected, currentStatKey);
        return Option.some(Uint8Array.from(unprotected));
      }
      if (!isPlausibleLegacyCredential(bytes)) {
        return yield* new SecretStoreDecodeError({
          resource: `secret ${name}`,
          cause: "Credential format is not recognizable.",
        });
      }
      if (platform !== "win32") {
        writeCachedSecret(name, bytes, currentStatKey);
        return Option.some(Uint8Array.from(bytes));
      }
      yield* setUnlocked(name, bytes, bytes);
      return Option.some(Uint8Array.from(bytes));
    }).pipe(Effect.withSpan("ServerSecretStore.get"));

  const setUnlocked = (name: string, value: Uint8Array, expected?: Uint8Array) => {
    const secretPath = resolveSecretPath(name);
    return encodeSecret(name, value).pipe(
      Effect.flatMap((storedValue) =>
        crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new SecretStoreTemporaryPathError({
                resource: `secret ${name}`,
                cause,
              }),
          ),
          Effect.flatMap((uuid) => {
            const tempPath = `${secretPath}.${uuid}.tmp`;
            return Effect.gen(function* () {
              yield* fileSystem.writeFile(tempPath, storedValue);
              yield* fileSystem.chmod(tempPath, 0o600);
              if (platform === "win32" && isProtectedCredentialName(name)) {
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const file = yield* fileSystem.open(tempPath, { flag: "r+" });
                    yield* file.sync;
                  }),
                );
                const written = yield* fileSystem.readFile(tempPath);
                if (
                  written.length !== storedValue.length ||
                  !written.every((byte, index) => byte === storedValue[index])
                ) {
                  return yield* new SecretStorePersistError({
                    resource: `secret ${name}`,
                    cause: "Credential file verification failed.",
                  });
                }
              }
              if (expected) {
                const current = yield* fileSystem.readFile(secretPath);
                if (
                  current.length !== expected.length ||
                  !current.every((byte, index) => byte === expected[index])
                ) {
                  return yield* new SecretStorePersistError({
                    resource: `secret ${name}`,
                    cause: "Credential changed during migration.",
                  });
                }
              }
              yield* fileSystem.rename(tempPath, secretPath);
              yield* fileSystem.chmod(secretPath, 0o600);
              const nextStatKey = yield* statKeyForSecret(name);
              writeCachedSecret(name, value, nextStatKey);
            }).pipe(
              Effect.catch((cause) =>
                fileSystem.remove(tempPath).pipe(
                  Effect.ignore,
                  Effect.flatMap(() =>
                    Effect.fail(
                      new SecretStorePersistError({
                        resource: `secret ${name}`,
                        cause,
                      }),
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
      ),
      Effect.withSpan("ServerSecretStore.set"),
    );
  };

  const withCredentialLock = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
    isProtectedCredentialName(name) ? credentialLock.withPermits(1)(effect) : effect;

  const get: ServerSecretStore["Service"]["get"] = (name) =>
    withCredentialLock(name, getUnlocked(name));
  const set: ServerSecretStore["Service"]["set"] = (name, value) =>
    withCredentialLock(name, setUnlocked(name, value));

  const createUnlocked: ServerSecretStore["Service"]["create"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    return Effect.scoped(
      Effect.gen(function* () {
        const storedValue = yield* encodeSecret(name, value);
        const file = yield* fileSystem.open(secretPath, {
          flag: "wx",
          mode: 0o600,
        });
        yield* file.writeAll(storedValue);
        yield* file.sync;
        yield* fileSystem.chmod(secretPath, 0o600);
        const nextStatKey = yield* statKeyForSecret(name);
        writeCachedSecret(name, value, nextStatKey);
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStorePersistError({
            resource: `secret ${name}`,
            cause,
          }),
      ),
    );
  };
  const create: ServerSecretStore["Service"]["create"] = (name, value) =>
    withCredentialLock(name, createUnlocked(name, value));

  const getOrCreateRandom: ServerSecretStore["Service"]["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            crypto.randomBytes(bytes).pipe(
              Effect.mapError(
                (cause) =>
                  new SecretStoreRandomGenerationError({
                    resource: `secret ${name}`,
                    cause,
                  }),
              ),
              Effect.flatMap((generated) =>
                create(name, generated).pipe(
                  Effect.as(Uint8Array.from(generated)),
                  Effect.catchIf(isSecretStoreError, (error) =>
                    isSecretAlreadyExistsError(error)
                      ? get(name).pipe(
                          Effect.flatMap(
                            Option.match({
                              onSome: Effect.succeed,
                              onNone: () =>
                                Effect.fail(
                                  new SecretStoreConcurrentReadError({
                                    resource: `secret ${name}`,
                                  }),
                                ),
                            }),
                          ),
                        )
                      : Effect.fail(error),
                  ),
                ),
              ),
            ),
        }),
      ),
      Effect.withSpan("ServerSecretStore.getOrCreateRandom"),
    );

  const removeUnlocked: ServerSecretStore["Service"]["remove"] = (name) =>
    fileSystem.remove(resolveSecretPath(name)).pipe(
      Effect.tap(() => Effect.sync(() => secretCache.delete(name))),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.sync(() => {
              secretCache.delete(name);
            })
          : Effect.fail(
              new SecretStoreRemoveError({
                resource: `secret ${name}`,
                cause,
              }),
            ),
      ),
      Effect.withSpan("ServerSecretStore.remove"),
    );
  const remove: ServerSecretStore["Service"]["remove"] = (name) =>
    withCredentialLock(name, removeUnlocked(name));

  if (platform === "win32") {
    const filenames = yield* fileSystem
      .readDirectory(serverConfig.secretsDir)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Could not list credentials for protection: ${error._tag}.`).pipe(
            Effect.as([] as Array<string>),
          ),
        ),
      );
    for (const filename of filenames) {
      if (!filename.endsWith(".bin")) continue;
      const name = filename.slice(0, -4);
      if (isProtectedCredentialName(name)) {
        yield* get(name).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Could not protect credential ${name}: ${error._tag}.`),
          ),
        );
      }
    }
  }

  return ServerSecretStore.of({
    get,
    set,
    create,
    getOrCreateRandom,
    remove,
  });
});

export const layer = Layer.effect(ServerSecretStore, make);
