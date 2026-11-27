import { useRouter } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useMeetingComposerStore } from "../../meetingComposerStore";
import { readThreadShell } from "../../state/entities";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useWorkspaceTabStore, workspaceTabViewKey } from "../../workspaceTabStore";
import { navigateToTabView } from "../tabs/navigateToTabView";
import { Button } from "../ui/button";

export function DraftDiscardButton({
  draftId,
  threadRef,
  disabled,
  isSending,
}: {
  draftId: DraftId;
  threadRef: ScopedThreadRef;
  disabled: boolean;
  isSending: () => boolean;
}) {
  const router = useRouter();
  function discard() {
    const route = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    if (route?.kind !== "draft" || route.draftId !== draftId) return;
    const store = useComposerDraftStore.getState();
    const session = store.getDraftSession(draftId);
    if (
      disabled ||
      isSending() ||
      !session ||
      session.promotedTo ||
      session.threadId !== threadRef.threadId ||
      session.environmentId !== threadRef.environmentId ||
      readThreadShell(threadRef) !== null
    )
      return;

    const viewKey = workspaceTabViewKey({ kind: "draft", draftId });
    const tabs = useWorkspaceTabStore.getState();
    tabs.closeTabsForView(viewKey);
    store.clearDraftThread(draftId);
    useMeetingComposerStore.setState((state) => {
      if (!(viewKey in state.configsByFolder)) return state;
      const configsByFolder = { ...state.configsByFolder };
      delete configsByFolder[viewKey];
      return { configsByFolder };
    });
    const remaining = useWorkspaceTabStore.getState();
    const next = remaining.tabs.find((tab) => tab.id === remaining.activeTabId);
    if (next) navigateToTabView(router.navigate, next.view, { replace: true });
    else void router.navigate({ to: "/", replace: true });
  }

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="shrink-0 [-webkit-app-region:no-drag]"
      disabled={disabled}
      onClick={discard}
    >
      초안 버리기
    </Button>
  );
}
