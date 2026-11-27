import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { readThreadShell, useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  isUpgradeRoomWorkspaceRoot,
  UPGRADE_ROOM_THREAD_ID,
  UPGRADE_ROOM_TITLE,
} from "../chat/upgradeRoomOfflineWork";

export function findUpgradeRoomProject<
  P extends Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
>(projects: ReadonlyArray<P>, primary: EnvironmentId | null): P | null {
  if (primary === null) return null;
  return (
    projects.find(
      (project) =>
        project.environmentId === primary && isUpgradeRoomWorkspaceRoot(project.workspaceRoot),
    ) ?? null
  );
}

/**
 * Opens the ordinary primary thread `autousage-upgrade-room`, creating it in the
 * D:/__NewAutoUsage project on first use. `open` resolves false when it cannot.
 */
export function useUpgradeRoomThreadOpener() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const project = useMemo(
    () => findUpgradeRoomProject(projects, primaryEnvironmentId),
    [primaryEnvironmentId, projects],
  );
  const inFlight = useRef(false);
  const open = useCallback(async (): Promise<boolean> => {
    if (project === null || inFlight.current) return project !== null;
    inFlight.current = true;
    try {
      const threadId = ThreadId.make(UPGRADE_ROOM_THREAD_ID);
      const threadRef = scopeThreadRef(project.environmentId, threadId);
      if (readThreadShell(threadRef) === null) {
        const modelSelection = resolveDefaultProviderModelSelection(
          providers,
          project.defaultModelSelection,
        );
        if (modelSelection === null) return false;
        const result = await createThread({
          environmentId: project.environmentId,
          input: {
            threadId,
            projectId: project.id,
            title: UPGRADE_ROOM_TITLE,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        });
        if (result._tag === "Failure") return false;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
      return true;
    } catch {
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [createThread, navigate, project, providers]);
  return { available: project !== null, open };
}
