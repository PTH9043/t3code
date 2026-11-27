import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { useNavigate } from "@tanstack/react-router";

import type { WorkspaceTabView } from "~/workspaceTabStore";

/**
 * The router's navigate is route-literal typed, so the view union has to be
 * unfolded case by case rather than through a generic location object.
 */
export function navigateToTabView(
  navigate: ReturnType<typeof useNavigate>,
  view: WorkspaceTabView,
  options?: { readonly replace?: boolean },
): void {
  const replace = options?.replace ?? false;
  switch (view.kind) {
    case "upgrade-room":
      void navigate({ to: "/upgrade-room", replace });
      return;
    case "thread":
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: view.environmentId as EnvironmentId,
          threadId: view.threadId as ThreadId,
        },
        replace,
      });
      return;
    case "draft":
      void navigate({ to: "/draft/$draftId", params: { draftId: view.draftId }, replace });
      return;
    case "control-center":
      void navigate({
        to: "/control-center/$environmentId/$projectId",
        params: { environmentId: view.environmentId, projectId: view.projectId },
        replace,
      });
  }
}
