import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveControlCenterChatView } from "./controlCenterNavigation";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("onchain");
const projectRef = { environmentId, projectId };
type Input = Parameters<typeof resolveControlCenterChatView>[0];
const thread = (id: string, overrides: Partial<Input["threads"][number]> = {}) => ({
  ...projectRef,
  id: ThreadId.make(id),
  updatedAt: "2026-09-11T00:00:00.000Z",
  archivedAt: null,
  orchestraRunThreadId: null,
  ...overrides,
});
const view = (threadId: string, environment = environmentId) => ({
  kind: "thread" as const,
  threadId,
  environmentId: environment,
});
const resolve = (overrides: Partial<Input> = {}) =>
  resolveControlCenterChatView({
    projectRef,
    preferredViews: [],
    threads: [],
    getDraftProject: () => null,
    ...overrides,
  });

describe("control center return navigation", () => {
  it("returns to OnChainBot's visited conversation after another project was visited", () => {
    expect(
      resolve({
        preferredViews: [view("visited"), view("other")],
        threads: [
          thread("other", { projectId: ProjectId.make("other") }),
          thread("newer", { updatedAt: "2026-09-11T01:00:00.000Z" }),
          thread("visited"),
        ],
      }),
    ).toEqual(view("visited"));
  });

  it("falls back to this project's most recent conversation for a direct link", () => {
    expect(
      resolve({
        preferredViews: [view("other")],
        threads: [
          thread("other", { projectId: ProjectId.make("other") }),
          thread("older"),
          thread("newer", { updatedAt: "2026-09-11T01:00:00.000Z" }),
        ],
      }),
    ).toEqual(view("newer"));
  });

  it("does not cross environments even when project and thread IDs match", () => {
    const remote = EnvironmentId.make("remote");
    expect(
      resolve({
        preferredViews: [view("same", remote)],
        threads: [thread("same", { environmentId: remote }), thread("local-work")],
      }),
    ).toEqual(view("local-work"));
  });

  it("ignores deleted, archived and legacy worker conversations", () => {
    expect(
      resolve({
        preferredViews: [view("deleted"), view("archived"), view("worker")],
        threads: [
          thread("archived", { archivedAt: "2026-09-11T01:00:00.000Z" }),
          thread("worker", { orchestraRunThreadId: ThreadId.make("owner") }),
          thread("available"),
        ],
      }),
    ).toEqual(view("available"));
  });

  it("restores a draft only if it still belongs to this project and environment", () => {
    const draft = { kind: "draft" as const, draftId: "draft" };
    expect(resolve({ preferredViews: [draft], getDraftProject: () => projectRef })).toEqual(draft);
    expect(
      resolve({
        preferredViews: [draft],
        getDraftProject: () => ({ ...projectRef, projectId: ProjectId.make("other") }),
      }),
    ).toBeNull();
    expect(
      resolve({
        preferredViews: [draft],
        getDraftProject: () => ({ ...projectRef, environmentId: EnvironmentId.make("remote") }),
      }),
    ).toBeNull();
  });

  it("asks for a project draft when no valid conversation remains", () => {
    expect(
      resolve({ preferredViews: [view("other"), { kind: "draft", draftId: "deleted" }] }),
    ).toBeNull();
  });
});
