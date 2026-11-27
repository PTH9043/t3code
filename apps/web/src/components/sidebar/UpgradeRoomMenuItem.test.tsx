import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  hasUpgradeRoomFolderShortcut,
  UpgradeRoomMenuItem,
  useUpgradeRoomFolderShortcut,
} from "./UpgradeRoomMenuItem";

const { button, menuItem, open, opener } = vi.hoisted(() => ({
  button: vi.fn<(props: { onClick: (event: { isTrusted: boolean }) => void }) => null>(() => null),
  menuItem: vi.fn<(props: { onClick: (event: { isTrusted: boolean }) => void }) => null>(
    () => null,
  ),
  open: vi.fn(() => Promise.resolve(true)),
  opener: { available: true },
}));
vi.mock("./useUpgradeRoomThreadOpener", () => ({
  useUpgradeRoomThreadOpener: () => ({ available: opener.available, open }),
}));
vi.mock("../ui/sidebar", () => ({
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: button,
}));
vi.mock("../ui/menu", () => ({ MenuItem: menuItem, MenuSeparator: () => <hr /> }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const primary = EnvironmentId.make("local");
const one = {
  id: ProjectId.make("one"),
  environmentId: primary,
  environmentPresence: "local-only",
} as const;
const two = { ...one, id: ProjectId.make("two") };
function stubWindow(url: string, desktop = true) {
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      location: new URL(url),
      desktopBridge: desktop ? { upgradeRoomTab: {} } : undefined,
    }),
  );
}
type Folder = Parameters<typeof useUpgradeRoomFolderShortcut>[0];
function mount(folder: Folder, env: EnvironmentId | null = primary) {
  let current!: ReturnType<typeof useUpgradeRoomFolderShortcut>;
  function List() {
    current = useUpgradeRoomFolderShortcut(folder, env);
    return current.linked ? <UpgradeRoomMenuItem /> : null;
  }
  renderToStaticMarkup(<List />);
  return current;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  opener.available = true;
});

it("persists each folder link across remounts, opens the singleton only on a trusted click and removes only the selected link", () => {
  stubWindow("t3code://app/");
  const menu = mount(one);
  expect(menu.label).toBe("업그레이드 방 추가");
  menu.setLinked(true);
  menu.setLinked(true);
  expect(open).not.toHaveBeenCalled();
  expect(mount(two).linked).toBe(false);
  expect(mount(one).label).toBe("업그레이드 방 연결 해제");
  expect(button).toHaveBeenCalledTimes(1);
  const { onClick } = button.mock.calls[0]![0];
  onClick({ isTrusted: false });
  expect(open).not.toHaveBeenCalled();
  onClick({ isTrusted: true });
  expect(open).toHaveBeenCalledExactlyOnceWith();
  mount(two).setLinked(true);
  mount(one).setLinked(false);
  expect(hasUpgradeRoomFolderShortcut(one, primary)).toBe(false);
  expect(mount(two).linked).toBe(true);
  mount(two).setLinked(false);
  expect(open).toHaveBeenCalledTimes(1);
});

it("shows the folder link on the local development desktop, but not its secondary backend host", () => {
  stubWindow("t3code-dev://app/control-center");
  expect(mount(one).available).toBe(true);
  stubWindow("t3code-dev://wsl-test/control-center");
  expect(mount(one).available).toBe(false);
});

it("offers a direct action in the project picker without linking any folder", async () => {
  stubWindow("t3code-dev://app/control-center");
  expect(hasUpgradeRoomFolderShortcut(one, primary)).toBe(false);
  renderToStaticMarkup(<UpgradeRoomMenuItem variant="project-picker" separate />);
  expect(menuItem).toHaveBeenCalledTimes(1);
  expect(button).not.toHaveBeenCalled();
  const { onClick } = menuItem.mock.calls[0]![0];
  onClick({ isTrusted: false });
  expect(open).not.toHaveBeenCalled();
  onClick({ isTrusted: true });
  expect(open).toHaveBeenCalledExactlyOnceWith();
  expect(hasUpgradeRoomFolderShortcut(one, primary)).toBe(false);

  const { toastManager } = await import("../ui/toast");
  const failed = Promise.resolve(false);
  open.mockReturnValueOnce(failed);
  onClick({ isTrusted: true });
  // The menu's own `.then` was registered first, so it has run once this resolves.
  await failed;
  expect(toastManager.add).toHaveBeenCalledTimes(1);

  // Without the D:/__NewAutoUsage project in the primary environment there is nothing to open.
  opener.available = false;
  expect(renderToStaticMarkup(<UpgradeRoomMenuItem variant="project-picker" />)).toBe("");
  expect(menuItem).toHaveBeenCalledTimes(1);
});

it("hides a saved local link on remote origins, mixed or remote projects, unbound environments and ordinary browsers", () => {
  stubWindow("http://127.0.0.1:12345/");
  mount(one).setLinked(true);
  for (const folder of [
    { ...one, environmentPresence: "mixed" as const },
    {
      ...one,
      environmentId: EnvironmentId.make("remote"),
      environmentPresence: "remote-only" as const,
    },
  ]) {
    expect(mount(folder)).toMatchObject({ available: false, linked: false });
  }
  expect(mount(one, null).available).toBe(false);
  stubWindow("https://remote.example/");
  expect(mount(one)).toMatchObject({ available: false, linked: false });
  stubWindow("http://localhost/", false);
  const hidden = mount(one);
  expect(hidden).toMatchObject({ available: false, linked: false });
  hidden.setLinked(false);
  expect(button).not.toHaveBeenCalled();
  stubWindow("http://localhost/");
  expect(mount(one).linked).toBe(true);
  mount(one).setLinked(false);
});
