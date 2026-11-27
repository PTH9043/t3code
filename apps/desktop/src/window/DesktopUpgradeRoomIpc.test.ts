import * as NodeEvents from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { OPEN_UPGRADE_ROOM_CHANNEL, UPGRADE_ROOM_TAB_LAYOUT_CHANNEL } from "../ipc/channels.ts";
import { installDesktopUpgradeRoomIpc } from "./DesktopUpgradeRoomIpc.ts";
import { parseRoomLink } from "./DesktopUpgradeRoomLink.ts";

const { createView } = vi.hoisted(() => ({ createView: vi.fn() }));
vi.mock("electron", () => ({
  WebContentsView: function (options: unknown) {
    return createView(options);
  },
}));
const origin = "http://127.0.0.1:23456";
const reply = {
  ok: true,
  pid: 123,
  status: "ready",
  environmentId: "room-env",
  projectId: "autousage-upgrade-project",
  threadId: "autousage-upgrade-room",
  origin,
  url: origin + "/open-room.html#token=fixture",
};
const canonical = origin + "/room-env/autousage-upgrade-room";
const first = "aaaaaaaa-0000-4000-8888-000000000001";
const next = "aaaaaaaa-0000-4000-8888-000000000002";
const bounds = { x: 50, y: 20, width: 800, height: 600 };
afterEach(() => vi.clearAllMocks());

function setup(link = vi.fn<() => Promise<unknown>>().mockResolvedValue(reply)) {
  const ipc = { handle: vi.fn(), on: vi.fn() };
  const host = Object.assign(new NodeEvents.EventEmitter(), {
    ipc,
    mainFrame: { url: "t3code-dev://app/thread" },
    getZoomFactor: () => 2,
  });
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    webContents: host,
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 900, height: 600 }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  const loaded = Promise.withResolvers<string>();
  const guest = Object.assign(new NodeEvents.EventEmitter(), {
    isDestroyed: () => false,
    close: vi.fn(),
    focus: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(async (url: string) => {
      loaded.resolve(url);
    }),
    session: {
      on: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn() },
    },
  });
  const view = { webContents: guest, setBounds: vi.fn() };
  createView.mockReturnValue(view);
  installDesktopUpgradeRoomIpc(window as unknown as BrowserWindow, host.mainFrame.url, link);
  const [channel, open] = ipc.handle.mock.calls[0]!;
  const [layoutChannel, layout] = ipc.on.mock.calls[0]!;
  expect([channel, layoutChannel]).toEqual([
    OPEN_UPGRADE_ROOM_CHANNEL,
    UPGRADE_ROOM_TAB_LAYOUT_CHANNEL,
  ]);
  const event = { sender: host, senderFrame: host.mainFrame } as unknown as IpcMainInvokeEvent;
  return { window, host, guest, view, link, event, open, layout, loaded };
}

it("pairs once inside an isolated child view and reuses the canonical room across current chats", async () => {
  const { open, layout, event, loaded, guest, view, link, window, host } = setup();
  const result = open(event, first);
  layout(event, first, bounds);
  expect(await loaded.promise).toBe(reply.url);
  expect(createView).toHaveBeenCalledWith({
    webPreferences: expect.objectContaining({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      partition: expect.stringMatching(/^upgrade-room-/),
    }),
  });
  expect(window.contentView.addChildView).not.toHaveBeenCalled();
  guest.emit("did-navigate", {}, canonical, 200);
  expect(await result).toBe(true);
  expect(window.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(view);
  expect(view.setBounds).toHaveBeenCalledWith({ x: 100, y: 40, width: 800, height: 560 });
  layout(event, first, null);
  expect(window.contentView.removeChildView).toHaveBeenCalledWith(view);
  expect(await open(event, next)).toBe(true);
  layout(event, next, bounds);
  layout(event, first, null);
  expect(window.contentView.removeChildView).toHaveBeenCalledTimes(1);
  expect(link).toHaveBeenCalledTimes(1);
  expect(guest.loadURL).toHaveBeenCalledTimes(1);
  expect(host.mainFrame.url).toBe("t3code-dev://app/thread");
  expect(guest.focus).not.toHaveBeenCalled();
  expect(guest.close).not.toHaveBeenCalled();
  const guard = guest.session.webRequest.onBeforeRequest.mock.calls[0]![0];
  for (const [resourceType, url, cancel] of [
    ["mainFrame", "https://example.org/", true],
    ["mainFrame", origin + "/another-room", true],
    ["subFrame", canonical, true],
    ["webSocket", "ws://127.0.0.1:12345/ws", true],
    ["webSocket", "ws://127.0.0.1:23456/ws", false],
    ["xhr", origin + "/api/auth/session", false],
  ] as const) {
    const done = vi.fn();
    guard({ resourceType, url }, done);
    expect(done).toHaveBeenCalledWith({ cancel });
  }
  window.emit("closed");
  expect(guest.close).toHaveBeenCalledTimes(1);
});

it("rejects remote senders, frames, paths and invalid launcher replies", async () => {
  const { event, host, open, link } = setup();
  expect(open({ ...event, senderFrame: null }, first)).toBe(false);
  expect(open({ ...event, senderFrame: { ...host.mainFrame } }, first)).toBe(false);
  expect(open({ ...event, sender: {} }, first)).toBe(false);
  expect(open(event, reply.url)).toBe(false);
  expect(open(event, first, "override")).toBe(false);
  host.mainFrame.url = "https://elsewhere.invalid";
  expect(open(event, first)).toBe(false);
  expect(link).not.toHaveBeenCalled();
  for (const change of [
    { url: "https://outside.invalid" },
    { url: origin + "/other#token=x" },
    { environmentId: "../other" },
    { projectId: "nested" },
    { threadId: "other" },
    { origin: "http://127.0.0.1:1" },
    { url: origin + "/open-room.html?token=x" },
  ]) {
    expect(parseRoomLink({ ...reply, ...change })).toBeNull();
  }
});

it("a close while linking cannot open a late surface, and a subsequent click can retry", async () => {
  const delayed = Promise.withResolvers<unknown>();
  const { event, open, layout, guest, loaded, window } = setup(
    vi
      .fn<() => Promise<unknown>>()
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(reply),
  );
  const pending = open(event, first);
  layout(event, first, null);
  delayed.resolve(reply);
  expect(await pending).toBe(false);
  expect(createView).not.toHaveBeenCalled();
  const retry = open(event, next);
  await loaded.promise;
  layout(event, next, null);
  guest.emit("did-navigate", {}, canonical, 200);
  expect(await retry).toBe(true);
  expect(window.contentView.addChildView).not.toHaveBeenCalled();
});
