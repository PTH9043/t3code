import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
  serverEnvironment: { connectDeepSeek: Symbol("connectDeepSeek") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => commands.connect }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => new Error("키가 유효하지 않습니다"),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: commands.toast } }));

import { DeepSeekConnectionDialog } from "./DeepSeekConnectionDialog";

describe("DeepSeek account dialog", () => {
  beforeEach(() => {
    hooks.reset();
    commands.connect.mockReset();
    commands.toast.mockReset();
  });
  const environmentId = EnvironmentId.make("remote-device");

  function setup() {
    const close = vi.fn();
    const render = () => {
      hooks.beginRender();
      return DeepSeekConnectionDialog({ open: true, environmentId, onOpenChange: close });
    };
    const enterKey = () => {
      const input = visitElements(render(), (element) => element.props.type === "password");
      (input!.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "sk-test-secret" },
      });
    };
    const submit = () =>
      visitElements(
        render(),
        (element) =>
          Array.isArray(element.props.children) && element.props.children.includes("확인하고 연결"),
      );
    return { close, render, enterKey, submit };
  }

  it("waits for authentication and routes the new account to the selected environment", async () => {
    const { close, enterKey, submit, render } = setup();
    let resolve!: (value: unknown) => void;
    commands.connect.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    expect(submit()!.props.disabled).toBe(true);
    enterKey();
    expect(submit()!.props.disabled).toBe(false);
    const completion = (submit()!.props.onClick as () => Promise<void>)();
    expect(close).not.toHaveBeenCalled();
    expect(commands.toast).not.toHaveBeenCalled();
    expect(commands.connect).toHaveBeenCalledWith({
      environmentId,
      input: {
        instanceId: expect.stringMatching(/^deepseek_/),
        displayName: "DeepSeek",
        apiKey: "sk-test-secret",
      },
    });
    const waiting = visitElements(
      render(),
      (element) =>
        Array.isArray(element.props.children) && element.props.children.includes("연결 확인 중"),
    );
    expect(waiting!.props.disabled).toBe(true);
    resolve({ _tag: "Success", value: { models: ["deepseek-flash"] } });
    await completion;
    expect(close).toHaveBeenCalledWith(false);
    expect(commands.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
    expect(
      visitElements(render(), (element) => element.props.type === "password")!.props.value,
    ).toBe("");
  });

  it("keeps the dialog open on a rejected key and shows no success toast", async () => {
    commands.connect.mockResolvedValue({ _tag: "Failure" });
    const { close, enterKey, submit, render } = setup();
    enterKey();
    await (submit()!.props.onClick as () => Promise<void>)();
    expect(visitElements(render(), (element) => element.props.role === "alert")).toBeDefined();
    expect(close).not.toHaveBeenCalled();
    expect(commands.toast).not.toHaveBeenCalled();
  });

  it("links to the official account API-key page", () => {
    const { render } = setup();
    expect(
      visitElements(
        render(),
        (element) => element.props.href === "https://platform.deepseek.com/api_keys",
      ),
    ).toBeDefined();
  });
});
