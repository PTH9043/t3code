import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const commands = vi.hoisted(() => ({ connect: vi.fn(), toast: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: Symbol("updateSettings") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => commands.connect }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => new Error("키가 유효하지 않습니다"),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: commands.toast } }));

import { QianfanConnectionDialog } from "./QianfanConnectionDialog";

describe("Qianfan registration", () => {
  function setup(key: string) {
    hooks.reset();
    commands.connect.mockReset();
    commands.toast.mockReset();
    const close = vi.fn();
    const render = () => {
      hooks.beginRender();
      return QianfanConnectionDialog({
        open: true,
        environmentId: EnvironmentId.make("test-env"),
        onOpenChange: close,
      });
    };
    const change = (name: "model" | "key", value: string) => {
      const field = visitElements(render(), ({ props }) =>
        name === "key" ? props.type === "password" : typeof props.placeholder === "string",
      );
      (field!.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value },
      });
    };
    change("model", "model-from-console");
    change("key", key);
    const submit = () =>
      (
        visitElements(render(), ({ props }) => props.children === "등록")!.props
          .onClick as () => Promise<void>
      )();
    return { close, submit, render };
  }
  it("rejects an OpenRouter key before saving or sending it", async () => {
    const { close, submit, render } = setup("sk-or-v1-synthetic");
    await submit();
    expect(commands.connect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(
      visitElements(render(), ({ props }) => props.role === "alert")?.props.children,
    ).toContain("OpenRouter");
  });
  it("keeps the form open on storage failure and confirms only a successful account upsert", async () => {
    const { close, submit } = setup("synthetic-test-credential");
    commands.connect.mockResolvedValueOnce({ _tag: "Failure" });
    await submit();
    expect(close).not.toHaveBeenCalled();
    expect(commands.toast).not.toHaveBeenCalled();
    commands.connect.mockResolvedValueOnce({ _tag: "Success" });
    await submit();
    const request = commands.connect.mock.calls[1]![0];
    expect(request.environmentId).toBe("test-env");
    expect(Object.keys(request.input.patch)).toEqual(["providerInstancesToUpsert"]);
    const [instance] = Object.values(request.input.patch.providerInstancesToUpsert);
    expect(instance).toMatchObject({ environment: [expect.objectContaining({ sensitive: true })] });
    expect(close).toHaveBeenCalledWith(false);
  });
});
