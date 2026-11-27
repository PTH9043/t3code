import { OpenCodeSettings, OPENCODE_API_KEY_ENV } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { openCodeApiEnvironment, openCodeContinuationKey } from "./OpenCodeApiConnection.ts";

const decodeSettings = Schema.decodeSync(OpenCodeSettings);
const settings = decodeSettings({
  apiConnection: {
    providerId: "test_api",
    baseUrl: "https://example.com/v1",
    protocol: "chat-completions",
    models: ["model-a", "org/model-b"],
    contextTokens: 128000,
    outputTokens: 8192,
  },
});

describe("OpenCode API connection", () => {
  it("repairs the API path for an existing Antseed account at runtime", () => {
    const old = {
      ...settings,
      apiConnection: {
        ...settings.apiConnection!,
        providerId: "t3_antseed",
        baseUrl: "http://localhost:8379",
      },
    };
    const config = JSON.parse(openCodeApiEnvironment(old, {}).OPENCODE_CONFIG_CONTENT!);
    expect(config.provider.t3_antseed.options.baseURL).toBe("http://localhost:8379/v1");
  });
  it("uses official provider configuration and an environment reference without embedding credentials", () => {
    const environment = openCodeApiEnvironment(settings, {
      [OPENCODE_API_KEY_ENV]: "secret-test-key",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { bash: "ask" },
        provider: { retained: {} },
      }),
    });
    const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT!);
    expect(config.permission).toEqual({ bash: "ask" });
    expect(config.provider.retained).toEqual({});
    expect(config.enabled_providers).toEqual(["test_api"]);
    expect(config.provider.test_api.options).toEqual({
      baseURL: "https://example.com/v1",
      apiKey: `{env:${OPENCODE_API_KEY_ENV}}`,
    });
    expect(config.provider.test_api.models["org/model-b"].limit).toEqual({
      context: 128000,
      output: 8192,
    });
    expect(environment.OPENCODE_CONFIG_CONTENT).not.toContain("secret-test-key");
    expect(environment[OPENCODE_API_KEY_ENV]).toBe("secret-test-key");
  });
  it("selects the Responses package only for a Responses endpoint", () => {
    const config = JSON.parse(
      openCodeApiEnvironment(
        { ...settings, apiConnection: { ...settings.apiConnection!, protocol: "responses" } },
        {},
      ).OPENCODE_CONFIG_CONTENT!,
    );
    expect(config.provider.test_api.npm).toBe("@ai-sdk/openai");
  });
  it("does not pretend local environment changes configure a remote harness", () => {
    expect(() =>
      openCodeApiEnvironment({ ...settings, serverUrl: "http://example.com:4096" }, {}),
    ).toThrow("T3-managed");
  });
  it("rejects secrets in URLs and invalid inline JSON instead of leaking/replacing configuration", () => {
    for (const baseUrl of [
      "https://user:secret@example.com",
      "https://example.com?api_key=secret",
      "https://example.com#secret",
      "file:///tmp/api",
    ]) {
      expect(() =>
        openCodeApiEnvironment(
          { ...settings, apiConnection: { ...settings.apiConnection!, baseUrl } },
          {},
        ),
      ).toThrow();
    }
    expect(() => openCodeApiEnvironment(settings, { OPENCODE_CONFIG_CONTENT: "[]" })).toThrow(
      "JSON object",
    );
  });
  it("changes session namespace for endpoint/storage changes but preserves it for key rotation", () => {
    const key = openCodeContinuationKey("opencode:instance:test", settings, {});
    expect(
      openCodeContinuationKey("opencode:instance:test", settings, {
        [OPENCODE_API_KEY_ENV]: "rotated",
      }),
    ).toBe(key);
    expect(
      openCodeContinuationKey("opencode:instance:test", settings, { XDG_DATA_HOME: "D:/other" }),
    ).not.toBe(key);
    expect(
      openCodeContinuationKey(
        "opencode:instance:test",
        {
          ...settings,
          apiConnection: { ...settings.apiConnection!, baseUrl: "https://other.example/v1" },
        },
        {},
      ),
    ).not.toBe(key);
  });
  it("leaves an existing unconfigured OpenCode instance intact", () => {
    const ordinary = decodeSettings({});
    const env = { EXISTING: "value" };
    expect(openCodeApiEnvironment(ordinary, env)).toBe(env);
    expect(openCodeContinuationKey("existing", ordinary, env)).toBe("existing");
  });
});
