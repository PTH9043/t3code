import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkspaceCollaborationRunId,
} from "@t3tools/contracts";
import type { WorkspaceCollaborationRun } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useRef: reactHookHarness.useRef };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { workspaceAgentControl: () => null },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, refresh: () => {} }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("./ThreadCharacter", () => ({ ThreadCharacter: () => null }));

import { WorkspaceAgentControlPanel } from "./WorkspaceAgentControlPanel";
import { ThreadCharacter } from "./ThreadCharacter";

it("binds the character selector to the selected worker's own conversation and status", () => {
  const environmentId = EnvironmentId.make("environment");
  const run = {
    id: WorkspaceCollaborationRunId.make("run"),
    projectId: ProjectId.make("project"),
    status: "running",
    graph: {
      nodes: [
        { id: "one", title: "first", status: "running", threadId: ThreadId.make("thread-one") },
        { id: "two", title: "second", status: "queued", threadId: ThreadId.make("thread-two") },
      ],
    },
  } as unknown as WorkspaceCollaborationRun;
  hooks.reset();
  hooks.beginRender();
  const closed = WorkspaceAgentControlPanel({ environmentId, run });
  const button = visitElements(closed, (element) => element.type === "button");
  (button!.props.onClick as () => void)();
  hooks.beginRender();
  const open = WorkspaceAgentControlPanel({ environmentId, run });
  const mailbox = visitElements(
    open,
    (element) => typeof element.type === "function" && element.type.name === "Mailbox",
  );
  expect(mailbox).toBeDefined();
  hooks.reset();
  const renderMailbox = () => {
    hooks.beginRender();
    return (mailbox!.type as (props: unknown) => ReturnType<typeof WorkspaceAgentControlPanel>)(
      mailbox!.props,
    );
  };
  const first = renderMailbox();
  expect(visitElements(first, (element) => element.type === ThreadCharacter)?.props).toMatchObject({
    environmentId,
    threadId: "thread-one",
    isWorking: true,
  });
  const select = visitElements(first, (element) => element.type === "select");
  (select!.props.onChange as (event: unknown) => void)({ currentTarget: { value: "two" } });
  expect(
    visitElements(renderMailbox(), (element) => element.type === ThreadCharacter)?.props,
  ).toMatchObject({
    environmentId,
    threadId: "thread-two",
    isWorking: false,
  });
});
