import { describe, expect, it, vi } from "vite-plus/test";
import {
  installWindowsDropHandler,
  NATIVE_FILE_DROP_MESSAGE,
  type WindowsDropApi,
} from "./WindowsFileDrop.ts";

function fixture() {
  let handler: (w: Buffer, l: Buffer) => void = () => {};
  const hwnd = Buffer.alloc(8);
  hwnd.writeBigUInt64LE(0x123456789abcn);
  const window = {
    getNativeWindowHandle: () => hwnd,
    hookWindowMessage: vi.fn((_m, fn) => {
      handler = fn;
    }),
  };
  const api: WindowsDropApi = {
    isElevated: vi.fn(() => true),
    retainOleDropTarget: vi.fn(() => 0x123456789aa0n),
    releaseOleDropTarget: vi.fn(),
    registerOleDropTarget: vi.fn(() => 0),
    revokeOleDropTarget: vi.fn(() => 0),
    allowMessage: vi.fn(() => true),
    installReceiver: vi.fn(() => 2),
    refreshReceiver: vi.fn(() => 2),
    enableReceiver: vi.fn(),
    disposeReceiver: vi.fn(),
    queryCount: vi.fn(() => 2),
    queryPath: vi.fn((_drop, i) => `C:\\사진\\그림${i}.png`),
    queryPoint: vi.fn(() => ({ x: 300, y: 150 })),
    finish: vi.fn(),
    dpi: () => 144,
  };
  const onDrop = vi.fn(),
    onError = vi.fn();
  const send = (pointSource = 0) => {
    const w = Buffer.alloc(8);
    w.writeBigUInt64LE(0x123456789defn);
    const l = Buffer.alloc(8);
    l.writeUInt32LE(pointSource);
    handler(w, l);
  };
  return { window, api, onDrop, onError, send };
}

