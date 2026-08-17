import { createFileRoute } from "@tanstack/react-router";

import { useSyncWorkspaceTabRoute } from "../components/tabs/WorkspaceTabsHost";

/**
 * Thin on purpose: the URL names the screen and the workspace tab layer
 * renders it (see WorkspaceTabsHost and DraftTabPane, which owns promotion
 * and cleanup for both foreground and background tabs).
 */
function DraftChatThreadRouteView() {
  const { draftId } = Route.useParams();
  useSyncWorkspaceTabRoute({ kind: "draft", draftId });
  return null;
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
