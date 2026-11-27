import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  beginGrokDeviceAuth: Symbol("beginGrokDeviceAuth"),
  waitGrokDeviceAuth: Symbol("waitGrokDeviceAuth"),
  cancelGrokDeviceAuth: Symbol("cancelGrokDeviceAuth"),
  loginProviderAccount: Symbol("loginProviderAccount"),
  updateSettings: Symbol("updateSettings"),
}));

const commands = vi.hoisted(() => ({
  beginDevice: vi.fn(),
  waitDevice: vi.fn(),
  cancelDevice: vi.fn(),
  loginOAuth: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: vi.fn(),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    beginGrokDeviceAuth: atoms.beginGrokDeviceAuth,
    waitGrokDeviceAuth: atoms.waitGrokDeviceAuth,
    cancelGrokDeviceAuth: atoms.cancelGrokDeviceAuth,
    loginProviderAccount: atoms.loginProviderAccount,
    updateSettings: atoms.updateSettings,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.beginGrokDeviceAuth) return commands.beginDevice;
    if (atom === atoms.waitGrokDeviceAuth) return commands.waitDevice;
    if (atom === atoms.cancelGrokDeviceAuth) return commands.cancelDevice;
    if (atom === atoms.loginProviderAccount) return commands.loginOAuth;
    return commands.updateSettings;
  },
}));

import { buildGrokApiInstance, GrokAccountDialog, XAI_API_KEY_ENV_NAME } from "./GrokAccountDialog";

const environmentId = EnvironmentId.make("local");

describe("GrokAccountDialog", () => {
  beforeEach(() => {
    hooks.reset();
    commands.beginDevice.mockReset();
    commands.waitDevice.mockReset();
    commands.cancelDevice.mockReset();
    commands.loginOAuth.mockReset();
    commands.updateSettings.mockReset();
  });

  it("builds a sensitive XAI_API_KEY Grok instance and inherits custom binaryPath", () => {
    const built = buildGrokApiInstance({
      displayName: "  Grok Team API  ",
      apiKey: "  xai-secret-123  ",
      accentColor: "#2563eb",
      binaryPath: "E:\\NewAutoUsage\\tools\\grok\\1.0.46\\grok.exe",
    });

    expect(built).toEqual({
      driver: ProviderDriverKind.make("grok"),
      displayName: "Grok Team API",
      enabled: true,
      accentColor: "#2563eb",
      config: { binaryPath: "E:\\NewAutoUsage\\tools\\grok\\1.0.46\\grok.exe" },
      environment: [{ name: XAI_API_KEY_ENV_NAME, value: "xai-secret-123", sensitive: true }],
    });

    expect(() => buildGrokApiInstance({ displayName: "Grok API", apiKey: "   " })).toThrow();
  });

  it("renders all three tabs in add mode and saves an xAI API key instance", async () => {
    commands.updateSettings.mockResolvedValue({ _tag: "Success", value: {} });
    const onOpenChange = vi.fn();
    const props = {
      open: true,
      environmentId,
      mode: "add" as const,
      initialTab: "api-key" as const,
      defaultBinaryPath: "E:\\NewAutoUsage\\tools\\grok\\1.0.46\\grok.exe",
      onOpenChange,
    };

    hooks.beginRender();
    const tree = GrokAccountDialog(props);
    const tabs: string[] = [];
    visitElements(tree, (el) => {
      if (el.props.role === "tab") {
        const text = visitElements(el, (child) => typeof child.props.children === "string");
        if (text) tabs.push(text.props.children as string);
      }
      return false;
    });
    expect(tabs).toEqual(["다른 계정 (장치 코드)", "브라우저 OAuth", "xAI API 키"]);

    const keyInput = visitElements(tree, (el) => el.props.type === "password");
    expect(keyInput).toBeDefined();
    (keyInput!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "xai-key-from-ui" },
    });

    hooks.beginRender();
    const updatedTree = GrokAccountDialog(props);
    const saveButton = visitElements(
      updatedTree,
      (el) =>
        Array.isArray(el.props.children) &&
        el.props.children.some((child: unknown) => child === "xAI API 계정 추가"),
    );
    expect(saveButton).toBeDefined();
    await (saveButton!.props.onClick as () => Promise<void>)();

    expect(commands.updateSettings).toHaveBeenCalledTimes(1);
    const call = commands.updateSettings.mock.calls[0]?.[0];
    expect(call.environmentId).toBe(environmentId);
    const upserted = Object.values(call.input.patch.providerInstancesToUpsert)[0] as Record<
      string,
      unknown
    >;
    expect(upserted.driver).toBe("grok");
    expect(upserted.displayName).toBe("Grok API");
    expect(upserted.config).toEqual({
      binaryPath: "E:\\NewAutoUsage\\tools\\grok\\1.0.46\\grok.exe",
    });
    expect(upserted.environment).toEqual([
      { name: "XAI_API_KEY", value: "xai-key-from-ui", sensitive: true },
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hides the api-key tab in reauth mode and forwards instanceId on OAuth login", async () => {
    const targetId = ProviderInstanceId.make("grok_work");
    commands.loginOAuth.mockResolvedValue({
      _tag: "Success",
      value: { instanceId: targetId, driver: "grok", email: "work@example.com" },
    });
    const onAuthenticated = vi.fn();
    const onOpenChange = vi.fn();

    hooks.beginRender();
    const tree = GrokAccountDialog({
      open: true,
      environmentId,
      mode: "reauth",
      instanceId: targetId,
      instanceDisplayName: "Grok Work",
      onAuthenticated,
      onOpenChange,
    });

    const tabs: string[] = [];
    visitElements(tree, (el) => {
      if (el.props.role === "tab") {
        const text = visitElements(el, (child) => typeof child.props.children === "string");
        if (text) tabs.push(text.props.children as string);
      }
      return false;
    });
    expect(tabs).toEqual(["브라우저 OAuth", "다른 계정 (장치 코드)"]);

    const loginButton = visitElements(
      tree,
      (el) =>
        Array.isArray(el.props.children) &&
        el.props.children.some((child: unknown) => child === "브라우저로 Grok 로그인"),
    );
    expect(loginButton).toBeDefined();
    await (loginButton!.props.onClick as () => Promise<void>)();

    expect(commands.loginOAuth).toHaveBeenCalledWith({
      environmentId,
      input: {
        driver: "grok",
        instanceId: targetId,
      },
    });
    expect(onAuthenticated).toHaveBeenCalledWith({
      instanceId: targetId,
      email: "work@example.com",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
