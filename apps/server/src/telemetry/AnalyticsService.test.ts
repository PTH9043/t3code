import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

it.layer(NodeServices.layer)("AnalyticsService (hard-disabled)", (it) => {
  it.effect(
    "sends zero HTTP requests and creates no anonymous-id even when all telemetry env vars are set",
    () =>
      Effect.gen(function* () {
        let requestCount = 0;
        const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-telemetry-hard-disabled-",
        });
        const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
        const configLayer = ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            T3CODE_TELEMETRY_ENABLED: true,
            T3CODE_POSTHOG_KEY: "phc_test_key",
            T3CODE_POSTHOG_HOST: "https://ingest.t3.codes",
            T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
          }),
        );
        const batchServerLayer = HttpServer.serve(
          Effect.sync(() => {
            requestCount += 1;
            return HttpServerResponse.jsonUnsafe({});
          }),
        );
        const runtimeLayer = telemetryLayer.pipe(
          Layer.provide(configLayer),
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        yield* Effect.gen(function* () {
          yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
          const config = yield* ServerConfig.ServerConfig;
          const fileSystem = yield* FileSystem.FileSystem;
          const telemetryIdentifier = yield* getTelemetryIdentifier;
          assert.isNull(telemetryIdentifier);

          const analytics = yield* AnalyticsService.AnalyticsService;
          for (let index = 0; index < 45; index += 1) {
            yield* analytics.record("test.blocked.event", {
              index,
              model: "private-internal-model",
              runtimeMode: "full-access",
            });
          }
          yield* analytics.flush;
          assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
        }).pipe(Effect.provide(runtimeLayer));

        assert.equal(requestCount, 0);
      }),
  );

  it.effect("never invokes HttpClient when PostHog host points to a mock endpoint", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-mock-http-",
      });
      const mockHttpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requestCount += 1;
            return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }));
          }),
        ),
      );
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const runtimeLayer = AnalyticsService.layer.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provide(mockHttpClientLayer),
        Layer.provide(configLayer),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("server.boot.heartbeat", { threadCount: 1, projectCount: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(requestCount, 0);
    }),
  );

  it("retains computeAnalyticsBackoffMs helper bounds for export compatibility", () => {
    assert.equal(AnalyticsService.computeAnalyticsBackoffMs(0), 0);
    assert.equal(AnalyticsService.computeAnalyticsBackoffMs(1), 30_000);
    assert.equal(AnalyticsService.computeAnalyticsBackoffMs(2), 60_000);
    assert.equal(AnalyticsService.computeAnalyticsBackoffMs(6), 600_000);
    assert.equal(AnalyticsService.computeAnalyticsBackoffMs(12), 600_000);
  });
});
