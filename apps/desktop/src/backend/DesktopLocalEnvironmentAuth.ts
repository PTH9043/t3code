import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";

// Direct IPC is installed before the backend pool is available; it reads the
// selected identity only from this main-process value, never from the renderer.
let selectedGoogleBearerToken: string | undefined;
export const getSelectedGoogleBearerToken = (): string | undefined => selectedGoogleBearerToken;
export const selectRestoredGoogleBearerToken = (token: string | undefined): void => {
  selectedGoogleBearerToken = token;
};

export class DesktopLocalEnvironmentAuthBackendNotConfiguredError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthBackendNotConfiguredError>()(
  "DesktopLocalEnvironmentAuthBackendNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  "DesktopLocalEnvironmentAuthSessionBootstrapError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create the local desktop bearer session.";
  }
}
export class DesktopLocalEnvironmentAuthPersistenceError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthPersistenceError>()(
  "DesktopLocalEnvironmentAuthPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Google 로그인 보안 저장소를 사용할 수 없습니다.";
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotConfiguredError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
  DesktopLocalEnvironmentAuthPersistenceError,
]);
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type;

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: Effect.Effect<string, DesktopLocalEnvironmentAuthError>;
    readonly setGoogleBearerToken: (
      token: string,
    ) => Effect.Effect<void, DesktopLocalEnvironmentAuthPersistenceError>;
    readonly clearGoogleBearerToken: Effect.Effect<
      void,
      DesktopLocalEnvironmentAuthPersistenceError
    >;
  }
>()("@t3tools/desktop/backend/DesktopLocalEnvironmentAuth") {}

export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const httpClient = yield* HttpClient.HttpClient;
  const saved = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
  const tokenRef = yield* Ref.make(Option.none<string>());
  const mutex = yield* Semaphore.make(1);

  const getBearerToken = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        if (selectedGoogleBearerToken) return selectedGoogleBearerToken;
        const cached = yield* Ref.get(tokenRef);
        if (Option.isSome(cached)) {
          return cached.value;
        }

        const instances = yield* pool.list;
        const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
        const configOption = primary === undefined ? Option.none() : yield* primary.currentConfig;
        if (Option.isNone(configOption)) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const config = configOption.value;
        const credential = config.bootstrap.desktopBootstrapToken;
        if (!credential) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const session = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: config.httpBaseUrl.href,
          credential,
          clientMetadata: {
            label: "T3 Code Desktop",
            deviceType: "desktop",
          },
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          // Retry while the typed transport cause is still available; Electron
          // only forwards the error message to the renderer over IPC.
          Effect.retry({
            while: (cause) => {
              switch (cause._tag) {
                case "RemoteEnvironmentAuthFetchError":
                  return (
                    HttpClientError.isHttpClientError(cause.cause) &&
                    cause.cause.reason._tag === "TransportError"
                  );
                case "RemoteEnvironmentAuthTimeoutError":
                  return true;
                case "RemoteEnvironmentAuthUndeclaredStatusError":
                  return cause.status === 502 || cause.status === 503 || cause.status === 504;
                default:
                  return false;
              }
            },
            schedule: Schedule.spaced("500 millis").pipe(
              Schedule.upTo({ duration: "15 seconds", times: 30 }),
            ),
          }),
          Effect.mapError(
            (cause) =>
              new DesktopLocalEnvironmentAuthSessionBootstrapError({
                cause,
              }),
          ),
        );
        yield* Ref.set(tokenRef, Option.some(session.access_token));
        return session.access_token;
      }),
    )
    .pipe(Effect.withSpan("desktop.localEnvironmentAuth.getBearerToken"));

  return DesktopLocalEnvironmentAuth.of({
    getBearerToken,
    setGoogleBearerToken: (token) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const stored = yield* saved
            .setPrimaryGoogleSecret(token)
            .pipe(
              Effect.mapError(
                (cause) => new DesktopLocalEnvironmentAuthPersistenceError({ cause }),
              ),
            );
          if (!stored)
            return yield* new DesktopLocalEnvironmentAuthPersistenceError({
              cause: "encryption unavailable",
            });
          selectRestoredGoogleBearerToken(token);
        }),
      ),
    clearGoogleBearerToken: mutex.withPermits(1)(
      saved.removePrimaryGoogleSecret.pipe(
        Effect.mapError((cause) => new DesktopLocalEnvironmentAuthPersistenceError({ cause })),
        Effect.andThen(Effect.sync(() => selectRestoredGoogleBearerToken(undefined))),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
