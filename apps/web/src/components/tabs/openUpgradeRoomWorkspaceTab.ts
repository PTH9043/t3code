import type { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";
import { randomUUID } from "../../lib/utils";
import { useWorkspaceTabStore } from "../../workspaceTabStore";

export const upgradeRoomTabView = { kind: "upgrade-room" } as const;
type ConnectionRequest = { request: Promise<boolean> | null };
export const useUpgradeRoomConnection = create<ConnectionRequest>(() => ({ request: null }));
let owner: string | undefined;
export function upgradeRoomViewOwner() {
  return (owner ??= randomUUID());
}

/** Start IPC inside the original click, before the router mounts the destination. */
export function connectUpgradeRoomView() {
  const bridge = window.desktopBridge?.upgradeRoomTab;
  if (!bridge) return;
  useUpgradeRoomConnection.setState({
    request: bridge.open(upgradeRoomViewOwner()).catch(() => false),
  });
}

export function openUpgradeRoomWorkspaceTab(navigate: ReturnType<typeof useNavigate>): boolean {
  if (!window.desktopBridge?.upgradeRoomTab) return false;
  const store = useWorkspaceTabStore.getState();
  if (!store.openBackgroundTab(upgradeRoomTabView)) return false;
  connectUpgradeRoomView();
  store.syncRouteView(upgradeRoomTabView);
  void navigate({ to: "/upgrade-room" });
  return true;
}
