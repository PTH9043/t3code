import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  update: vi.fn(() => vi.fn()),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: settingsHooks.read,
  useUpdateEnvironmentSettings: settingsHooks.update,
}));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { DeepSeekConnectionDialog } from "./DeepSeekConnectionDialog";
import { AntseedConnectionDialog } from "./AntseedConnectionDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");

describe("AddProviderInstanceDialog environment routing", () => {
  beforeEach(() => {
    hooks.reset();
    settingsHooks.read.mockClear();
    settingsHooks.update.mockClear();
  });

  it("reads and writes settings through the supplied environment", () => {
    hooks.beginRender();
    AddProviderInstanceDialog({
      open: true,
      environmentId: remoteEnvironmentId,
      environmentLabel: "Remote device",
      onOpenChange: vi.fn(),
    });

    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.update).toHaveBeenCalledWith(remoteEnvironmentId);
  });
  it("opens a dedicated DeepSeek connection from account addition in the same environment", () => {
    const props = {
      open: true,
      environmentId: remoteEnvironmentId,
      environmentLabel: "Remote device",
      onOpenChange: vi.fn(),
    };
    hooks.beginRender();
    const choice = visitElements(
      AddProviderInstanceDialog(props),
      (element) => element.props.children === "DeepSeek API 계정 연결",
    );
    expect(choice).toBeDefined();
    (choice!.props.onClick as () => void)();
    hooks.beginRender();
    const result = AddProviderInstanceDialog(props);
    expect(result.type).toBe(DeepSeekConnectionDialog);
    expect(result.props.environmentId).toBe(remoteEnvironmentId);
    (result.props.onBack as () => void)();
    hooks.beginRender();
    expect(AddProviderInstanceDialog(props).type).not.toBe(DeepSeekConnectionDialog);
  });

  it("opens a dedicated Antseed connection from account addition in the same environment", () => {
    const props = {
      open: true,
      environmentId: remoteEnvironmentId,
      environmentLabel: "Remote device",
      onOpenChange: vi.fn(),
    };
    hooks.beginRender();
    const choice = visitElements(
      AddProviderInstanceDialog(props),
      (element) => element.props.children === "Antseed 게이트웨이 연결",
    );
    expect(choice).toBeDefined();
    (choice!.props.onClick as () => void)();
    hooks.beginRender();
    const result = AddProviderInstanceDialog(props);
    expect(result.type).toBe(AntseedConnectionDialog);
    expect(result.props.environmentId).toBe(remoteEnvironmentId);
    (result.props.onBack as () => void)();
    hooks.beginRender();
    expect(AddProviderInstanceDialog(props).type).not.toBe(AntseedConnectionDialog);
  });
});
