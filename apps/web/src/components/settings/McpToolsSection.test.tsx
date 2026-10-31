import type { ReactElement } from "react";
import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  connected: false,
  effects: [] as Array<() => void | (() => void)>,
  getTools: vi.fn(),
  failure: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_UNIFIED_SETTINGS,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connected ? "connected" : "connecting" } }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { getMcpTools: Symbol(), updateSettings: Symbol() },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.getTools }));
vi.mock("../control-center/controlCenterShared", () => ({
  SectionCard: "section",
  notifyCommandFailure: (result: { _tag: string }, title: string) => {
    if (result._tag === "Success") return false;
    state.failure(title);
    return true;
  },
  formatTimestamp: () => "",
}));
import { McpToolsSection } from "./McpToolsSection";
const environmentId = EnvironmentId.make("remote-mcp-environment");
let cleanup: void | (() => void);
function render() {
  cleanup?.();
  hooks.beginRender();
  state.effects = [];
  const element = McpToolsSection({ environmentId, workspaceRoot: "D:/isolated" }) as ReactElement<
    Record<string, unknown>
  >;
  for (const effect of state.effects) cleanup = effect();
  return element;
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MCP catalog connection lifecycle", () => {
  beforeEach(() => {
    cleanup?.();
    cleanup = undefined;
    hooks.reset();
    state.connected = false;
    state.failure.mockReset();
    state.getTools.mockReset().mockResolvedValue({ _tag: "Success", value: { entries: [] } });
  });
  it("waits for the selected environment and loads its catalog after connecting", async () => {
    const waiting = render();
    expect(state.getTools).not.toHaveBeenCalled();
    const button = visitElements(
      waiting.props.action,
      (element) => typeof element.props.onClick === "function",
    );
    if (!button) throw new Error("Expected catalog refresh action");
    expect(button.props.disabled).toBe(true);
    (button.props.onClick as () => void)();
    expect(state.getTools).not.toHaveBeenCalled();
    state.connected = true;
    render();
    await flush();
    expect(state.getTools).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { check: false, workspaceRoot: "D:/isolated" },
    });
    expect(state.failure).not.toHaveBeenCalled();
  });
  it("discards a failure from the previous connection and reloads on reconnection", async () => {
    let release!: (result: { _tag: "Failure" }) => void;
    state.getTools.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    state.connected = true;
    render();
    state.connected = false;
    render();
    release({ _tag: "Failure" });
    await flush();
    expect(state.failure).not.toHaveBeenCalled();
    state.connected = true;
    render();
    await flush();
    expect(state.getTools).toHaveBeenCalledTimes(2);
  });
  it("reports a real catalog failure after the connection is ready", async () => {
    state.connected = true;
    state.getTools.mockResolvedValueOnce({ _tag: "Failure" });
    render();
    await flush();
    expect(state.failure).toHaveBeenCalledExactlyOnceWith("MCP 도구를 확인하지 못했습니다.");
  });
});
