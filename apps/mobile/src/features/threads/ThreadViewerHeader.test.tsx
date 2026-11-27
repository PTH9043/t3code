import type {
  NativeStackHeaderItemButton,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";
import type { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { ThreadRouteScreen } from "./ThreadRouteScreen";

const { renderToStaticMarkup } = await vi.importActual<{
  renderToStaticMarkup(node: ReactNode): string;
}>("react-dom/server");
const ui = vi.hoisted(() => ({
  os: "ios",
  split: false,
  paneWidth: 390,
  inspector: false,
  glass: false,
  orchestra: false,
  monitoring: false,
  workspace: false,
  room: "room-a",
  native: vi.fn(),
  toolbar: vi.fn(),
  androidMenu: vi.fn(),
  press: new Map<string, () => void>(),
  navigate: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return ui.os;
    },
  },
  View: "div",
  ScrollView: "div",
  Pressable: (p: { accessibilityLabel?: string; onPress?: () => void; children?: ReactNode }) => {
    if (p.accessibilityLabel && p.onPress) ui.press.set(p.accessibilityLabel, p.onPress);
    return <button aria-label={p.accessibilityLabel}>{p.children}</button>;
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ canGoBack: () => true, navigate: ui.navigate }),
  useFocusEffect: () => {},
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("../../native/native-glass", () => ({
  get NATIVE_LIQUID_GLASS_SUPPORTED() {
    return ui.glass;
  },
}));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: (p: { options: unknown }) => {
    ui.native(p.options);
    return null;
  },
  NativeHeaderToolbar: ui.toolbar,
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#000" }));
vi.mock("expo-haptics", () => ({}));
vi.mock("@react-native-menu/menu", () => ({}));
vi.mock("../../components/AndroidAnchoredMenu", () => ({
  AndroidAnchoredMenu: (p: ComponentProps<typeof AndroidAnchoredMenu>) => {
    return typeof p.children === "function" ? p.children(() => ui.androidMenu(p)) : p.children;
  },
}));
vi.mock("../../components/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/LoadingScreen", () => ({ LoadingScreen: () => null }));
vi.mock("./ThreadTeamViewer", () => ({
  ThreadTeamViewer: (p: { environmentId: string; thread: { id: string } }) => (
    <section data-viewer={p.environmentId + "/" + p.thread.id} />
  ),
}));
vi.mock("./ThreadDetailScreen", () => ({
  ThreadDetailScreen: (p: { orchestraActive: boolean; proposedMonitoringPlan: unknown }) => (
    <main
      data-mode={
        p.orchestraActive ? "orchestra" : p.proposedMonitoringPlan ? "monitoring" : "regular"
      }
    />
  ),
}));
vi.mock("./GitActionProgressOverlay", () => ({ GitActionProgressOverlay: () => null }));
vi.mock("./git/GitOverviewSheet", () => ({ GitOverviewSheet: () => null }));
vi.mock("../files/thread-file-navigator-pane", () => ({ ThreadFileNavigatorPane: () => null }));
vi.mock("./thread-inspector-content-stack", () => ({ ThreadInspectorContentStack: () => null }));
vi.mock("../terminal/terminalLaunchContext", () => ({}));
vi.mock("../terminal/terminalDebugLog", () => ({ terminalDebugLog: vi.fn() }));
vi.mock("../../lib/openExternalUrl", () => ({}));
vi.mock("../../state/workspace", () => ({ useWorkspaceState: () => ({ state: {} }) }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/use-vcs-action-state", () => ({
  useGitActionProgress: () => null,
  dismissGitActionResult: vi.fn(),
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../../state/threads", () => ({ threadEnvironment: {} }));
vi.mock("../../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectionState: "available" }),
  useRemoteConnections: () => ({}),
  useRemoteEnvironmentRuntime: () => null,
}));
vi.mock("../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({}),
}));
vi.mock("../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({ gitOperationLabel: null }),
}));
vi.mock("../../state/use-selected-thread-requests", () => ({
  useSelectedThreadRequests: () => ({}),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: ui.workspace ? "/repo" : null }),
}));
vi.mock("../../state/use-terminal-session", () => ({ useKnownTerminalSessions: () => [] }));
vi.mock("../../state/use-thread-composer-state", () => ({
  useThreadComposerState: () => ({ activeOrchestra: ui.orchestra ? {} : undefined }),
}));
vi.mock("../../state/use-thread-detail", async () => {
  const Option = await import("effect/Option");
  return {
    useSelectedThreadDetailState: () => ({
      status: "loading",
      data: Option.none(),
      error: Option.none(),
      page: Option.none(),
    }),
  };
});
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: {
      id: ui.room,
      environmentId: "env",
      title: "방 제목",
      modelSelection: { instanceId: "account", model: "selected" },
    },
    selectedThreadProject: {
      title: "프로젝트",
      workspaceRoot: ui.workspace ? "/repo" : null,
      workspaceControl: ui.monitoring
        ? { monitoring: { threadId: ui.room, planStatus: "proposed", plan: { revision: 1 } } }
        : undefined,
    },
  }),
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    fileInspector: { supported: ui.split },
    layout: { usesSplitView: ui.split },
    panes: {
      contentPaneWidth: ui.paneWidth,
      auxiliaryPaneVisible: ui.inspector,
      auxiliaryPaneWidth: 300,
    },
  }),
  useRegisterWorkspaceInspector: () => {},
  useAdaptiveWorkspacePaneRole: () => {},
}));

