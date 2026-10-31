import { NonNegativeInt } from "@t3tools/contracts";
import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DesktopDirectRpcHub } from "../backend/DesktopDirectRpcHub.ts";
import { getSelectedGoogleBearerToken } from "../backend/DesktopLocalEnvironmentAuth.ts";
import {
  DIRECT_RPC_CLOSE_CHANNEL,
  DIRECT_RPC_FRAME_CHANNEL,
  DIRECT_RPC_OPEN_CHANNEL,
  DIRECT_RPC_SEND_CHANNEL,
} from "../ipc/channels.ts";

const decodeSend = Schema.decodeUnknownSync(
  Schema.Struct({ clientId: NonNegativeInt, data: Schema.String }),
);
const decodeClose = Schema.decodeUnknownSync(Schema.Struct({ clientId: NonNegativeInt }));

/** Binds direct RPC to the main renderer only; embedded web content has no access. */
export function installDesktopDirectRpcIpc(
  window: Electron.BrowserWindow,
  hub: DesktopDirectRpcHub["Service"],
  getGoogleBearerToken: () => string | undefined = getSelectedGoogleBearerToken,
): void {
  const owner = window.webContents.id;
  const allowed = (event: Electron.IpcMainInvokeEvent) => {
    if (window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame) return false;
    try {
      const url = new URL(event.senderFrame.url);
      return (url.protocol === "t3code:" || url.protocol === "t3code-dev:") && url.host === "app";
    } catch {
      return false;
    }
  };
  const assertAllowed = (event: Electron.IpcMainInvokeEvent) => {
    if (!allowed(event)) throw new Error("Direct RPC is only available to the main window.");
  };
  window.webContents.ipc.handle(DIRECT_RPC_OPEN_CHANNEL, (event, backendId: unknown) => {
    assertAllowed(event);
    if (
      backendId !== undefined &&
      (typeof backendId !== "string" ||
        (backendId !== "primary" && !backendId.startsWith("wsl:")) ||
        backendId.length > 512)
    ) {
      throw new Error("Invalid local backend.");
    }
    return Effect.runPromise(
      hub.open(
        owner,
        (frame) => {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            window.webContents.send(DIRECT_RPC_FRAME_CHANNEL, frame);
          }
        },
        backendId,
        backendId === undefined || backendId === "primary" ? getGoogleBearerToken() : undefined,
      ),
    );
  });
  window.webContents.ipc.handle(DIRECT_RPC_SEND_CHANNEL, (event, raw: unknown) => {
    assertAllowed(event);
    const { clientId, data } = decodeSend(raw);
    return Effect.runPromise(hub.send(owner, clientId, data));
  });
  window.webContents.ipc.handle(DIRECT_RPC_CLOSE_CHANNEL, (event, raw: unknown) => {
    assertAllowed(event);
    const { clientId } = decodeClose(raw);
    return Effect.runPromise(hub.close(owner, clientId));
  });
  const close = () => void Effect.runPromise(hub.closeOwner(owner));
  window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) close();
  });
  window.webContents.on("render-process-gone", close);
  window.once("closed", close);
}
