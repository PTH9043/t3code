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
  it("automatically triggers a background health probe when enabled MCP servers are unchecked (BUG-08)", async () => {
    state.connected = true;
    state.getTools
      .mockResolvedValueOnce({
        _tag: "Success",
        value: {
          entries: [
            {
              id: "builtin:context7",
              builtinId: "context7",
              name: "Context7",
              description: "Docs lookup",
              source: "https://example.com",
              scope: "environment",
              providers: ["claudeAgent"],
              installed: true,
              enabled: true,
              status: "unchecked",
              tools: [],
              checkedAt: null,
              error: null,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: {
          entries: [
            {
              id: "builtin:context7",
              builtinId: "context7",
              name: "Context7",
              description: "Docs lookup",
              source: "https://example.com",
              scope: "environment",
              providers: ["claudeAgent"],
              installed: true,
              enabled: true,
              status: "ready",
              tools: ["resolve-library-id", "query-docs"],
              checkedAt: "2026-11-22T05:00:00.000Z",
              error: null,
            },
          ],
        },
      });
    render();
    await flush();
    await flush();
    expect(state.getTools).toHaveBeenCalledTimes(2);
    expect(state.getTools).toHaveBeenNthCalledWith(2, {
      environmentId,
      input: { check: true, workspaceRoot: "D:/isolated" },
    });
  });

  it("renders t3-code priority card, Antigravity tool budget badge, and native-redundant notice", async () => {
    state.connected = true;
    state.getTools.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        entries: [
          {
            id: "filesystem",
            builtinId: "filesystem",
            name: "Project Files",
            description: "Local files",
            source: "https://example.com/fs",
            scope: "environment",
            providers: ["codex", "claudeAgent", "gemini", "grok"],
            nativeRedundantProviders: ["gemini"],
            estimatedToolCount: 14,
            installed: true,
            enabled: true,
            status: "ready",
            tools: ["read_file"],
            checkedAt: "2026-11-25T05:00:00.000Z",
            error: null,
          },
          {
            id: "openaiDocs",
            builtinId: "openaiDocs",
            name: "OpenAI Docs",
            description: "Docs",
            source: "https://example.com/docs",
            scope: "environment",
            providers: ["codex", "claudeAgent", "gemini", "grok"],
            estimatedToolCount: 5,
            installed: true,
            enabled: true,
            status: "ready",
            tools: ["search_docs", "fetch_doc"],
            checkedAt: "2026-11-25T05:00:00.000Z",
            error: null,
          },
        ],
      },
    });
    const tree = render();
    await flush();
    const updated = render();
    expect(tree).toBeDefined();
    const textChunks: string[] = [];
    const collectText = (node: unknown) => {
      if (typeof node === "string" || typeof node === "number") {
        textChunks.push(String(node));
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) collectText(item);
        return;
      }
      if (node && typeof node === "object" && "props" in node) {
        const children = (node as { props?: { children?: unknown } }).props?.children;
        collectText(children);
      }
    };
    collectText(updated);
    const fullText = textChunks.join(" ");
    expect(fullText).toContain("T3 Code 내장 도구 (t3-code)");
    expect(fullText).toContain("항상 최우선 활성");
    expect(fullText).toContain("Antigravity 예상 도구");
    expect(fullText).toContain("28");
    expect(fullText).toContain("40");
    expect(fullText).toContain("Antigravity 기본 제외 (내장 도구 중복 · 예산 보호)");
  });
});
