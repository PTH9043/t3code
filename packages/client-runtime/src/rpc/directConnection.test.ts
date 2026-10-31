import type { DesktopDirectRpcBridge, DesktopDirectRpcOutput } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DirectRpcConnection } from "./directConnection.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("desktop direct RPC connection", () => {
  it("handles an open acknowledgement that arrives before the IPC open result", async () => {
    const openedId = deferred<number>();
    let listener: (frame: DesktopDirectRpcOutput) => void = () => {};
    const unsubscribe = vi.fn();
    const bridge: DesktopDirectRpcBridge = {
      open: () => openedId.promise,
      send: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onFrame: (next) => {
        listener = next;
        return unsubscribe;
      },
    };
    const connection = new DirectRpcConnection(bridge);
    const opened = new Promise<void>((done) =>
      connection.addEventListener("open", () => done(), { once: true }),
    );
    listener({ type: "opened", clientId: 7 });
    openedId.resolve(7);
    await opened;
    expect(connection.readyState).toBe(1);
    const message = new Promise<string>((done) =>
      connection.addEventListener("message", (event) => done((event as MessageEvent).data), {
        once: true,
      }),
    );
    listener({ type: "data", clientId: 8, data: "other client" });
    listener({ type: "data", clientId: 7, data: "안녕하세요 🌏" });
    expect(await message).toBe("안녕하세요 🌏");
    connection.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(bridge.close).toHaveBeenCalledWith(7);
  });

  it("preserves send order and closes on a backend failure", async () => {
    let listener: (frame: DesktopDirectRpcOutput) => void = () => {};
    const firstSend = deferred<void>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const bridge: DesktopDirectRpcBridge = {
      open: async () => 1,
      send: vi.fn((_, data) => {
        if (data === "first") {
          firstStarted.resolve();
          return firstSend.promise;
        }
        secondStarted.resolve();
        return Promise.resolve();
      }),
      close: vi.fn(async () => {}),
      onFrame: (next) => {
        listener = next;
        return () => {};
      },
    };
    const connection = new DirectRpcConnection(bridge);
    const opened = new Promise<void>((done) =>
      connection.addEventListener("open", () => done(), { once: true }),
    );
    listener({ type: "opened", clientId: 1 });
    await opened;
    connection.send("first");
    connection.send("second");
    await firstStarted.promise;
    expect(bridge.send).toHaveBeenCalledTimes(1);
    firstSend.resolve();
    await secondStarted.promise;
    expect(bridge.send).toHaveBeenNthCalledWith(2, 1, "second");
    const closed = new Promise<void>((done) =>
      connection.addEventListener("close", () => done(), { once: true }),
    );
    listener({ type: "closed", clientId: 1 });
    await closed;
    expect(connection.readyState).toBe(3);
    expect(() => connection.send("after close")).toThrow();
  });

  it("closes a backend client even if the renderer closes before open completes", async () => {
    const openedId = deferred<number>();
    const closed = deferred<void>();
    const bridge: DesktopDirectRpcBridge = {
      open: () => openedId.promise,
      send: vi.fn(async () => {}),
      close: vi.fn(async () => {
        closed.resolve();
      }),
      onFrame: () => () => {},
    };
    const connection = new DirectRpcConnection(bridge);
    connection.close();
    openedId.resolve(9);
    await closed.promise;
    expect(bridge.close).toHaveBeenCalledWith(9);
    expect(connection.readyState).toBe(3);
  });
});