function renderRoom() {
  hooks.beginRender();
  return renderToStaticMarkup(
    <ThreadRouteScreen
      route={{ params: { environmentId: "env", threadId: ui.room } }}
      {...(ui.inspector ? { renderInspector: () => null, onReturnToThread: vi.fn() } : {})}
    />,
  );
}
beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  ui.press.clear();
  Object.assign(ui, {
    os: "ios",
    room: "room-a",
    split: false,
    paneWidth: 390,
    inspector: false,
    glass: false,
    orchestra: false,
    monitoring: false,
    workspace: false,
  });
});

it.each([
  ["regular", false, false, 390],
  ["monitoring", false, true, 390],
  ["orchestra", true, true, 850],
  ["regular", true, true, 440],
] as const)(
  "opens the selected %s room from the named iOS header action (split %s, glass %s, pane %i)",
  (mode, split, glass, paneWidth) => {
    Object.assign(ui, {
      split,
      paneWidth,
      glass,
      monitoring: mode === "monitoring",
      orchestra: mode === "orchestra",
      workspace: mode !== "regular",
    });
    expect(renderRoom()).toContain('data-mode="' + mode + '"');
    expect(ui.toolbar).not.toHaveBeenCalled();
    const opts = ui.native.mock.lastCall![0];
    expect(opts).toMatchObject({ headerShown: true, headerTitle: "방 제목" });
    const items = opts.unstable_headerRightItems() as (
      | NativeStackHeaderItemButton
      | NativeStackHeaderItemMenu
    )[];
    const viewer = items.find(
      (item): item is NativeStackHeaderItemButton =>
        item.type === "button" && item.label === "대화 뷰어",
    );
    expect(viewer?.accessibilityLabel).toBe("대화 뷰어");
    if (paneWidth < 720) {
      expect(items).toHaveLength(2);
      const overflow = items.find(
        (item): item is NativeStackHeaderItemMenu => item.type === "menu",
      )!;
      expect(overflow.menu.items.map((item) => item.label)).toContain("깃");
      expect(overflow.menu.items.some((item) => item.label === "터미널")).toBe(ui.workspace);
    } else {
      expect(items.map((item) => item.label)).toEqual(["대화 뷰어", "파일", "깃", "터미널"]);
    }
    viewer!.onPress();
    expect(renderRoom()).toContain('data-viewer="env/room-a"');
    ui.room = "room-b";
    expect(renderRoom()).not.toContain("data-viewer");
    const nextItems =
      ui.native.mock.lastCall![0].unstable_headerRightItems() as NativeStackHeaderItemButton[];
    nextItems.find((item) => item.label === "대화 뷰어")!.onPress();
    expect(renderRoom()).toContain('data-viewer="env/room-b"');
  },
);

it("keeps the Viewer beside overflow when a file inspector narrows the chat pane", () => {
  Object.assign(ui, { split: true, glass: true, inspector: true, workspace: true, paneWidth: 900 });
  renderRoom();
  const [viewer, overflow] = ui.native.mock.lastCall![0].unstable_headerRightItems();
  expect(viewer.label).toBe("대화 뷰어");
  expect(overflow.accessibilityLabel).toBe("대화 작업 더 보기");
  viewer.onPress();
  expect(renderRoom()).toContain('data-viewer="env/room-a"');
});

it.each(["regular", "orchestra"])(
  "keeps the Android Viewer visible in a %s room and routes tools through overflow",
  (mode) => {
    Object.assign(ui, { os: "android", orchestra: mode === "orchestra", workspace: true });
    const html = renderRoom();
    expect(html).toContain('data-mode="' + mode + '"');
    expect(ui.native.mock.lastCall![0].headerShown).toBe(false);
    expect(html).toContain('aria-label="대화 뷰어"><span>대화 뷰어</span>');
    expect(html).toContain('aria-label="대화 작업 더 보기"');
    expect(html).not.toContain('aria-label="터미널 열기"');
    expect(ui.androidMenu).not.toHaveBeenCalled();
    ui.press.get("대화 작업 더 보기")!();
    const menu = ui.androidMenu.mock.lastCall![0] as ComponentProps<typeof AndroidAnchoredMenu>;
    expect(menu.actions.map((item) => item.title)).toContain("터미널 열기");
    menu.onPressAction!({ nativeEvent: { event: "터미널 열기" } });
    expect(ui.navigate).toHaveBeenCalledWith("ThreadTerminal", {
      environmentId: "env",
      threadId: "room-a",
    });
    ui.press.get("대화 뷰어")!();
    expect(renderRoom()).toContain('data-viewer="env/room-a"');
  },
);
