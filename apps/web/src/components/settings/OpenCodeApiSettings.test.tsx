import {
  ProviderDriverKind,
  OPENCODE_API_KEY_ENV,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { OpenCodeApiSettings, withOpenCodeApiConnection } from "./OpenCodeApiSettings";

const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("opencode"),
  displayName: "My API",
  config: { binaryPath: "custom-opencode", customModels: ["existing/model"] },
  environment: [
    { name: OPENCODE_API_KEY_ENV, value: "", sensitive: true, valueRedacted: true },
    { name: "EXISTING", value: "retained", sensitive: false },
  ],
};
const connection = {
  providerId: "my_api",
  baseUrl: "https://example.com/v1",
  protocol: "chat-completions" as const,
  models: ["model"],
};

describe("API settings credential updates", () => {
  beforeEach(() => hooks.reset());
  it("saves the DeepSeek preset and a typed key together through the existing instance update", () => {
    const update = vi.fn();
    const render = () => {
      hooks.beginRender();
      return OpenCodeApiSettings({ instance, onUpdate: update });
    };
    const preset = visitElements(
      render(),
      (element) => element.props.children === "DeepSeek 기본값",
    );
    (preset!.props.onClick as () => void)();
    const key = visitElements(render(), (element) => element.props.type === "password");
    (key!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "typed-key" },
    });
    const save = visitElements(render(), (element) => element.props.children === "API 연결 저장");
    (save!.props.onClick as () => void)();
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      config: {
        binaryPath: "custom-opencode",
        apiConnection: {
          providerId: "t3_deepseek",
          baseUrl: "https://api.deepseek.com",
          models: ["deepseek-flash", "deepseek-v4-pro"],
        },
      },
      environment: [
        { name: OPENCODE_API_KEY_ENV, value: "typed-key", sensitive: true },
        instance.environment![1],
      ],
    });
  });
  it("preserves the redacted server credential on endpoint-only edits", () => {
    const updated = withOpenCodeApiConnection(instance, connection, "");
    expect(updated.environment).toEqual(instance.environment);
    expect(updated.config).toMatchObject({
      binaryPath: "custom-opencode",
      customModels: ["existing/model"],
      apiConnection: connection,
    });
    expect(updated.displayName).toBe("My API");
  });
  it("replaces only the owned key and always marks it sensitive", () => {
    const updated = withOpenCodeApiConnection(instance, connection, "replacement-key");
    expect(updated.environment).toEqual([
      { name: OPENCODE_API_KEY_ENV, value: "replacement-key", sensitive: true },
      instance.environment![1],
    ]);
    expect(JSON.stringify(updated.config)).not.toContain("replacement-key");
  });
  it("can disconnect without destroying native settings or other environment variables", () => {
    const connected = withOpenCodeApiConnection(instance, connection, "");
    const disconnected = withOpenCodeApiConnection(connected, null, "");
    expect(disconnected.config).not.toHaveProperty("apiConnection");
    expect(disconnected.environment).toEqual(instance.environment);
  });
  it("rejects unsupported remote-process configuration and credentials embedded in a URL", () => {
    expect(() =>
      withOpenCodeApiConnection(
        { ...instance, config: { serverUrl: "http://example.com:4096" } },
        connection,
        "",
      ),
    ).toThrow("서버 URL");
    expect(() =>
      withOpenCodeApiConnection(
        instance,
        { ...connection, baseUrl: "https://example.com?key=secret" },
        "",
      ),
    ).toThrow("API 주소");
  });
});
