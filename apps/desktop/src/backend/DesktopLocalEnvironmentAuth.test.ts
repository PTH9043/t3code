import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";

const config = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "desktop-bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

const bearerSession = {
  access_token: "desktop-bearer-token",
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "orchestration:read",
};

const sessionResponse = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClientResponse.fromWeb(request, Response.json(bearerSession));

const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
  list: Effect.succeed([
    {
      id: PRIMARY_LOCAL_ENVIRONMENT_ID,
      label: Effect.succeed("Windows"),
      currentConfig: Effect.succeed(Option.some(config)),
    },
  ]),
} as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);

const makeTestLayer = (httpClient: HttpClient.HttpClient) =>
  DesktopLocalEnvironmentAuth.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        poolLayer,
        DesktopSavedEnvironments.layerTest(),
        Layer.succeed(HttpClient.HttpClient, httpClient),
      ),
    ),
  );

const transportFailure = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      cause: new Error("read ECONNRESET"),
    }),
  });

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("uses the Google session after sign-in and restores the paired session on unlink", () =>
    Effect.gen(function* () {
      const testLayer = makeTestLayer(
        HttpClient.make((request) => Effect.succeed(sessionResponse(request))),
      );
      yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        assert.strictEqual(yield* auth.getBearerToken, "desktop-bearer-token");
        yield* auth.setGoogleBearerToken("google-bearer-token");
        assert.strictEqual(yield* auth.getBearerToken, "google-bearer-token");
        assert.strictEqual(
          DesktopLocalEnvironmentAuth.getSelectedGoogleBearerToken(),
          "google-bearer-token",
        );
        yield* auth.clearGoogleBearerToken;
        assert.strictEqual(yield* auth.getBearerToken, "desktop-bearer-token");
        assert.isUndefined(DesktopLocalEnvironmentAuth.getSelectedGoogleBearerToken());
      }).pipe(Effect.provide(testLayer));
    }),
  );
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const testLayer = makeTestLayer(
        HttpClient.make((request) =>
          Ref.update(requestCount, (count) => count + 1).pipe(Effect.as(sessionResponse(request))),
        ),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken], {
          concurrency: "unbounded",
        });
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );

  for (const failure of ["transport", 502, 503, 504] as const) {
    it.effect(`recovers from a transient ${failure} failure before returning over IPC`, () =>
      Effect.gen(function* () {
        const requestCount = yield* Ref.make(0);
        const testLayer = makeTestLayer(
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(requestCount, (count) => count + 1);
              if (attempt <= 2) {
                return failure === "transport"
                  ? yield* transportFailure(request)
                  : HttpClientResponse.fromWeb(request, new Response(null, { status: failure }));
              }
              return sessionResponse(request);
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
          const pending = yield* Effect.all([auth.getBearerToken, auth.getBearerToken], {
            concurrency: "unbounded",
          }).pipe(Effect.forkChild);
          yield* TestClock.adjust(1_000);
          assert.deepEqual(yield* Fiber.join(pending), [
            "desktop-bearer-token",
            "desktop-bearer-token",
          ]);
          assert.strictEqual(yield* auth.getBearerToken, "desktop-bearer-token");
          assert.strictEqual(yield* Ref.get(requestCount), 3);
        }).pipe(Effect.provide(testLayer));
      }),
    );
  }

  it.effect("recovers when the first token request times out", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const testLayer = makeTestLayer(
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const attempt = yield* Ref.updateAndGet(requestCount, (count) => count + 1);
            return attempt === 1 ? yield* Effect.never : sessionResponse(request);
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        const pending = yield* auth.getBearerToken.pipe(Effect.forkChild);
        yield* TestClock.adjust(10_500);
        assert.strictEqual(yield* Fiber.join(pending), "desktop-bearer-token");
        assert.strictEqual(yield* Ref.get(requestCount), 2);
      }).pipe(Effect.provide(testLayer));
    }),
  );

  for (const failure of [
    {
      name: "rejected credential",
      status: 401,
      body: {
        _tag: "EnvironmentAuthInvalidError",
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-desktop-auth",
      },
      tag: "EnvironmentAuthInvalidError",
    },
    {
      name: "server error",
      status: 500,
      body: {
        _tag: "EnvironmentInternalError",
        code: "internal_error",
        reason: "access_token_issuance_failed",
        traceId: "trace-desktop-auth",
      },
      tag: "EnvironmentInternalError",
    },
    {
      name: "invalid token response",
      status: 200,
      body: { access_token: "incomplete-token" },
      tag: "RemoteEnvironmentAuthInvalidJsonError",
    },
  ]) {
    it.effect(`does not retry a ${failure.name}`, () =>
      Effect.gen(function* () {
        const requestCount = yield* Ref.make(0);
        const testLayer = makeTestLayer(
          HttpClient.make((request) =>
            Ref.update(requestCount, (count) => count + 1).pipe(
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(failure.body, { status: failure.status }),
                ),
              ),
            ),
          ),
        );

        const error = yield* Effect.gen(function* () {
          const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
          return yield* auth.getBearerToken.pipe(Effect.flip);
        }).pipe(Effect.provide(testLayer));

        assert.instanceOf(
          error,
          DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuthSessionBootstrapError,
        );
        assert.propertyVal(error.cause, "_tag", failure.tag);
        assert.strictEqual(yield* Ref.get(requestCount), 1);
      }),
    );
  }

  it.effect("bounds persistent transport retries and lets a later request recover", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const recovered = yield* Ref.make(false);
      const testLayer = makeTestLayer(
        HttpClient.make((request) =>
          Effect.gen(function* () {
            yield* Ref.update(requestCount, (count) => count + 1);
            if (!(yield* Ref.get(recovered))) {
              return yield* transportFailure(request);
            }
            return sessionResponse(request);
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        const pending = yield* auth.getBearerToken.pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust(16_000);
        const error = yield* Fiber.join(pending);
        assert.instanceOf(
          error,
          DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuthSessionBootstrapError,
        );
        assert.propertyVal(error.cause, "_tag", "RemoteEnvironmentAuthFetchError");
        const attempts = yield* Ref.get(requestCount);
        assert.isAbove(attempts, 1);
        assert.isAtMost(attempts, 31);

        yield* Ref.set(recovered, true);
        assert.strictEqual(yield* auth.getBearerToken, "desktop-bearer-token");
        assert.strictEqual(yield* auth.getBearerToken, "desktop-bearer-token");
        assert.strictEqual(yield* Ref.get(requestCount), attempts + 1);
      }).pipe(Effect.provide(testLayer));
    }),
  );
});
