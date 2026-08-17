import { createFileRoute } from "@tanstack/react-router";

import { useSyncWorkspaceTabRoute } from "../components/tabs/WorkspaceTabsHost";
import { resolveThreadRouteRef } from "../threadRoutes";

/**
 * Thin on purpose: the URL names the screen and the workspace tab layer
 * renders it (see WorkspaceTabsHost). Keeping rendering out of the route is
 * what lets background tabs stay mounted across navigation.
 */
function ChatThreadRouteView() {
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  useSyncWorkspaceTabRoute(
    threadRef === null
      ? null
      : { kind: "thread", environmentId: threadRef.environmentId, threadId: threadRef.threadId },
  );
  return null;
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
