import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BrainCircuitIcon, FolderXIcon } from "lucide-react";
import { useEffect } from "react";

import ChatView from "../ChatView";
import { threadHasStarted } from "../ChatView.logic";
import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { waitForDraftHeroTransition } from "../chat/draftHeroTransition";
import { buildThreadRouteParams } from "../../threadRoutes";
import { resolveThreadSyncPhase } from "../../threadSync";
import {
  useEnvironmentThreadRefs,
  useProjects,
  useThread,
  useThreadDetail,
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRenderState } from "../../threadRoutes";
import {
  useWorkspaceTabStore,
  workspaceTabViewKey,
  type WorkspaceTab,
} from "../../workspaceTabStore";
import { ControlCenterDisplayControls } from "../control-center/ControlCenterDisplayControls";
import { WorkspaceControlCenter } from "../control-center/WorkspaceControlCenter";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

/**
 * The keep-alive body of one workspace tab. Background tabs stay mounted with
 * `display: none` — switching back is instant and their scroll, expansions,
 * streams and composer state all survive — so anything here that navigates or
 * grabs window-level input must first check `active`.
 */
export function WorkspaceTabPane({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const view = tab.view;
  return (
    <div className={active ? "flex h-full min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
      {view.kind === "thread" ? (
        <ThreadTabPane
          key={`${view.environmentId}:${view.threadId}`}
          environmentId={view.environmentId as EnvironmentId}
          threadId={view.threadId as ThreadId}
          active={active}
        />
      ) : view.kind === "draft" ? (
        <DraftTabPane key={view.draftId} draftId={DraftId.make(view.draftId)} active={active} />
      ) : (
        <ControlCenterTabPane
          key={`${view.environmentId}:${view.projectId}`}
          environmentId={view.environmentId}
          projectId={view.projectId}
          active={active}
        />
      )}
    </div>
  );
}

function ThreadTabPane(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  active: boolean;
}) {
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useEnvironmentQuery(environmentShell.stateAtom(threadRef.environmentId));
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef.environmentId);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore(
    (store) => store.getDraftThreadByRef(threadRef) !== null,
  );
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    store.hasDraftThreadsInEnvironment(threadRef.environmentId),
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  useEffect(() => {
    if (!bootstrapComplete || renderState !== "missing" || !environmentHasAnyThreads) {
      return;
    }
    if (props.active) {
      void navigate({ to: "/", replace: true });
      return;
    }
    // A deleted thread in a background tab just takes its tab with it.
    useWorkspaceTabStore.getState().closeTabsForView(
      workspaceTabViewKey({
        kind: "thread",
        environmentId: props.environmentId,
        threadId: props.threadId,
      }),
    );
  }, [
    bootstrapComplete,
    environmentHasAnyThreads,
    navigate,
    props.active,
    props.environmentId,
    props.threadId,
    renderState,
  ]);

  useEffect(() => {
    if (!serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      {renderState === "ready" || (renderState === "loading" && serverThreadShell !== null) ? (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          threadSyncPhase={threadSyncPhase}
          isForeground={props.active}
        />
      ) : null}
    </SidebarInset>
  );
}

function DraftTabPane(props: { draftId: DraftId; active: boolean }) {
  const navigate = useNavigate();
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(props.draftId));
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef = draftSession?.promotedTo ?? inferredThreadRef;
  const serverThread = useThread(serverThreadRef);
  const serverThreadStarted = threadHasStarted(serverThread);
  const canonicalThreadRef = serverThreadStarted ? serverThreadRef : null;

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    const draftViewKey = workspaceTabViewKey({ kind: "draft", draftId: props.draftId });
    if (!props.active) {
      // Promotion in a background tab retargets the tab without navigating.
      useWorkspaceTabStore.getState().retargetTabView(draftViewKey, {
        kind: "thread",
        environmentId: canonicalThreadRef.environmentId,
        threadId: canonicalThreadRef.threadId,
      });
      return;
    }

    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate, props.active, props.draftId]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    if (props.active) {
      void navigate({ to: "/", replace: true });
      return;
    }
    useWorkspaceTabStore
      .getState()
      .closeTabsForView(workspaceTabViewKey({ kind: "draft", draftId: props.draftId }));
  }, [canonicalThreadRef, draftSession, navigate, props.active, props.draftId]);

  if (!draftSession) {
    return null;
  }

  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ChatView
        draftId={props.draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
        forceExpandedMobileComposer
        isForeground={props.active}
      />
    </SidebarInset>
  );
}

function ControlCenterTabPane(props: {
  environmentId: string;
  projectId: string;
  active: boolean;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const project =
    projects.find(
      (candidate) =>
        candidate.environmentId === props.environmentId && candidate.id === props.projectId,
    ) ?? null;

  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "workspace-topbar border-b border-border/60 px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex w-full items-center gap-2">
            <BrainCircuitIcon className="size-4 text-primary" />
            <span className="text-sm font-medium text-foreground">AI 제어센터</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              사용자 명령 우선 · 폴더별 완전 격리
            </span>
            <ControlCenterDisplayControls />
          </div>
        </header>
        {project === null ? (
          <main className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="max-w-md text-center">
              <FolderXIcon className="mx-auto size-10 text-muted-foreground" />
              <h1 className="mt-4 text-lg font-semibold">프로젝트를 찾을 수 없습니다.</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                해당 폴더가 삭제되었거나 현재 환경의 동기화가 아직 끝나지 않았습니다.
              </p>
              <Button
                className="mt-5"
                onClick={() => {
                  if (props.active) void navigate({ to: "/control-center" });
                }}
              >
                전체 현황으로 이동
              </Button>
            </div>
          </main>
        ) : (
          <WorkspaceControlCenter
            key={`${project.environmentId}:${project.id}`}
            project={project}
          />
        )}
      </div>
    </SidebarInset>
  );
}
