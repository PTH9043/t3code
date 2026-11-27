import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = {
  runAtomCommand: vi.fn(async (_registry: unknown, _command: unknown, value: unknown) => ({
    _tag: "Success" as const,
    value,
  })),
};

vi.doMock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: hooks.useState,
    useEffect: () => undefined,
    useContext: () => ({}),
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  };
});
vi.doMock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));
vi.doMock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>();
  return {
    ...actual,
    runAtomCommand: state.runAtomCommand,
  };
});

const { CompletionAutomationSection } = await import("./CompletionAutomationSection");

function makeProject(
  completionAutomation?: NonNullable<
    EnvironmentProject["workspaceControl"]
  >["completionAutomation"],
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make("env-1"),
    id: ProjectId.make("proj-1"),
    name: "Demo",
    cwd: "D:/demo",
    defaultModelSelection: null,
    scripts: [],
    workspaceControl: {
      isolationMode: "strict",
      longTermMemoryRoot: null,
      ...(completionAutomation ? { completionAutomation } : {}),
    },
  } as unknown as EnvironmentProject;
}

describe("CompletionAutomationSection", () => {
  beforeEach(() => {
    hooks.reset();
    state.runAtomCommand.mockClear();
  });

  it("reads persisted server limits, updates them interactively, and saves to server contract without localStorage", async () => {
    const project = makeProject({
      enabled: true,
      formatCommands: ["npm.cmd run format"],
      verificationCommands: ["npm.cmd test"],
      saveResult: true,
      followUpTask: null,
      maxAutoFixAttempts: 4,
      commandTimeoutSeconds: 300,
    });

    const render = () => {
      hooks.beginRender();
      return CompletionAutomationSection({ project });
    };

    const tree1 = render();
    const attemptsInput = visitElements(
      tree1,
      (element) => element.props.type === "number" && element.props.max === 5,
    );
    const timeoutInput = visitElements(
      tree1,
      (element) => element.props.type === "number" && element.props.max === 1800,
    );
    expect(attemptsInput?.props.value).toBe("4");
    expect(timeoutInput?.props.value).toBe("300");

    // Update both numeric fields and verify server save payload.
    (attemptsInput!.props.onChange as (event: { currentTarget: { value: string } }) => void)({
      currentTarget: { value: "5" },
    });
    (timeoutInput!.props.onChange as (event: { currentTarget: { value: string } }) => void)({
      currentTarget: { value: "600" },
    });

    const tree2 = render();
    const saveButton = visitElements(tree2, (element) => element.props.children === "설정 저장");
    expect(saveButton).toBeDefined();
    (saveButton!.props.onClick as () => void)();

    await vi.waitFor(() => expect(state.runAtomCommand).toHaveBeenCalledOnce());
    expect(state.runAtomCommand.mock.calls[0]?.[2]).toEqual({
      environmentId: EnvironmentId.make("env-1"),
      input: {
        projectId: ProjectId.make("proj-1"),
        longTermMemoryRoot: null,
        completionAutomation: {
          enabled: true,
          formatCommands: ["npm.cmd run format"],
          verificationCommands: ["npm.cmd test"],
          saveResult: true,
          followUpTask: null,
          maxAutoFixAttempts: 5,
          commandTimeoutSeconds: 600,
        },
      },
    });
  });

  it("falls back to default limits (3 attempts / 120s) for legacy server records", async () => {
    const project = makeProject({
      enabled: true,
      formatCommands: [],
      verificationCommands: ["npm.cmd test"],
      saveResult: true,
      followUpTask: null,
    });

    const render = () => {
      hooks.beginRender();
      return CompletionAutomationSection({ project });
    };

    const tree = render();
    const attemptsInput = visitElements(
      tree,
      (element) => element.props.type === "number" && element.props.max === 5,
    );
    const timeoutInput = visitElements(
      tree,
      (element) => element.props.type === "number" && element.props.max === 1800,
    );
    expect(attemptsInput?.props.value).toBe("3");
    expect(timeoutInput?.props.value).toBe("120");

    const saveButton = visitElements(tree, (element) => element.props.children === "설정 저장");
    expect(saveButton).toBeDefined();
    (saveButton!.props.onClick as () => void)();

    await vi.waitFor(() => expect(state.runAtomCommand).toHaveBeenCalledOnce());
    expect(state.runAtomCommand.mock.calls[0]?.[2]).toEqual({
      environmentId: EnvironmentId.make("env-1"),
      input: {
        projectId: ProjectId.make("proj-1"),
        longTermMemoryRoot: null,
        completionAutomation: {
          enabled: true,
          formatCommands: [],
          verificationCommands: ["npm.cmd test"],
          saveResult: true,
          followUpTask: null,
          maxAutoFixAttempts: 3,
          commandTimeoutSeconds: 120,
        },
      },
    });
  });
});
