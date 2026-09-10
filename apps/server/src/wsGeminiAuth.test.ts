import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderInstance } from "./provider/ProviderDriver.ts";
import type { ProviderInstanceRegistryShape } from "./provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderRegistryShape } from "./provider/Services/ProviderRegistry.ts";
import { refreshGeminiProviderAfterAuth } from "./ws.ts";

const GEMINI_DRIVER = ProviderDriverKind.make("gemini");
const GEMINI_INSTANCE_ID = ProviderInstanceId.make("gemini_work");

function makeGeminiInstance(stopAll: ProviderInstance["adapter"]["stopAll"]): ProviderInstance {
  return {
    instanceId: GEMINI_INSTANCE_ID,
    driverKind: GEMINI_DRIVER,
    continuationIdentity: {
      driverKind: GEMINI_DRIVER,
      continuationKey: "gemini:home:test",
    },
    displayName: "Gemini Work",
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter: { stopAll } as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
}

function makeInstanceRegistry(
  instance: ProviderInstance,
): Pick<ProviderInstanceRegistryShape, "getInstance"> {
  return {
    getInstance: () => Effect.succeed(instance),
  };
}

describe("Gemini auth provider refresh", () => {
  it.effect("stops existing Gemini sessions before refreshing the provider snapshot", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const instance = makeGeminiInstance(() =>
        Effect.sync(() => {
          calls.push("stopAll");
        }),
      );
      const providerRegistry: Pick<ProviderRegistryShape, "refreshInstance"> = {
        refreshInstance: () =>
          Effect.sync(() => {
            calls.push("refreshInstance");
            return [];
          }),
      };

      yield* refreshGeminiProviderAfterAuth(
        GEMINI_INSTANCE_ID,
        makeInstanceRegistry(instance),
        providerRegistry,
      );

      expect(calls).toEqual(["stopAll", "refreshInstance"]);
    }),
  );

  it.effect("still refreshes the provider when stopping an old session fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const instance = makeGeminiInstance(() =>
        Effect.sync(() => {
          calls.push("stopAll");
        }).pipe(Effect.andThen(Effect.die("simulated stop failure"))),
      );
      const providerRegistry: Pick<ProviderRegistryShape, "refreshInstance"> = {
        refreshInstance: () =>
          Effect.sync(() => {
            calls.push("refreshInstance");
            return [];
          }),
      };

      yield* refreshGeminiProviderAfterAuth(
        GEMINI_INSTANCE_ID,
        makeInstanceRegistry(instance),
        providerRegistry,
      );

      expect(calls).toEqual(["stopAll", "refreshInstance"]);
    }),
  );
});
