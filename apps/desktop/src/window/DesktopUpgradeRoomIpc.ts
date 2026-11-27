import * as NodeCrypto from "node:crypto";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, Rectangle } from "electron";
import { WebContentsView } from "electron";
import {
  MENU_ACTION_CHANNEL,
  OPEN_UPGRADE_ROOM_CHANNEL,
  RESUME_UPGRADE_ROOM_CHANNEL,
  UPGRADE_ROOM_TAB_LAYOUT_CHANNEL,
} from "../ipc/channels.ts";
import { linkInstalledRoom, parseRoomLink } from "./DesktopUpgradeRoomLink.ts";

function validOwner(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
}

function validBounds(input: unknown): input is Rectangle {
  if (!input || typeof input !== "object") return false;
  const r = input as Record<string, unknown>;
  return (
    [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    Number(r.width) >= 0 &&
    Number(r.height) >= 0
  );
}

export function installDesktopUpgradeRoomIpc(
  window: BrowserWindow,
  applicationUrl: string,
  link: () => Promise<unknown> = linkInstalledRoom,
): void {
  const expected = new URL(applicationUrl);
  let owner: string | null = null;
  let bounds: Rectangle | null = null;
  let view: WebContentsView | undefined;
  let attached = false;
  let ready = false;
  let closed = false;
  let opening: Promise<boolean> | undefined;

  function trusted(event: IpcMainEvent | IpcMainInvokeEvent) {
    if (
      closed ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      !event.senderFrame ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return false;
    const url = URL.parse(event.senderFrame.url);
    return (
      url?.protocol === expected.protocol &&
      url.host === expected.host &&
      !url.username &&
      !url.password
    );
  }

  function detach() {
    if (attached && view && !window.isDestroyed()) window.contentView.removeChildView(view);
    attached = false;
  }

  function layout() {
    if (!view || !ready || !owner || !bounds || window.isDestroyed()) return detach();
    const zoom = window.webContents.getZoomFactor();
    const area = window.getContentBounds();
    const clamp = (n: number, limit: number) => Math.min(limit, Math.max(0, Math.round(n * zoom)));
    const x = clamp(bounds.x, area.width);
    const y = clamp(bounds.y, area.height);
    const width = clamp(bounds.x + bounds.width, area.width) - x;
    const height = clamp(bounds.y + bounds.height, area.height) - y;
    if (width <= 0 || height <= 0) return detach();
    view.setBounds({ x, y, width, height });
    if (!attached) window.contentView.addChildView(view);
    attached = true;
  }

  function release() {
    owner = null;
    bounds = null;
    detach();
  }

  function discard() {
    detach();
    const guest = view?.webContents;
    view = undefined;
    ready = false;
    if (guest && !guest.isDestroyed()) guest.close();
  }

  async function connect() {
    try {
      const room = parseRoomLink(await link());
      if (!room || closed || !owner) return false;
      view = new WebContentsView({
        webPreferences: {
          partition: "upgrade-room-" + NodeCrypto.randomUUID(),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          devTools: false,
        },
      });
      const guest = view.webContents;
      guest.on("before-input-event", (event, input) => {
        if (!attached || input.type !== "keyDown" || !input.control || input.alt || input.meta)
          return;
        const action =
          input.key === "Tab"
            ? input.shift
              ? "workspace-tab-previous"
              : "workspace-tab-next"
            : !input.shift && input.key.toLowerCase() === "w"
              ? "workspace-tab-close"
              : null;
        if (action) {
          event.preventDefault();
          window.webContents.send(MENU_ACTION_CHANNEL, action);
        }
      });
      const session = guest.session;
      session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      session.setPermissionCheckHandler(() => false);
      guest.setWindowOpenHandler(() => ({ action: "deny" }));
      session.on("will-download", (event) => event.preventDefault());
      const { origin, host } = room.url;
      const allowedPage = (url: string) =>
        url === room.canonical ||
        (!ready && (url === room.url.href || url === origin + "/open-room.html"));
      session.webRequest.onBeforeRequest((details, done) => {
        const url = URL.parse(details.url);
        const local =
          url &&
          !url.username &&
          !url.password &&
          url.host === host &&
          (url.protocol === "http:" || url.protocol === "ws:");
        const blob = url?.protocol === "blob:" && url.origin === origin;
        done({
          cancel:
            details.resourceType === "mainFrame"
              ? !allowedPage(details.url)
              : details.resourceType === "subFrame" ||
                !(local || blob || url?.protocol === "data:"),
        });
      });
      guest.on("will-navigate", (event) => {
        if (!allowedPage(event.url)) event.preventDefault();
      });
      guest.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
        if (ready && mainFrame && code !== -3 && view?.webContents === guest) discard();
      });
      guest.on("render-process-gone", () => {
        if (view?.webContents === guest) discard();
      });
      guest.once("destroyed", () => {
        if (view?.webContents === guest) discard();
      });
      // The installed page exchanges its one-time fragment for a session cookie.
      const entered = await new Promise<boolean>((resolve) => {
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          guest.removeListener("did-navigate", navigated);
          guest.removeListener("destroyed", failed);
          resolve(ok);
        };
        const navigated = (_event: Electron.Event, url: string, responseCode: number) => {
          if (url === room.canonical) finish(responseCode >= 200 && responseCode < 300);
        };
        const failed = () => finish(false);
        // @effect-diagnostics-next-line globalTimers:off - Electron navigation listeners share this cancellable native timeout.
        const timer = setTimeout(failed, 30_000);
        guest.on("did-navigate", navigated);
        guest.once("destroyed", failed);
        void guest.loadURL(room.url.href).catch(() => {
          if (!guest.isDestroyed() && guest.getURL() !== room.canonical) failed();
        });
      });
      if (!entered || closed || view?.webContents !== guest) throw new Error("Room unavailable.");
      room.url.hash = "";
      ready = true;
      layout();
      return true;
    } catch {
      // Launcher output and navigation errors can contain credentials.
      discard();
      return false;
    }
  }

  window.webContents.ipc.handle(
    OPEN_UPGRADE_ROOM_CHANNEL,
    (event, id: unknown, ...extra: unknown[]) => {
      if (!trusted(event) || extra.length || !validOwner(id)) return false;
      if (owner !== id) release();
      owner = id;
      if (ready && view && !view.webContents.isDestroyed()) return true;
      opening ??= connect().finally(() => {
        opening = undefined;
      });
      return opening;
    },
  );
  window.webContents.ipc.handle(
    RESUME_UPGRADE_ROOM_CHANNEL,
    (event, id: unknown, ...extra: unknown[]) => {
      if (
        !trusted(event) ||
        extra.length ||
        !validOwner(id) ||
        !ready ||
        !view ||
        view.webContents.isDestroyed()
      )
        return false;
      if (owner !== id) release();
      owner = id;
      return true;
    },
  );
  window.webContents.ipc.on(
    UPGRADE_ROOM_TAB_LAYOUT_CHANNEL,
    (event, id: unknown, rect: unknown) => {
      if (!trusted(event) || !owner || id !== owner) return;
      if (rect === null) return release();
      if (!validBounds(rect)) return;
      bounds = rect;
      layout();
    },
  );
  window.webContents.on("did-start-navigation", (event) => {
    if (event.isMainFrame && !event.isSameDocument) release();
  });
  window.webContents.on("render-process-gone", release);
  window.once("closed", () => {
    closed = true;
    release();
    discard();
  });
}
