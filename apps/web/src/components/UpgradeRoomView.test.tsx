import type { ModelSelection, ServerConfig } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type ChatView from "./ChatView";
import { UpgradeRoomView } from "./UpgradeRoomView";

type RoomProps = Extract<ComponentProps<typeof ChatView>, { routeKind: "server" }>;
const mock = vi.hoisted(() => ({
  render: vi.fn<(props: RoomProps) => null>(() => null),
  shell: null as { modelSelection: ModelSelection } | null,
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock("./ChatView", () => ({ default: mock.render }));
vi.mock("./ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => mock.shell,
  useProject: () => ({ createdAt: "2026-01-01T00:00:00Z" }),
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { create: "create", updateMetadata: "update" },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: "create" | "update") => mock[command],
}));

const config = {
  environment: { environmentId: "room-env" },
  upgradeRoom: { projectId: "autousage-upgrade-project", threadId: "autousage-upgrade-room" },
  providers: ["account-one", "account-two"].map((instanceId) => ({
    instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [{ slug: "shared-model" }],
  })),
} as unknown as ServerConfig;
const room = config.upgradeRoom!;
function renderRoom(roomConfig = config) {
  renderToStaticMarkup(<UpgradeRoomView config={roomConfig} room={room} />);
  const props = mock.render.mock.lastCall![0];
  expect(props).toMatchObject({
    routeKind: "server",
    environmentId: "room-env",
    threadId: room.threadId,
  });
  return props.dedicatedRoom!;
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.shell = null;
  mock.create.mockResolvedValue({ _tag: "Success" });
  mock.update.mockResolvedValue({ _tag: "Success" });
});

it("mounts ChatView before selection and creates only the canonical thread on an explicit choice", async () => {
  const view = renderRoom();
  expect(view.emptyThread).toMatchObject({
    id: room.threadId,
    projectId: room.projectId,
    messages: [],
  });
  expect(view.modelSelection).toBeNull();
  expect(view.picker.placeholder).toBe("계정과 모델 선택");
  expect(view.sendDisabledReason).toBeTruthy();
  expect(mock.create).not.toHaveBeenCalled();
  await view.picker.onSelect(config.providers[1]!.instanceId, "shared-model");
  expect(mock.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      input: expect.objectContaining({
        ...room,
        modelSelection: { instanceId: "account-two", model: "shared-model" },
      }),
    }),
  );
});

it("opens the saved conversation and enables sending only for its available registered model", async () => {
  mock.shell = {
    modelSelection: { instanceId: config.providers[1]!.instanceId, model: "shared-model" },
  };
  expect(renderRoom().sendDisabledReason).toBeNull();
  mock.shell.modelSelection = { ...mock.shell.modelSelection, model: "retired-model" };
  const view = renderRoom();
  expect(view.sendDisabledReason).toBeTruthy();
  expect(view.picker.placeholder).toContain("retired-model");
  await view.picker.onSelect(config.providers[0]!.instanceId, "unknown");
  expect(mock.update).not.toHaveBeenCalled();
  await view.picker.onSelect(config.providers[0]!.instanceId, "shared-model");
  expect(mock.update).toHaveBeenCalledExactlyOnceWith({
    environmentId: "room-env",
    input: {
      threadId: room.threadId,
      modelSelection: { instanceId: "account-one", model: "shared-model" },
    },
  });
  expect(mock.create).not.toHaveBeenCalled();
});

it("excludes accounts with no selectable models and keeps the shared composer mounted", () => {
  const [first, second] = config.providers;
  const emptyAccount = { ...first!, models: [] };
  const view = renderRoom({ ...config, providers: [emptyAccount, second!] });
  expect(view.picker.providers).toEqual([second]);
  expect(view.picker.placeholder).toBe("계정과 모델 선택");

  const unavailable = renderRoom({ ...config, providers: [emptyAccount] });
  expect(unavailable.emptyThread.id).toBe(room.threadId);
  expect(unavailable.picker.placeholder).toBe("사용 가능한 계정과 모델이 없습니다");
  expect(unavailable.sendDisabledReason).toBeTruthy();
  expect(mock.create).not.toHaveBeenCalled();
});
