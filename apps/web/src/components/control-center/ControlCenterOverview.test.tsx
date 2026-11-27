import { Link } from "@tanstack/react-router";
import { isValidElement } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { visitElements } from "~/test/reactElementTree";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { ControlCenterOverview } from "./ControlCenterOverview";

const navigate = vi.fn();
const projects = [
  { environmentId: "local", id: "shared-id", title: "문서", workspaceRoot: "/local/docs" },
  { environmentId: "remote", id: "shared-id", title: "문서", workspaceRoot: "/remote/docs" },
  { environmentId: "remote", id: "tools", title: "도구", workspaceRoot: "/remote/tools" },
];
const environments = [
  { environmentId: "local", label: "로컬" },
  { environmentId: "remote", label: "원격" },
];
vi.mock("~/state/entities", () => ({
  useProjects: () => projects,
  useServerConfigs: () => new Map(),
}));
vi.mock("~/state/environments", () => ({ useEnvironments: () => ({ environments }) }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("react", async (original) => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...(await original<typeof import("react")>()),
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

beforeEach(() => {
  hooks.reset();
  navigate.mockClear();
});

it.each(projects)(
  "keeps the project button and wiki link separate for $workspaceRoot",
  (project) => {
    hooks.beginRender();
    const tree = ControlCenterOverview();
    const row = visitElements(
      tree,
      ({ props }) =>
        Array.isArray(props.children) &&
        props.children.some(
          (child) =>
            isValidElement(child) &&
            child.type === "button" &&
            visitElements(child, (e) => e.props.children === project.workspaceRoot),
        ),
    );
    expect(row).not.toBeNull();
    expect(row!.props.onClick).toBeUndefined();
    const button = visitElements(row, (e) => e.type === "button")!;
    const missionControl = visitElements(
      row,
      (e) => e.type === Link && e.props.children === "자율 운영실",
    )!;
    const wiki = visitElements(row, (e) => e.type === Link && e.props.children === "위키 열기")!;
    expect(visitElements(button, (e) => e.type === Link)).toBeNull();
    expect(button.props.type).toBe("button");
    expect(button.props.tabIndex).toBeUndefined();

    const params = { environmentId: project.environmentId, projectId: project.id };
    (button.props.onClick as () => void)();
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/control-center/$environmentId/$projectId",
      params,
    });
    expect(missionControl.props).toMatchObject({
      to: "/control-center/$environmentId/$projectId",
      params,
      search: { domain: "home", section: "mission-control" },
      children: "자율 운영실",
    });
    expect(wiki.props).toMatchObject({
      to: "/control-center/$environmentId/$projectId/knowledge/manage",
      params,
      children: "위키 열기",
    });
    expect(wiki.props.tabIndex).toBeUndefined();
    expect(wiki.props["aria-label"]).toContain(project.title);
  },
);
