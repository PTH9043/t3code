import { OPENCODE_API_KEY_ENV } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
import { buildExaoneInstance } from "./ExaoneConnectionDialog";

describe("EXAONE account", () => {
  it("creates a separate OpenCode instance and marks its credential sensitive", () => {
    const credential = "test-input";
    const instance = buildExaoneInstance(" EXAONE ", credential);
    expect(instance).toMatchObject({
      driver: "opencode",
      displayName: "EXAONE",
      enabled: true,
      config: {
        apiConnection: {
          providerId: "t3_exaone",
          baseUrl: "https://api.exaone.ai/v1",
          protocol: "chat-completions",
          models: ["k-exaone_v2.5"],
          contextTokens: 524288,
          outputTokens: 32000,
        },
      },
      environment: [{ name: OPENCODE_API_KEY_ENV, value: credential, sensitive: true }],
    });
    expect(JSON.stringify(instance.config)).not.toContain(credential);
  });

  it("requires an account name and credential", () => {
    expect(() => buildExaoneInstance(" ", " ")).toThrow();
  });
});
