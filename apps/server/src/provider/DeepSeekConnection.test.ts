import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerSettingsService, layerTest } from "../serverSettings.ts";
import {
  connectDeepSeekAccount,
  verifyDeepSeekApiKey,
  type DeepSeekRequest,
} from "./DeepSeekConnection.ts";

const input = {
  instanceId: ProviderInstanceId.make("deepseek_test"),
  displayName: "DeepSeek",
  apiKey: "test-secret-key",
};
const existingId = ProviderInstanceId.make("codex_personal");
const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("DeepSeek account connection", () => {
  it.effect(
    "checks the official endpoint and stores discovered models without removing other accounts",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const request: DeepSeekRequest = async (url, options) => {
          expect(url).toBe("https://api.deepseek.com/models");
          expect(options?.headers).toEqual({ Authorization: "Bearer test-secret-key" });
          expect(options?.redirect).toBe("error");
          return Response.json({
            data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }, { id: "deepseek-flash" }],
          });
        };
        const result = yield* connectDeepSeekAccount(input, request).pipe(
          Effect.provideService(ServerSettingsService, service),
        );
        expect(result.models).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
        const settings = yield* service.getSettings;
        expect(settings.providerInstances[existingId]).toBeDefined();
        expect(settings.providerInstances[input.instanceId]).toMatchObject({
          driver: "opencode",
          displayName: "DeepSeek",
          enabled: true,
          config: {
            apiConnection: {
              providerId: "t3_deepseek",
              baseUrl: "https://api.deepseek.com",
              models: result.models,
            },
          },
          environment: [{ name: "T3_OPENCODE_API_KEY", value: "test-secret-key", sensitive: true }],
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
        const result = yield* connectDeepSeekAccount(
          input,
          async () => new Response(input.apiKey, { status: 401 }),
        ).pipe(Effect.provideService(ServerSettingsService, service), Effect.result);
        expect(result._tag).toBe("Failure");
        expect(serialize(result)).not.toContain(input.apiKey);
        expect((yield* service.getSettings).providerInstances).not.toHaveProperty("deepseek_test");
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
        const result = yield* verifyDeepSeekApiKey(input.apiKey, request).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(serialize(result)).not.toContain("secret");
      }),
    );
  }
});