describe("elevated Windows file drops", () => {
  it("hands an elevated Chromium window to shell file drops before accepting files", () => {
    const f = fixture();
    installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError);
    expect(f.api.revokeOleDropTarget).toHaveBeenCalledExactlyOnceWith(0x123456789abcn);
    expect(f.api.revokeOleDropTarget).toHaveBeenCalledBefore(vi.mocked(f.api.installReceiver));
    expect(f.window.hookWindowMessage).toHaveBeenCalledWith(
      NATIVE_FILE_DROP_MESSAGE,
      expect.any(Function),
    );
  });
  it("preserves Chromium OLE handling for a non-elevated window", () => {
    const f = fixture();
    f.api.isElevated = () => false;
    installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError);
    expect(f.api.revokeOleDropTarget).not.toHaveBeenCalled();
    expect(f.api.retainOleDropTarget).not.toHaveBeenCalled();
    expect(f.api.installReceiver).toHaveBeenCalledWith(0x123456789abcn);
  });
  it("accepts an elevated window without an existing OLE registration", () => {
    const f = fixture();
    f.api.retainOleDropTarget = () => 0n;
    installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError);
    f.send();
    expect(f.onDrop).toHaveBeenCalledOnce();
  });
  it("fails registration if Chromium's OLE target cannot be removed", () => {
    const f = fixture();
    f.api.revokeOleDropTarget = () => -2147024882;
    expect(() => installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError)).toThrow(
      "Windows OLE file-drop handoff failed",
    );
    expect(f.api.installReceiver).not.toHaveBeenCalled();
    expect(f.api.releaseOleDropTarget).toHaveBeenCalledOnce();
  });
  it("restores the retained Chromium target only for internal drags and returns to shell files", () => {
    const f = fixture();
    const controller = installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError);
    controller.setInternalDragActive(true);
    controller.setInternalDragActive(true);
    expect(f.api.registerOleDropTarget).toHaveBeenCalledExactlyOnceWith(
      0x123456789abcn,
      0x123456789aa0n,
    );
    controller.setInternalDragActive(false);
    controller.setInternalDragActive(false);
    expect(f.api.revokeOleDropTarget).toHaveBeenCalledTimes(2);
    expect(f.api.enableReceiver).toHaveBeenNthCalledWith(1, 0x123456789abcn, false);
    expect(f.api.enableReceiver).toHaveBeenNthCalledWith(2, 0x123456789abcn, true);
    expect(controller.refresh()).toBe(2);
    f.send();
    expect(f.onDrop).toHaveBeenCalledOnce();
    controller.dispose();
    controller.dispose();
    controller.setInternalDragActive(true);
    expect(f.api.releaseOleDropTarget).toHaveBeenCalledExactlyOnceWith(0x123456789aa0n);
    expect(f.api.disposeReceiver).toHaveBeenCalledExactlyOnceWith(0x123456789abcn);
    expect(controller.refresh()).toBe(0);
    expect(f.api.registerOleDropTarget).toHaveBeenCalledOnce();
  });
  it("allows only the two shell file messages on this HWND and retains 64-bit handles", () => {
    const f = fixture();
    installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError);
    f.send();
    expect(f.api.allowMessage).toHaveBeenCalledTimes(2);
    expect(f.api.allowMessage).toHaveBeenNthCalledWith(1, 0x123456789abcn, 0x233);
    expect(f.api.allowMessage).toHaveBeenNthCalledWith(2, 0x123456789abcn, 0x49);
    expect(f.onDrop).toHaveBeenCalledExactlyOnceWith({
      paths: ["C:\\사진\\그림0.png", "C:\\사진\\그림1.png"],
      x: 200,
      y: 100,
      overflow: false,
      pointSource: "payload",
    });
    expect(f.api.finish).toHaveBeenCalledExactlyOnceWith(0x123456789defn);
  });
  it("limits shell enumeration to eight files and reports overflow", () => {
    const f = fixture();
    f.api.queryCount = () => 100;
    installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError);
    f.send();
    expect(f.api.queryPath).toHaveBeenCalledTimes(8);
    expect(f.onDrop.mock.calls[0]?.[0]).toMatchObject({ overflow: true });
  });
  it("retains the native message position marker while converting physical pixels to DIP", () => {
    const f = fixture();
    f.api.queryPoint = () => ({ x: 1149, y: 1776 });
    installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError);
    f.send(1);
    expect(f.onDrop.mock.calls[0]?.[0]).toMatchObject({
      x: 766,
      y: 1184,
      pointSource: "message",
    });
    expect(f.api.finish).toHaveBeenCalledOnce();
  });
  it("always releases HDROP when path decoding fails", () => {
    const f = fixture();
    f.api.queryPath = () => {
      throw new Error("bad path");
    };
    installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError);
    f.send();
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.api.finish).toHaveBeenCalledOnce();
    expect(f.onDrop).not.toHaveBeenCalled();
  });
  it("does not accept titlebar drops or zero files and still releases HDROP", () => {
    const f = fixture();
    f.api.queryPoint = () => null;
    installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError);
    f.send();
    expect(f.onDrop).not.toHaveBeenCalled();
    expect(f.api.finish).toHaveBeenCalledOnce();
  });
  it("fails registration without accepting files when Windows rejects a filter", () => {
    const f = fixture();
    f.api.allowMessage = () => false;
    expect(() => installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError)).toThrow();
    expect(f.api.installReceiver).not.toHaveBeenCalled();
  });
  it("restores Chromium and releases its retained reference if the renderer receiver fails", () => {
    const f = fixture();
    f.api.installReceiver = () => 0;
    expect(() => installWindowsDropHandler(f.window, f.api, f.onDrop, f.onError)).toThrow(
      "Windows renderer file-drop registration failed",
    );
    expect(f.api.registerOleDropTarget).toHaveBeenCalledExactlyOnceWith(
      0x123456789abcn,
      0x123456789aa0n,
    );
    expect(f.api.releaseOleDropTarget).toHaveBeenCalledExactlyOnceWith(0x123456789aa0n);
  });
});
