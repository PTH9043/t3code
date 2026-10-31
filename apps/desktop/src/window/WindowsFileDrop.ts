import type { BrowserWindow } from "electron";

const WM_DROPFILES = 0x0233;
const WM_COPYGLOBALDATA = 0x0049;
export const NATIVE_FILE_DROP_MESSAGE = 0x82a3;
const DRAGDROP_E_NOTREGISTERED = 0x80040100;
const MAX_PATH_CHARS = 32_768;
const MAX_DROP_FILES = 8;

export interface WindowsDrop {
  readonly paths: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly overflow: boolean;
  readonly pointSource?: "message" | "payload";
}

export interface WindowsDropApi {
  isElevated: () => boolean;
  retainOleDropTarget: (window: bigint) => bigint;
  releaseOleDropTarget: (target: bigint) => void;
  registerOleDropTarget: (window: bigint, target: bigint) => number;
  revokeOleDropTarget: (window: bigint) => number;
  allowMessage: (window: bigint, message: number) => boolean;
  installReceiver: (window: bigint) => number;
  refreshReceiver: (window: bigint) => number;
  enableReceiver: (window: bigint, enabled: boolean) => void;
  disposeReceiver: (window: bigint) => void;
  queryCount: (drop: bigint) => number;
  queryPath: (drop: bigint, index: number) => string;
  queryPoint: (drop: bigint) => { x: number; y: number } | null;
  finish: (drop: bigint) => void;
  dpi: (window: bigint) => number;
}

export function installWindowsDropHandler(
  window: Pick<BrowserWindow, "getNativeWindowHandle" | "hookWindowMessage">,
  api: WindowsDropApi,
  onDrop: (drop: WindowsDrop) => void,
  onError: (error: unknown) => void,
): {
  setInternalDragActive: (active: boolean) => void;
  refresh: () => number;
  dispose: () => void;
} {
  const handle = window.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  // Allow shell transfer on the root; the native receiver also configures its render child.
  if (!api.allowMessage(hwnd, WM_DROPFILES) || !api.allowMessage(hwnd, WM_COPYGLOBALDATA)) {
    throw new Error("Windows file-drop message registration failed.");
  }
  const target = api.isElevated() ? api.retainOleDropTarget(hwnd) : 0n;
  const revoke = () => {
    // Explorer chooses Chromium's OLE target before WS_EX_ACCEPTFILES. OLE cannot
    // cross integrity levels, so elevated windows must use the shell file path.
    const result = api.revokeOleDropTarget(hwnd) >>> 0;
    if (result !== 0 && result !== DRAGDROP_E_NOTREGISTERED) {
      throw new Error(`Windows OLE file-drop handoff failed: 0x${result.toString(16)}`);
    }
  };
  try {
    if (target !== 0n) revoke();
  } catch (error) {
    api.releaseOleDropTarget(target);
    throw error;
  }
  window.hookWindowMessage(NATIVE_FILE_DROP_MESSAGE, (wParam, lParam) => {
    const drop = wParam.length === 8 ? wParam.readBigUInt64LE() : BigInt(wParam.readUInt32LE());
    try {
      const count = api.queryCount(drop);
      const point = api.queryPoint(drop);
      if (!point || count === 0) return;
      const paths = Array.from({ length: Math.min(count, MAX_DROP_FILES) }, (_, i) =>
        api.queryPath(drop, i),
      );
      const scale = api.dpi(hwnd) / 96;
      onDrop({
        paths,
        x: point.x / scale,
        y: point.y / scale,
        overflow: count > MAX_DROP_FILES,
        pointSource: lParam.readUInt32LE() === 1 ? "message" : "payload",
      });
    } catch (error) {
      onError(error);
    } finally {
      api.finish(drop);
    }
  });
  if (api.installReceiver(hwnd) === 0) {
    if (target !== 0n) {
      api.registerOleDropTarget(hwnd, target);
      api.releaseOleDropTarget(target);
    }
    throw new Error("Windows renderer file-drop registration failed.");
  }
  let internalDragActive = false;
  let disposed = false;
  return {
    setInternalDragActive: (active) => {
      if (disposed || target === 0n || active === internalDragActive) return;
      if (active) {
        const result = api.registerOleDropTarget(hwnd, target) >>> 0;
        if (result !== 0)
          throw new Error(`Windows internal drag registration failed: 0x${result.toString(16)}`);
        api.enableReceiver(hwnd, false);
      } else {
        revoke();
        api.enableReceiver(hwnd, true);
      }
      internalDragActive = active;
    },
    refresh: () => (disposed ? 0 : api.refreshReceiver(hwnd)),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      api.disposeReceiver(hwnd);
      if (target !== 0n) api.releaseOleDropTarget(target);
    },
  };
}

