import { createFileRoute } from "@tanstack/react-router";
import { useSyncWorkspaceTabRoute } from "../components/tabs/WorkspaceTabsHost";
import { upgradeRoomTabView } from "../components/tabs/openUpgradeRoomWorkspaceTab";
import { MAX_WORKSPACE_TABS, useWorkspaceTabs } from "../workspaceTabStore";

export const Route = createFileRoute("/upgrade-room")({ component: UpgradeRoomRoute });

function UpgradeRoomRoute() {
  const desktop = typeof window !== "undefined" && !!window.desktopBridge?.upgradeRoomTab;
  const tabs = useWorkspaceTabs();
  const full =
    tabs.length >= MAX_WORKSPACE_TABS && !tabs.some((tab) => tab.view.kind === "upgrade-room");
  useSyncWorkspaceTabRoute(desktop && !full ? upgradeRoomTabView : null);
  if (!desktop) return <p className="p-4">이 PC의 데스크톱 앱에서 업그레이드 방을 열어 주세요.</p>;
  if (full) {
    return <p className="p-4">다른 탭을 닫은 뒤 업그레이드 방을 열어 주세요.</p>;
  }
  return null;
}
