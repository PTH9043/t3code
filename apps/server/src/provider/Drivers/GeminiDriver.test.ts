import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type GeminiSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "../Layers/ProviderInstanceRegistryLive.ts";
import { GeminiDriver } from "./GeminiDriver.ts";

let spawns = 0;
// Any process launch (version probe, ACP model discovery, a session) counts.
const CountingSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => {
    spawns++;
    return Effect.die(new Error("Unexpected provider subprocess"));
  }),
);

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "antigravity-driver-test",
}).pipe(
  Layer.provideMerge(CountingSpawner),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
      ),
    ),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

for (const enabled of [false, true]) {
  it.live(`honors the saved Antigravity account's enabled=${enabled}`, () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("gemini_default");
      const config: GeminiSettings = {
        enabled,
        binaryPath: "agy",
        homePath: "",
        autoOptimizeThoughtLevel: true,
        customModels: [],
      };
      const configMap: ProviderInstanceConfigMap = {
        [instanceId]: { driver: ProviderDriverKind.make("gemini"), enabled, config },
      };
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [GeminiDriver],
        configMap,
      });
      const instance = yield* registry.getInstance(instanceId);
      expect(instance?.enabled).toBe(enabled);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(enabled);
      expect(snapshot.displayName).toBe("Antigravity CLI");
      expect(snapshot.models).toEqual([]);
      if (!enabled) {
        const refreshed = yield* instance!.snapshot.refresh;
        expect(refreshed.status).toBe("disabled");
        expect(spawns).toBe(0);
      }
    }).pipe(Effect.provide(testLayer)),
  );
}
