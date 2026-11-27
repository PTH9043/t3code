import type { ReactElement } from "react";
import { EnvironmentId, ExtensionError } from "@t3tools/contracts";
import { Cause } from "effect";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({ get: vi.fn(), manage: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: () => {},
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: { getExtensions: "get", manageExtension: "manage" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (action: string) => (action === "get" ? state.get : state.manage),
}));
vi.mock("../control-center/controlCenterShared", () => ({
  SectionCard: "section",
  notifyCommandFailure: (result: { _tag: string }) => result._tag !== "Success",
}));
import { ExtensionsSection } from "./ExtensionsSection";
import { SkillSecurityReportView } from "./SkillSecurityReport";

beforeEach(() => {
  hooks.reset();
  state.get.mockReset();
  state.manage.mockReset();
});

it("shows the installed skill's report after the existing install and refresh actions", async () => {
  const report = {
    version: 1,
    complete: false,
    scannedFiles: 1,
    findings: [{ kind: "instruction-override", file: "SKILL.md", line: 2 }],
    skipped: [{ reason: "symlink", file: "linked" }],
  };
  const empty = { entries: [], providers: [], instances: [] };
  const installed = {
    ...empty,
    entries: [
      {
        id: "skill-path",
        name: "sample",
        kind: "skill",
        provider: "grok",
        source: "example",
        version: null,
        enabled: true,
        scope: "project",
        actions: ["update"],
        securityScan: report,
      },
    ],
  };
  state.get
    .mockResolvedValueOnce({ _tag: "Success", value: empty })
    .mockResolvedValue({ _tag: "Success", value: installed });
  state.manage.mockResolvedValue({ _tag: "Success", value: { message: "완료" } });
  const render = () => {
    hooks.beginRender();
    return ExtensionsSection({
      environmentId: EnvironmentId.make("test"),
      workspaceRoot: "D:/fixture",
    }) as ReactElement<Record<string, unknown>>;
  };
  const refresh = visitElements(
    render().props.action,
    (element) => typeof element.props.onClick === "function",
  );
  expect(refresh).not.toBeNull();
  (refresh!.props.onClick as () => void)();
  await vi.waitFor(() => expect(state.get).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  const kind = visitElements(
    render(),
    (element) => element.type === "select" && element.props.value === "plugin",
  );
  expect(kind).not.toBeNull();
  (kind!.props.onChange as (event: unknown) => void)({ target: { value: "skill" } });
  const input = visitElements(
    render(),
    (element) => element.type === "input" && element.props.value === "",
  );
  expect(input).not.toBeNull();
  (input!.props.onChange as (event: unknown) => void)({
    target: { value: "https://github.com/a/b/tree/main/skills/example" },
  });
  const install = visitElements(
    render(),
    (element) => element.props.children === "설치" && typeof element.props.onClick === "function",
  );
  expect(install).not.toBeNull();
  (install!.props.onClick as () => void)();
  await vi.waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  expect(state.manage).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ kind: "skill", action: "install" }),
    }),
  );
  const result = visitElements(render(), (element) => element.type === SkillSecurityReportView);
  expect(result?.props.report).toEqual(report);
});

it("keeps the recovery path visible when a skill update fails", async () => {
  const backup = "D:/isolated/.agents/skills/.t3-skill-backup-example/previous";
  state.get.mockResolvedValue({
    _tag: "Success",
    value: {
      providers: [],
      instances: [],
      entries: [
        {
          id: "skill-path",
          name: "sample",
          kind: "skill",
          provider: "grok",
          source: "example",
          version: null,
          enabled: true,
          scope: "project",
          actions: ["update"],
        },
      ],
    },
  });
  state.manage.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new ExtensionError({ message: `원본 백업이 보존된 위치: ${backup}` })),
  });
  const render = () => {
    hooks.beginRender();
    return ExtensionsSection({
      environmentId: EnvironmentId.make("test"),
      workspaceRoot: "D:/isolated",
    }) as ReactElement<Record<string, unknown>>;
  };
  const refresh = visitElements(
    render().props.action,
    (element) => typeof element.props.onClick === "function",
  );
  (refresh!.props.onClick as () => void)();
  await vi.waitFor(() => expect(state.get).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  const update = visitElements(
    render(),
    (element) =>
      element.props.children === "업데이트" && typeof element.props.onClick === "function",
  );
  expect(update).not.toBeNull();
  (update!.props.onClick as () => void)();
  await vi.waitFor(() => expect(state.manage).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  const status = visitElements(render(), (element) => element.props.role === "status");
  expect(status?.props.children).toContain(backup);
});

it("shows recovery warnings from the skill catalog", async () => {
  const warning = "스킬 백업이 여러 개이거나 출처를 확인할 수 없어 자동 복구하지 않았습니다.";
  state.get.mockResolvedValue({
    _tag: "Success",
    value: {
      providers: [],
      instances: [],
      entries: [],
      recoveryWarnings: [warning],
    },
  });
  const render = () => {
    hooks.beginRender();
    return ExtensionsSection({
      environmentId: EnvironmentId.make("test"),
      workspaceRoot: "D:/isolated",
    }) as ReactElement<Record<string, unknown>>;
  };
  const refresh = visitElements(
    render().props.action,
    (element) => typeof element.props.onClick === "function",
  );
  (refresh!.props.onClick as () => void)();
  await vi.waitFor(() => expect(state.get).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(visitElements(render(), (element) => element.props.role === "alert")?.props.children).toBe(
    warning,
  );
});
