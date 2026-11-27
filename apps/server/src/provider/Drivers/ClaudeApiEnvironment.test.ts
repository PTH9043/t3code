import { describe, expect, it } from "vite-plus/test";
import { makeClaudeApiEnvironment } from "./ClaudeApiEnvironment.ts";

describe("Claude Console API account environment", () => {
  it("uses only its own API key and does not inherit other Claude credentials or endpoints", () => {
    const original = {
      PATH: "test-path",
      ANTHROPIC_API_KEY: "other-account-key",
      ANTHROPIC_AUTH_TOKEN: "subscription-token",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: other",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      anthropic_auth_token: "mixed-case-token",
      Anthropic_Base_Url: "https://mixed-case.example",
      anthropic_api_key: "mixed-case-key",
    };
    const actual = makeClaudeApiEnvironment(
      [
        { name: "ANTHROPIC_API_KEY", value: " selected-key ", sensitive: true },
        { name: "TEST_EXTRA", value: "kept", sensitive: false },
      ],
      original,
    );
    expect(actual.ANTHROPIC_API_KEY).toBe("selected-key");
    expect(actual.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(actual.anthropic_auth_token).toBeUndefined();
    expect(actual.Anthropic_Base_Url).toBeUndefined();
    expect(actual.anthropic_api_key).toBeUndefined();
    expect(actual.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(actual.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(actual.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(actual.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(actual.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(actual.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    expect(actual.TEST_EXTRA).toBe("kept");
    expect(original.ANTHROPIC_API_KEY).toBe("other-account-key");
  });

  it("adds only a validated, explicitly selected workspace header", () => {
    const variables = [
      { name: "ANTHROPIC_API_KEY", value: "test-key", sensitive: true },
      { name: "T3_CLAUDE_API_WORKSPACE_ID", value: "wrkspc_123abc", sensitive: false },
    ];
    expect(makeClaudeApiEnvironment(variables, {}).ANTHROPIC_CUSTOM_HEADERS).toBe(
      "anthropic-workspace-id: wrkspc_123abc",
    );
    const invalid = [variables[0]!, { ...variables[1]!, value: "wrkspc_x\nAuthorization: bad" }];
    expect(makeClaudeApiEnvironment(invalid, {}).ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  it("does not fall back to an inherited API key when its own key is missing", () => {
    const actual = makeClaudeApiEnvironment([], { ANTHROPIC_API_KEY: "inherited-key" });
    expect(actual.ANTHROPIC_API_KEY).toBe("");
  });
});
