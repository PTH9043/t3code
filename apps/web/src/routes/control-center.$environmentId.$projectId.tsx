import { createFileRoute } from "@tanstack/react-router";

import { useSyncWorkspaceTabRoute } from "~/components/tabs/WorkspaceTabsHost";

/**
 * Thin on purpose: the URL names the screen and the workspace tab layer
 * renders it (see WorkspaceTabsHost and ControlCenterTabPane). The layout
 * route's own header still renders for the non-tab overview at
 * /control-center; for this route the pane brings its own.
 */
function WorkspaceControlCenterRoute() {
  const params = Route.useParams();
  useSyncWorkspaceTabRoute({
    kind: "control-center",
    environmentId: params.environmentId,
    projectId: params.projectId,
  });
  return null;
}

export const Route = createFileRoute("/control-center/$environmentId/$projectId")({
  component: WorkspaceControlCenterRoute,
});
