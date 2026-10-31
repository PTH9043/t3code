import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerSettingsService, layerTest } from "../serverSettings.ts";
import {
  connectAntseedAccount,
  verifyAntseedApiKey,
  type AntseedRequest,
} from "./AntseedConnection.ts";

const input = {
  instanceId: ProviderInstanceId.make("antseed_test"),
  displayName: "Antseed",
  baseUrl: "http://127.0.0.1:8379",
  apiKey: "antseed_test-secret",
};
const existingId = ProviderInstanceId.make("codex_personal");
const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("Antseed account connection", () => {
  it.effect(
    "checks the gateway model endpoint and stores discovered models without removing other accounts",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const request: AntseedRequest = async (url, options) => {
          expect(url).toBe("http://127.0.0.1:8379/v1/models");
          expect(options?.headers).toEqual({ Authorization: "Bearer antseed_test-secret" });
          expect(options?.redirect).toBe("error");
          return Response.json({
            data: [
              { id: "deepseek-v4-flash" },
              { id: "gemma-4-26b-free" },
              { id: "deepseek-v4-flash" },
            ],
          });
        };
        const result = yield* connectAntseedAccount(input, request).pipe(
          Effect.provideService(ServerSettingsService, service),
        );
        expect(result.models).toEqual(["deepseek-v4-flash", "gemma-4-26b-free"]);
        const settings = yield* service.getSettings;
        expect(settings.providerInstances[existingId]).toBeDefined();
        expect(settings.providerInstances[input.instanceId]).toMatchObject({
          driver: "opencode",
          displayName: "Antseed",
          enabled: true,
          config: {
            apiConnection: {
              providerId: "t3_antseed",
              baseUrl: "http://127.0.0.1:8379",
              models: result.models,
            },
          },
          environment: [
            { name: "T3_OPENCODE_API_KEY", value: "antseed_test-secret", sensitive: true },
          ],
        });
        expect(serialize(result)).not.toContain(input.apiKey);
        expect(serialize(settings.providerInstances[input.instanceId]?.config)).not.toContain(
          input.apiKey,
        );
      }).pipe(
        Effect.provide(
          layerTest({
            providerInstances: {
              [existingId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
            },
          }),
        ),
      ),
  );

  it.effect(
    "does not create an account or reflect secret response bodies when authentication fails",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const result = yield* connectAntseedAccount(
          input,
          async () => new Response(input.apiKey, { status: 401 }),
        ).pipe(Effect.provideService(ServerSettingsService, service), Effect.result);
        expect(result._tag).toBe("Failure");
        expect(serialize(result)).not.toContain(input.apiKey);
        expect((yield* service.getSettings).providerInstances).not.toHaveProperty("antseed_test");
      }).pipe(Effect.provide(layerTest())),
  );

  for (const [name, request] of [
    ["malformed response", async () => Response.json({ models: [] })],
    ["empty model list", async () => Response.json({ data: [] })],
    ["upstream error", async () => new Response("secret response", { status: 503 })],
    [
      "network failure",
      async () => {
        throw new Error("request contained secret key");
      },
    ],
  ] as const) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const result = yield* verifyAntseedApiKey(input.baseUrl, input.apiKey, request).pipe(
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        expect(serialize(result)).not.toContain("secret");
      }),
    );
  }
});
