import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthAdministrativeScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import { makeServerLayer } from "./server.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { WorkerEngineService } from "./t3x/workerEngine/WorkerEngineService.ts";
import { AnalyticsService } from "./telemetry/AnalyticsService.ts";

it.live(
  "builds the full production makeServerLayer without missing Effect services and serves environment readiness",
  () =>
    Effect.gen(function* () {
      const testConfigLayer = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.map(ServerConfig.ServerConfig, (baseConfig) =>
          ServerConfig.ServerConfig.of({
            ...baseConfig,
            host: "127.0.0.1",
            port: 0,
            noBrowser: true,
            startupPresentation: "headless",
          }),
        ),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-layer-wiring-" })));

      const context = yield* Layer.build(makeServerLayer.pipe(Layer.provide(testConfigLayer)));

      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup.pipe(
        Effect.provide(context),
      );
      yield* startup.awaitCommandReady.pipe(Effect.timeout("15 seconds"));

      const httpServer = yield* HttpServer.HttpServer.pipe(Effect.provide(context));
      const address = httpServer.address;
      expect(typeof address === "object" && "port" in address).toBe(true);
      const port = typeof address === "object" && "port" in address ? address.port : 0;
      expect(port).toBeGreaterThan(0);

      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`),
      );
      expect(response.status).toBe(200);

      const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(context));
      const rows = yield* sql<{ readonly maxId: number }>`
        SELECT MAX(migration_id) AS maxId FROM effect_sql_migrations
      `;
      expect(Number(rows[0]?.maxId ?? 0)).toBeGreaterThanOrEqual(109);

      const analytics = yield* AnalyticsService.pipe(Effect.provide(context));
      expect(analytics).toBeDefined();

      const workerEngine = yield* WorkerEngineService.pipe(Effect.provide(context));
      expect(workerEngine).toBeDefined();

      // Unauthenticated worker-engine status request must be rejected with 401.
      const unauthWorkerRes = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/worker-engine/status`),
      );
      expect(unauthWorkerRes.status).toBe(401);

      // Authenticated Bearer session request must succeed with 200 and JSON envelope.
      const envAuth = yield* EnvironmentAuth.EnvironmentAuth.pipe(Effect.provide(context));
      const issued = yield* envAuth.issueSession({
        scopes: AuthAdministrativeScopes,
        label: "layer-wiring-test",
      });
      const authWorkerRes = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/worker-engine/status`, {
          headers: { authorization: `Bearer ${issued.token}` },
        }),
      );
      expect(authWorkerRes.status).toBe(200);
      const workerJson = (yield* Effect.promise(() => authWorkerRes.json())) as {
        ok: boolean;
        result: { tasks: unknown[]; activeDispatches: unknown[]; unreadMailboxCount: number };
      };
      expect(workerJson.ok).toBe(true);
      expect(Array.isArray(workerJson.result.tasks)).toBe(true);
      expect(Array.isArray(workerJson.result.activeDispatches)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);
