import { assert, describe, it } from "@effect/vitest";
import {
  configureOpenAiApiAccount,
  isValidOpenAiApiModelId,
  OPENAI_API_CREDENTIAL_ENV,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";
import { filterAndSortOpenAiApiModels, listOpenAiApiModels } from "./OpenAiApiModels.ts";

const makeSettingsLayer = (apiKey?: string) => {
  const base = Schema.decodeSync(ServerSettings)({});
  const instanceId = ProviderInstanceId.make("openai_api_saved");
  const settings: ServerSettings = apiKey
    ? {
        ...base,
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("opencode"),
            displayName: "OpenAI API",
            enabled: true,
            config: {
              apiConnection: {
                providerId: "t3_openai",
                baseUrl: "https://api.openai.com/v1",
                protocol: "responses",
                models: ["gpt-5.4"],
              },
            },
            environment: [{ name: OPENAI_API_CREDENTIAL_ENV, value: apiKey, sensitive: true }],
          },
        },
      }
    : base;
  return ServerSettingsService.of({
    getSettings: Effect.succeed(settings),
  } as unknown as (typeof ServerSettingsService)["Service"]);
};

describe("OpenAI API model validation and listing", () => {
  it("rejects display names with spaces or slashes as OpenAI API model IDs", () => {
    assert.isFalse(isValidOpenAiApiModelId("OpenAI API"));
    assert.isFalse(isValidOpenAiApiModelId("t3_openai/gpt-5.4"));
    assert.isTrue(isValidOpenAiApiModelId("gpt-5.4"));
    assert.isTrue(isValidOpenAiApiModelId("o3-mini"));

    assert.throws(
      () =>
        configureOpenAiApiAccount({
          displayName: "OpenAI API",
          models: ["OpenAI API"],
          apiKey: "sk-test-key",
        }),
      /유효한 OpenAI API 모델 ID가 아닙니다/,
    );
  });

  it("filters out non-text utility models and prioritizes flagship chat/reasoning models", () => {
    const result = filterAndSortOpenAiApiModels([
      "whisper-1",
      "text-embedding-3-large",
      "gpt-image-1",
      "gpt-4o",
      "o3",
      "gpt-5.4",
      "gpt-5-mini",
      "tts-1",
    ]);
    assert.deepStrictEqual(result, ["gpt-5.4", "gpt-5-mini", "o3", "gpt-4o"]);
  });

  it.effect("lists models using either a provided API key or a saved account key", () =>
    Effect.gen(function* () {
      const seenHeaders: string[] = [];
      const fakeFetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
        seenHeaders.push(auth);
        return new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }, { id: "gpt-5.4" }, { id: "whisper-1" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const byKey = yield* listOpenAiApiModels({ apiKey: "sk-inline" }, fakeFetch).pipe(
        Effect.provideService(ServerSettingsService, makeSettingsLayer()),
      );
      assert.deepStrictEqual(byKey.models, ["gpt-5.4", "gpt-4o"]);

      const byInstance = yield* listOpenAiApiModels(
        { instanceId: ProviderInstanceId.make("openai_api_saved") },
        fakeFetch,
      ).pipe(Effect.provideService(ServerSettingsService, makeSettingsLayer("sk-stored")));
      assert.deepStrictEqual(byInstance.models, ["gpt-5.4", "gpt-4o"]);
      assert.deepStrictEqual(seenHeaders, ["Bearer sk-inline", "Bearer sk-stored"]);
    }),
  );

  it.effect("surfaces a clear authentication error on HTTP 401", () =>
    Effect.gen(function* () {
      const fakeFetch = (async () =>
        new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;
      const error = yield* listOpenAiApiModels({ apiKey: "sk-bad" }, fakeFetch).pipe(
        Effect.provideService(ServerSettingsService, makeSettingsLayer()),
        Effect.flip,
      );
      assert.include(error.detail, "401/403");
    }),
  );
});
