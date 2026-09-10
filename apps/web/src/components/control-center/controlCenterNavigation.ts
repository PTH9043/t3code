import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef } from "@t3tools/contracts";

import type { ChatWorkspaceTabView } from "~/workspaceTabStore";

type ReturnThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "projectId" | "archivedAt" | "orchestraRunThreadId" | "updatedAt"
>;

/** Resolve a valid conversation inside this control center's project. */
export function resolveControlCenterChatView(input: {
  readonly projectRef: ScopedProjectRef;
  readonly preferredViews: ReadonlyArray<ChatWorkspaceTabView | null | undefined>;
  readonly threads: ReadonlyArray<ReturnThread>;
  readonly getDraftProject: (draftId: string) => ScopedProjectRef | null;
}): ChatWorkspaceTabView | null {
  const belongsToProject = (candidate: ScopedProjectRef) =>
    candidate.environmentId === input.projectRef.environmentId &&
    candidate.projectId === input.projectRef.projectId;
  const threads = input.threads.filter(
    (thread) =>
      belongsToProject(thread) &&
      thread.archivedAt === null &&
      (thread.orchestraRunThreadId ?? null) === null,
  );

  for (const view of input.preferredViews) {
    if (!view) continue;
    if (view.kind === "thread") {
      if (
        threads.some(
          (thread) => thread.id === view.threadId && thread.environmentId === view.environmentId,
        )
      ) {
        return view;
      }
    } else {
      const project = input.getDraftProject(view.draftId);
      if (project !== null && belongsToProject(project)) return view;
    }
  }

  // Direct links and older saved tabs may have no project-specific history.
  // An empty project returns null so the caller opens a draft in that project.
  const latest = threads.reduce<ReturnThread | null>(
    (previous, thread) =>
      previous === null || thread.updatedAt > previous.updatedAt ? thread : previous,
    null,
  );
  return latest === null
    ? null
    : { kind: "thread", environmentId: latest.environmentId, threadId: latest.id };
}
