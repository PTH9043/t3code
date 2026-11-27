import * as Schema from "effect/Schema";
import { WrenchIcon } from "lucide-react";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { getLocalStorageItem, useLocalStorage } from "../../hooks/useLocalStorage";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { MenuItem, MenuSeparator } from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { useUpgradeRoomThreadOpener } from "./useUpgradeRoomThreadOpener";

type ShortcutFolder = Pick<SidebarProjectSnapshot, "id" | "environmentId" | "environmentPresence">;
const storedShortcut = Schema.NullOr(Schema.Literal(true));

function canOpenLocalUpgradeRoom() {
  if (typeof window === "undefined" || !window.desktopBridge?.upgradeRoomTab) return false;
  const { protocol, hostname } = window.location;
  return (
    ((protocol === "t3code:" || protocol === "t3code-dev:") && hostname === "app") ||
    ((protocol === "http:" || protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(hostname))
  );
}

export function upgradeRoomFolderKey(
  project: ShortcutFolder | null,
  primary: EnvironmentId | null,
) {
  if (
    !project ||
    !primary ||
    project.environmentId !== primary ||
    project.environmentPresence !== "local-only" ||
    !canOpenLocalUpgradeRoom()
  )
    return null;
  return "t3code:upgrade-room-shortcut:" + JSON.stringify([primary, project.id]);
}

export function hasUpgradeRoomFolderShortcut(
  project: ShortcutFolder,
  primary: EnvironmentId | null,
) {
  const key = upgradeRoomFolderKey(project, primary);
  try {
    return key !== null && getLocalStorageItem(key, storedShortcut) === true;
  } catch {
    return false;
  }
}

export function useUpgradeRoomFolderShortcut(
  project: ShortcutFolder | null,
  primary: EnvironmentId | null,
) {
  const key = upgradeRoomFolderKey(project, primary);
  const [value, setValue] = useLocalStorage(
    key ?? "t3code:upgrade-room-shortcut:unavailable",
    null,
    storedShortcut,
  );
  const linked = key !== null && value === true;
  return {
    available: key !== null,
    linked,
    label: linked ? "업그레이드 방 연결 해제" : "업그레이드 방 추가",
    setLinked: (next: boolean) => {
      if (key !== null) setValue(next ? true : null);
    },
  };
}

export function UpgradeRoomMenuItem({
  variant = "sidebar",
  separate = false,
}: { variant?: "sidebar" | "project-picker"; separate?: boolean } = {}) {
  const upgradeRoom = useUpgradeRoomThreadOpener();
  const [failed, setFailed] = useState(false);
  if (!upgradeRoom.available) return null;
  const label = (
    <>
      <WrenchIcon />
      <span>AutoUsage 업그레이드 방</span>
    </>
  );
  if (variant === "project-picker") {
    return (
      <>
        <MenuItem
          onClick={(event) => {
            if (!event.isTrusted) return;
            void upgradeRoom.open().then((opened) => {
              if (!opened) {
                toastManager.add({ type: "warning", title: "업그레이드 방 탭을 열 수 없습니다." });
              }
            });
          }}
        >
          {label}
        </MenuItem>
        {separate && <MenuSeparator />}
      </>
    );
  }
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={(event) => {
          if (event.isTrusted) void upgradeRoom.open().then((opened) => setFailed(!opened));
        }}
      >
        {label}
      </SidebarMenuButton>
      {failed && (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          업그레이드 방 탭을 열 수 없습니다.
        </p>
      )}
    </SidebarMenuItem>
  );
}