export async function loadWindowsDropApi(receiverLibraryPath: string): Promise<WindowsDropApi> {
  const { open, load, DataType: T } = await import("ffi-rs");
  open({ library: "t3-file-drop-user32", path: "user32.dll" });
  open({ library: "t3-file-drop-shell32", path: "shell32.dll" });
  open({ library: "t3-file-drop-ole32", path: "ole32.dll" });
  open({ library: "t3-file-drop-kernel32", path: "kernel32.dll" });
  open({ library: "t3-file-drop-advapi32", path: "advapi32.dll" });
  open({ library: "t3-file-drop-shlwapi", path: "shlwapi.dll" });
  open({ library: "t3-file-drop-receiver", path: receiverLibraryPath });
  const setOlePointer = (pointer: Buffer, target: bigint) => {
    load({
      library: "t3-file-drop-shlwapi",
      funcName: "IUnknown_Set",
      retType: T.Void,
      paramsType: [T.U8Array, T.BigInt],
      paramsValue: [pointer, target],
    });
  };
  const queryPath = (drop: bigint, index: number) => {
    const length = load({
      library: "t3-file-drop-shell32",
      funcName: "DragQueryFileW",
      retType: T.U32,
      paramsType: [T.BigInt, T.U32, T.BigInt, T.U32],
      paramsValue: [drop, index, 0n, 0],
    });
    if (length === 0 || length > MAX_PATH_CHARS) throw new Error("Invalid dropped file path.");
    const buffer = Buffer.alloc((length + 1) * 2);
    const copied = load({
      library: "t3-file-drop-shell32",
      funcName: "DragQueryFileW",
      retType: T.U32,
      paramsType: [T.BigInt, T.U32, T.U8Array, T.U32],
      paramsValue: [drop, index, buffer, length + 1],
    });
    if (copied !== length) throw new Error("Cannot read dropped file path.");
    return buffer.toString("utf16le", 0, length * 2);
  };
  return {
    installReceiver: (hwnd) =>
      load({
        library: "t3-file-drop-receiver",
        funcName: "T3InstallFileDrop",
        retType: T.U32,
        paramsType: [T.BigInt, T.U32],
        paramsValue: [hwnd, NATIVE_FILE_DROP_MESSAGE],
      }),
    refreshReceiver: (hwnd) =>
      load({
        library: "t3-file-drop-receiver",
        funcName: "T3RefreshFileDrop",
        retType: T.U32,
        paramsType: [T.BigInt],
        paramsValue: [hwnd],
      }),
    enableReceiver: (hwnd, enabled) => {
      load({
        library: "t3-file-drop-receiver",
        funcName: "T3EnableFileDrop",
        retType: T.Void,
        paramsType: [T.BigInt, T.I32],
        paramsValue: [hwnd, enabled ? 1 : 0],
      });
    },
    disposeReceiver: (hwnd) => {
      load({
        library: "t3-file-drop-receiver",
        funcName: "T3UninstallFileDrop",
        retType: T.Void,
        paramsType: [T.BigInt],
        paramsValue: [hwnd],
      });
    },
    retainOleDropTarget: (hwnd) => {
      const target = BigInt(
        load({
          library: "t3-file-drop-user32",
          funcName: "GetPropW",
          retType: T.BigInt,
          paramsType: [T.BigInt, T.U8Array],
          paramsValue: [hwnd, Buffer.from("OleDropTargetInterface\0", "utf16le")],
        }).toString(),
      );
      if (target === 0n) return 0n;
      const pointer = Buffer.alloc(8);
      setOlePointer(pointer, target);
      return pointer.readBigUInt64LE();
    },
    releaseOleDropTarget: (target) => {
      const pointer = Buffer.alloc(8);
      pointer.writeBigUInt64LE(target);
      setOlePointer(pointer, 0n);
    },
    registerOleDropTarget: (hwnd, target) =>
      load({
        library: "t3-file-drop-ole32",
        funcName: "RegisterDragDrop",
        retType: T.I32,
        paramsType: [T.BigInt, T.BigInt],
        paramsValue: [hwnd, target],
      }),
    isElevated: () => {
      const process = load({
        library: "t3-file-drop-kernel32",
        funcName: "GetCurrentProcess",
        retType: T.BigInt,
        paramsType: [],
        paramsValue: [],
      });
      const tokenBytes = Buffer.alloc(8);
      const opened = load({
        library: "t3-file-drop-advapi32",
        funcName: "OpenProcessToken",
        retType: T.I32,
        paramsType: [T.BigInt, T.U32, T.U8Array],
        paramsValue: [process, 8, tokenBytes],
      });
      if (!opened) throw new Error("Cannot query Windows file-drop token.");
      const token = tokenBytes.readBigUInt64LE();
      try {
        const elevation = Buffer.alloc(4);
        const queried = load({
          library: "t3-file-drop-advapi32",
          funcName: "GetTokenInformation",
          retType: T.I32,
          paramsType: [T.BigInt, T.I32, T.U8Array, T.U32, T.U8Array],
          paramsValue: [token, 20, elevation, elevation.length, Buffer.alloc(4)],
        });
        if (!queried) throw new Error("Cannot query Windows file-drop elevation.");
        return elevation.readUInt32LE() !== 0;
      } finally {
        load({
          library: "t3-file-drop-kernel32",
          funcName: "CloseHandle",
          retType: T.I32,
          paramsType: [T.BigInt],
          paramsValue: [token],
        });
      }
    },
    revokeOleDropTarget: (hwnd) =>
      load({
        library: "t3-file-drop-ole32",
        funcName: "RevokeDragDrop",
        retType: T.I32,
        paramsType: [T.BigInt],
        paramsValue: [hwnd],
      }),
    allowMessage: (hwnd, message) =>
      load({
        library: "t3-file-drop-user32",
        funcName: "ChangeWindowMessageFilterEx",
        retType: T.I32,
        paramsType: [T.BigInt, T.U32, T.U32, T.BigInt],
        paramsValue: [hwnd, message, 1, 0n],
      }) !== 0,
    queryCount: (drop) =>
      load({
        library: "t3-file-drop-shell32",
        funcName: "DragQueryFileW",
        retType: T.U32,
        paramsType: [T.BigInt, T.U32, T.BigInt, T.U32],
        paramsValue: [drop, 0xffff_ffff, 0n, 0],
      }),
    queryPath,
    queryPoint: (drop) => {
      const point = Buffer.alloc(8);
      const client = load({
        library: "t3-file-drop-shell32",
        funcName: "DragQueryPoint",
        retType: T.I32,
        paramsType: [T.BigInt, T.U8Array],
        paramsValue: [drop, point],
      });
      return client ? { x: point.readInt32LE(), y: point.readInt32LE(4) } : null;
    },
    finish: (drop) => {
      load({
        library: "t3-file-drop-shell32",
        funcName: "DragFinish",
        retType: T.Void,
        paramsType: [T.BigInt],
        paramsValue: [drop],
      });
    },
    dpi: (hwnd) =>
      load({
        library: "t3-file-drop-user32",
        funcName: "GetDpiForWindow",
        retType: T.U32,
        paramsType: [T.BigInt],
        paramsValue: [hwnd],
      }) || 96,
  };
}
