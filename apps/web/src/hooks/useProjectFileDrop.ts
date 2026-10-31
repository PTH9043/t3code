import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  scopeProjectRef,
  scopedProjectKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type DesktopFileDrop,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { readThreadShells, useProjects } from "../state/entities";
import { useWorkspaceTabStore, type ChatWorkspaceTabView } from "../workspaceTabStore";
import { resolveControlCenterChatView } from "../components/control-center/controlCenterNavigation";
import { navigateToTabView } from "../components/tabs/navigateToTabView";
import { toastManager } from "../components/ui/toast";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useProjectFileDropStore, type FileDropTarget } from "../projectFileDropStore";
import {
  FILE_DROP_PROJECT_TARGET,
  FILE_DROP_CHAT_TARGET,
  deliverNativeFilesToChat,
  nativeFileDropTargetAt,
} from "../lib/nativeFileDrop";

const PROJECT_TARGET = FILE_DROP_PROJECT_TARGET;
const CHAT_TARGET = FILE_DROP_CHAT_TARGET;

export function useProjectFileDrop(): void {
  const projects = useProjects();
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  useEffect(() => {
    const queue = (target: FileDropTarget, files: File[]) => {
      if (useProjectFileDropStore.getState().queue(target, files) > 0) {
        toastManager.add({
          type: "warning",
          title: "메시지 하나에 파일을 최대 8개까지 첨부할 수 있습니다.",
        });
      }
    };
    const attachToProject = async (project: ScopedProjectRef, files: File[]) => {
      const params = router.state.matches.at(-1)?.params ?? {};
      const route = resolveThreadRouteTarget(params);
      const currentView: ChatWorkspaceTabView | undefined =
        route?.kind === "server"
          ? {
              kind: "thread",
              environmentId: route.threadRef.environmentId,
              threadId: route.threadRef.threadId,
            }
          : route?.kind === "draft"
            ? { kind: "draft", draftId: route.draftId }
            : undefined;
      const tabs = useWorkspaceTabStore.getState();
      const existingDraft = useComposerDraftStore.getState().getDraftSessionByProjectRef(project);
      const view = resolveControlCenterChatView({
        projectRef: project,
        preferredViews: [
          currentView,
          tabs.lastChatViewByProjectKey[scopedProjectKey(project)],
          existingDraft ? { kind: "draft", draftId: existingDraft.draftId } : undefined,
        ],
        threads: readThreadShells(),
        getDraftProject: (id) => {
          const draft = useComposerDraftStore.getState().getDraftSession(DraftId.make(id));
          return draft ? scopeProjectRef(draft.environmentId, draft.projectId) : null;
        },
      });
      if (view) {
        const target =
          view.kind === "thread"
            ? scopeThreadRef(EnvironmentId.make(view.environmentId), ThreadId.make(view.threadId))
            : DraftId.make(view.draftId);
        queue(target, files);
        navigateToTabView(router.navigate, view);
        return;
      }
      await handleNewThread(project, { reuseExistingDraft: false });
      const created = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
      const draft =
        created?.kind === "draft"
          ? useComposerDraftStore.getState().getDraftSession(created.draftId)
          : null;
      if (
        !draft ||
        draft.environmentId !== project.environmentId ||
        draft.projectId !== project.projectId
      ) {
        throw new Error("첨부할 프로젝트의 대화 초안을 열지 못했습니다. 파일을 다시 놓아 주세요.");
      }
      if (created?.kind === "draft") queue(created.draftId, files);
    };
    const projectAt = (element: Element) => {
      const target = element.closest(PROJECT_TARGET);
      const selected = projects.find(
        (p) =>
          p.id === target?.getAttribute("data-file-drop-project") &&
          p.environmentId === target.getAttribute("data-file-drop-environment"),
      );
      if (!selected || target?.getAttribute("data-file-drop-group") !== "true") return selected;
      const route = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
      const active =
        route?.kind === "draft"
          ? useComposerDraftStore.getState().getDraftSession(route.draftId)
          : route?.kind === "server"
            ? readThreadShells().find(
                (thread) =>
                  thread.id === route.threadRef.threadId &&
                  thread.environmentId === route.threadRef.environmentId,
              )
            : null;
      const current = active
        ? projects.find(
            (project) =>
              project.id === active.projectId && project.environmentId === active.environmentId,
          )
        : undefined;
      return current &&
        deriveLogicalProjectKeyFromSettings(current, grouping) ===
          deriveLogicalProjectKeyFromSettings(selected, grouping)
        ? current
        : selected;
    };
    const receiveProject = (element: Element, files: File[]) => {
      const project = projectAt(element);
      if (!project) return false;
      void attachToProject(scopeProjectRef(project.environmentId, project.id), files).catch(
        (error: unknown) => {
          toastManager.add({
            type: "error",
            title: "파일을 첨부하지 못했습니다.",
            description: error instanceof Error ? error.message : "다시 첨부하세요.",
          });
        },
      );
      return true;
    };
    const dragover = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      if (
        event.target instanceof Element &&
        event.target.closest(PROJECT_TARGET + "," + CHAT_TARGET)
      )
        event.dataTransfer.dropEffect = "copy";
      else event.dataTransfer.dropEffect = "none";
    };
    const drop = (event: DragEvent) => {
      if (
        !event.dataTransfer?.types.includes("Files") ||
        !(event.target instanceof Element) ||
        !event.target.closest(PROJECT_TARGET)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      receiveProject(event.target, Array.from(event.dataTransfer.files));
    };
    const unhandledDrop = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      toastManager.add({
        type: "info",
        title: "파일은 대화 화면이나 왼쪽 프로젝트에 놓아 주세요.",
      });
    };
    const nativeDrop = (payload: DesktopFileDrop) => {
      const report = window.desktopBridge?.reportFileDropStatus;
      const received = {
        stage: "renderer.received" as const,
        fileCount: Math.min(payload.files.length, 8),
        point: {
          x: Math.round(payload.x),
          y: Math.round(payload.y),
          width: window.innerWidth,
          height: window.innerHeight,
          source: payload.pointSource ?? "payload",
        },
      };
      report?.(received);
      if (payload.targetUrl !== window.location.href) {
        report?.({
          stage: "renderer.rejected",
          fileCount: payload.files.length,
          reason: "route-changed",
        });
        toastManager.add({
          type: "info",
          title: "화면이 바뀌어 파일을 첨부하지 않았습니다. 원하는 프로젝트에 다시 놓아 주세요.",
        });
        return;
      }
      if (payload.error)
        toastManager.add({
          type: "warning",
          title: "일부 파일을 첨부하지 못했습니다.",
          description: payload.error,
        });
      const element = nativeFileDropTargetAt(document, payload.x, payload.y);
      if (!element || payload.files.length === 0) {
        report?.({
          stage: "renderer.rejected",
          fileCount: payload.files.length,
          reason:
            payload.files.length === 0 ? (payload.error ? "read-error" : "no-files") : "no-target",
        });
        if (!element && payload.files.length > 0)
          toastManager.add({
            type: "info",
            title:
              "파일을 놓은 위치를 찾지 못했습니다. 대화 입력창이나 왼쪽 프로젝트에 다시 놓아 주세요.",
          });
        return;
      }
      const files = payload.files.map(
        (file) => new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
      );
      if (receiveProject(element, files)) {
        report?.({ stage: "renderer.queued", fileCount: files.length, reason: "project" });
        return;
      }
      const chat = element.closest(CHAT_TARGET);
      if (chat && deliverNativeFilesToChat(chat, files)) {
        report?.({ stage: "renderer.queued", fileCount: files.length, reason: "chat" });
        return;
      }
      const route = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
      if (chat && route) {
        const target = route.kind === "draft" ? route.draftId : route.threadRef;
        queue(target, files);
        report?.({ stage: "renderer.queued", fileCount: files.length, reason: "chat" });
      } else {
        report?.({ stage: "renderer.rejected", fileCount: files.length, reason: "no-target" });
        toastManager.add({
          type: "info",
          title: "파일은 대화 화면이나 왼쪽 프로젝트에 놓아 주세요.",
        });
      }
    };
    window.addEventListener("dragover", dragover);
    window.addEventListener("drop", drop, true);
    window.addEventListener("drop", unhandledDrop);
    const unsubscribe = window.desktopBridge?.onFilesDropped?.(nativeDrop);
    return () => {
      window.removeEventListener("dragover", dragover);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("drop", unhandledDrop);
      unsubscribe?.();
    };
  }, [handleNewThread, projects, router, grouping]);
}
