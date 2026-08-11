import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveActiveAgentNotificationScope,
  shouldPresentAgentNotification,
  type AgentNotificationThread,
} from "./notificationPresentation";

const threads: ReadonlyArray<AgentNotificationThread> = [
  {
    environmentId: EnvironmentId.make("env-1"),
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
  },
  {
    environmentId: EnvironmentId.make("env-1"),
    id: ThreadId.make("thread-2"),
    projectId: ProjectId.make("project-1"),
  },
  {
    environmentId: EnvironmentId.make("env-1"),
    id: ThreadId.make("thread-3"),
    projectId: ProjectId.make("project-2"),
  },
];

describe("foreground agent notification presentation", () => {
  it("resolves the active project through a conversation route", () => {
    expect(
      resolveActiveAgentNotificationScope({
        pathname: "/threads/env-1/thread-1/terminal",
        threads,
      }),
    ).toEqual({ environmentId: "env-1", threadId: "thread-1", projectId: "project-1" });
  });

  it("resolves a project operations route without a conversation", () => {
    expect(
      resolveActiveAgentNotificationScope({
        pathname: "/workspaces/env-1/project-1/collaboration",
        threads,
      }),
    ).toEqual({ environmentId: "env-1", threadId: null, projectId: "project-1" });
  });

  it("suppresses the active conversation and sibling conversations in the active project", () => {
    const activeScope = resolveActiveAgentNotificationScope({
      pathname: "/threads/env-1/thread-1",
      threads,
    });

    expect(
      shouldPresentAgentNotification({
        target: { environmentId: "env-1", threadId: "thread-1" },
        activeScope,
        threads,
      }),
    ).toBe(false);
    expect(
      shouldPresentAgentNotification({
        target: { environmentId: "env-1", threadId: "thread-2" },
        activeScope,
        threads,
      }),
    ).toBe(false);
  });

  it("keeps alerts for another project, environment, or unrelated notification", () => {
    const activeScope = resolveActiveAgentNotificationScope({
      pathname: "/workspaces/env-1/project-1/collaboration",
      threads,
    });

    expect(
      shouldPresentAgentNotification({
        target: { environmentId: "env-1", threadId: "thread-3" },
        activeScope,
        threads,
      }),
    ).toBe(true);
    expect(
      shouldPresentAgentNotification({
        target: { environmentId: "env-2", threadId: "thread-1" },
        activeScope,
        threads,
      }),
    ).toBe(true);
    expect(shouldPresentAgentNotification({ target: null, activeScope, threads })).toBe(true);
  });
});
