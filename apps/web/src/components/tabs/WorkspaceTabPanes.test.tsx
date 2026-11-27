import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import { expect, it, vi } from "vite-plus/test";
import type { WorkspaceTab } from "../../workspaceTabStore";
import { WorkspaceTabPane } from "./WorkspaceTabPanes";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  effects: [] as Array<() => void>,
  status: "cached" as EnvironmentShellStatus,
  snapshotIds: ["older-room"],
  hasShellRow: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void) => {
    fixture.effects.push(effect);
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixture.navigate }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      status: fixture.status,
      snapshot: { _tag: "Some", value: { threads: fixture.snapshotIds.map((id) => ({ id })) } },
    },
  }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => (fixture.hasShellRow ? { id: "new-room" } : null),
  useThreadDetail: () => null,
  useThreadStatus: () => "empty",
  useEnvironmentThreadRefs: () => [{ threadId: "older-room" }],
}));
vi.mock("../ChatView", () => ({ default: () => <span>saved chat</span> }));
vi.mock("../control-center/WorkspaceControlCenter", () => ({ WorkspaceControlCenter: () => null }));
vi.mock("../control-center/ControlCenterDisplayControls", () => ({
  ControlCenterDisplayControls: () => null,
}));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => children,
}));

it("keeps the promoted room URL through a reload with an older shell cache, then resolves live presence or absence", () => {
  const tab: WorkspaceTab = {
    id: "tab",
    projectKey: "project",
    lastActivatedAt: 1,
    view: { kind: "thread", environmentId: "environment", threadId: "new-room" },
  };
  function render() {
    const html = renderToStaticMarkup(<WorkspaceTabPane tab={tab} active />);
    for (const effect of fixture.effects.splice(0)) effect();
    return html;
  }
  for (const status of ["cached", "synchronizing"] as const) {
    fixture.status = status;
    render();
    expect(fixture.navigate).not.toHaveBeenCalled();
  }
  fixture.status = "live";
  fixture.snapshotIds.push("new-room");
  render();
  expect(fixture.navigate).not.toHaveBeenCalled();
  fixture.hasShellRow = true;
  expect(render()).toContain("saved chat");
  expect(fixture.navigate).not.toHaveBeenCalled();

  fixture.hasShellRow = false;
  fixture.snapshotIds = ["older-room"];
  render();
  expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true });
});
