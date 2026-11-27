import * as Schema from "effect/Schema";
import { WorkspaceCollaborationRunId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import {
  resolveControlCenterTabSearch,
  type ControlCenterDomainId,
  type ControlCenterSectionId,
} from "~/components/control-center/WorkspaceSectionNav";
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

const validId = Schema.is(WorkspaceCollaborationRunId);

export interface ControlCenterProjectSearch {
  knowledgeRun?: string;
  domain?: ControlCenterDomainId;
  section?: ControlCenterSectionId;
}

export const Route = createFileRoute("/control-center/$environmentId/$projectId")({
  validateSearch: (search): ControlCenterProjectSearch => {
    const next: ControlCenterProjectSearch = {};
    if (validId(search.knowledgeRun)) {
      next.knowledgeRun = search.knowledgeRun;
    }
    const resolved = resolveControlCenterTabSearch(search);
    if (resolved.domain) next.domain = resolved.domain;
    if (resolved.section) next.section = resolved.section;
    return next;
  },
  component: WorkspaceControlCenterRoute,
});
