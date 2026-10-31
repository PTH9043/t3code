import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";

import type { DesktopDirectRpcHub } from "../backend/DesktopDirectRpcHub.ts";
import { DIRECT_RPC_OPEN_CHANNEL, DIRECT_RPC_SEND_CHANNEL } from "../ipc/channels.ts";
import { installDesktopDirectRpcIpc } from "./DesktopDirectRpcIpc.ts";

it("restricts direct RPC to the local main frame and closes its sessions on navigation", async () => {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const mainFrame = { url: "t3code-dev://app/control-center" };
  const closedOwners: number[] = [];
  const sent: Array<{ owner: number; id: number; data: string }> = [];
  const openTokens: Array<string | undefined> = [];
  const window = {
    isDestroyed: () => false,
    once: (name: string, callback: (...args: never[]) => unknown) => listeners.set(name, callback),
    webContents: {
      id: 11,
      mainFrame,
      isDestroyed: () => false,
      send: () => {},
      on: (name: string, callback: (...args: never[]) => unknown) => listeners.set(name, callback),
      ipc: {
        handle: (name: string, callback: (...args: never[]) => unknown) =>
          handlers.set(name, callback),
      },
    },
  } as unknown as Electron.BrowserWindow;
  const hub: DesktopDirectRpcHub["Service"] = {
    attach: Effect.die("unused"),
    attachBackend: () => Effect.die("unused"),
    open: (_owner, _deliver, _backend, token) =>
      Effect.sync(() => {
        openTokens.push(token);
        return 3;
      }),
    send: (owner, id, data) =>
      Effect.sync(() => {
        sent.push({ owner, id, data });
      }),
    close: () => Effect.void,
    closeOwner: (owner) =>
      Effect.sync(() => {
        closedOwners.push(owner);
      }),
  };
  installDesktopDirectRpcIpc(window, hub, () => "google-bearer");
  const open = handlers.get(DIRECT_RPC_OPEN_CHANNEL) as unknown as (
    event: unknown,
    backendId?: string,
  ) => Promise<number>;
  const send = handlers.get(DIRECT_RPC_SEND_CHANNEL) as unknown as (
    event: unknown,
    payload: unknown,
  ) => Promise<void>;
  expect(() => open({ senderFrame: { url: mainFrame.url } })).toThrow();
  mainFrame.url = "https://example.com/";
  expect(() => open({ senderFrame: mainFrame })).toThrow();
  mainFrame.url = "t3code-dev://app/control-center";
  await expect(open({ senderFrame: mainFrame })).resolves.toBe(3);
  await expect(open({ senderFrame: mainFrame }, "wsl:Ubuntu")).resolves.toBe(3);
  expect(openTokens).toEqual(["google-bearer", undefined]);
  await send({ senderFrame: mainFrame }, { clientId: 3, data: "message" });
  expect(sent).toEqual([{ owner: 11, id: 3, data: "message" }]);
  const navigate = listeners.get("did-start-navigation") as unknown as (...args: unknown[]) => void;
  navigate({}, "t3code-dev://app/other", false, true);
  await Promise.resolve();
  expect(closedOwners).toEqual([11]);
});
