import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import type { AgentNotificationTarget } from "./notificationPayload";

export interface ActiveAgentNotificationScope {
  readonly environmentId: string;
  readonly threadId: string | null;
  readonly projectId: string | null;
}

export type AgentNotificationThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "projectId"
>;

function decodePathSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function projectIdForThread(
  threads: ReadonlyArray<AgentNotificationThread>,
  environmentId: string,
  threadId: string,
): string | null {
  return (
    threads.find(
      (thread) => String(thread.environmentId) === environmentId && String(thread.id) === threadId,
    )?.projectId ?? null
  );
}

export function resolveActiveAgentNotificationScope(input: {
  readonly pathname: string;
  readonly threads: ReadonlyArray<AgentNotificationThread>;
}): ActiveAgentNotificationScope | null {
  const segments = input.pathname.split("/").filter(Boolean);
  if (segments[0] === "threads") {
    const environmentId = decodePathSegment(segments[1]);
    const threadId = decodePathSegment(segments[2]);
    if (environmentId === null || threadId === null) return null;
    return {
      environmentId,
      threadId,
      projectId: projectIdForThread(input.threads, environmentId, threadId),
    };
  }
  if (segments[0] === "workspaces" && segments[3] === "collaboration") {
    const environmentId = decodePathSegment(segments[1]);
    const projectId = decodePathSegment(segments[2]);
    if (environmentId === null || projectId === null) return null;
    return { environmentId, threadId: null, projectId };
  }
  return null;
}

/** Foreground alerts stay quiet for the exact conversation or project already on screen. */
export function shouldPresentAgentNotification(input: {
  readonly target: AgentNotificationTarget | null;
  readonly activeScope: ActiveAgentNotificationScope | null;
  readonly threads: ReadonlyArray<AgentNotificationThread>;
}): boolean {
  if (input.target === null || input.activeScope === null) return true;
  if (input.target.environmentId !== input.activeScope.environmentId) return true;
  if (input.target.threadId === input.activeScope.threadId) return false;
  if (input.activeScope.projectId === null) return true;
  return (
    projectIdForThread(input.threads, input.target.environmentId, input.target.threadId) !==
    input.activeScope.projectId
  );
}
