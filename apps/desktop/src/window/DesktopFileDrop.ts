// @effect-diagnostics nodeBuiltinImport:off - Native drop callbacks read files outside an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { DesktopFileDrop } from "@t3tools/contracts";
import {
  DesktopFileDropStatus,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_SOURCE_BYTES,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { BrowserWindow } from "electron";
import {
  installWindowsDropHandler,
  loadWindowsDropApi,
  type WindowsDrop,
} from "./WindowsFileDrop.ts";
import {
  FILE_DROP_CHANNEL,
  FILE_DROP_STATUS_CHANNEL,
  INTERNAL_DRAG_CHANNEL,
} from "../ipc/channels.ts";
const isDropStatus = Schema.is(DesktopFileDropStatus);

const imageTypes: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".jpe": "image/jpeg",
  ".pjpeg": "image/jpeg",
  ".pjp": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/vnd.microsoft.icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/** Detect common image bytes even when Explorer supplies an unusual or missing extension. */
export function droppedFileMimeType(name: string, bytes: Uint8Array): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    Buffer.from(bytes.subarray(1, 8)).equals(Buffer.from("PNG\r\n\x1a\n"))
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  const header = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  return imageTypes[NodePath.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Read only the files supplied by a native drop; the renderer cannot request arbitrary paths. */
export async function readDesktopDrop(
  drop: WindowsDrop,
  zoomFactor: number,
  targetUrl: string,
): Promise<DesktopFileDrop> {
  const files: DesktopFileDrop["files"][number][] = [];
  let totalBytes = 0;
  const errors: string[] = drop.overflow
    ? ["메시지 하나에 파일을 최대 8개까지 첨부할 수 있습니다."]
    : [];
  for (const filename of drop.paths) {
    const name = NodePath.basename(filename);
    try {
      if (!NodePath.isAbsolute(filename) || filename.includes("\0"))
        throw new Error("Invalid path");
      const type = imageTypes[NodePath.extname(name).toLowerCase()] ?? "application/octet-stream";
      const limit = type.startsWith("image/")
        ? PROVIDER_SEND_TURN_MAX_IMAGE_SOURCE_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
      const handle = await NodeFSP.open(filename, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > limit) {
          errors.push(`'${name}' 파일은 비어 있거나 폴더이거나 첨부 용량 제한을 초과했습니다.`);
          continue;
        }
        if (totalBytes + stat.size > PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES) {
          errors.push(`'${name}' 파일을 포함하면 첨부 합계 50MB를 초과합니다. 나누어 첨부하세요.`);
          continue;
        }
        // A bounded read also covers a file that grows after stat().
        const bytes = Buffer.alloc(stat.size + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await handle.read(bytes, size, bytes.length - size, size);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        if (size !== stat.size) {
          errors.push(`'${name}' 파일이 읽는 동안 변경되었습니다. 다시 첨부하세요.`);
          continue;
        }
        files.push({
          name,
          type: droppedFileMimeType(name, bytes.subarray(0, size)),
          bytes: bytes.subarray(0, size),
        });
        totalBytes += size;
      } finally {
        await handle.close();
      }
    } catch {
      errors.push(`'${name}' 파일을 읽지 못했습니다.`);
    }
  }
  return {
    files,
    targetUrl,
    x: drop.x / zoomFactor,
    y: drop.y / zoomFactor,
    pointSource: drop.pointSource ?? "payload",
    error: errors.length ? errors.join("\n") : null,
  };
}

export async function installDesktopFileDrop(
  window: BrowserWindow,
  receiverLibraryPath: string,
  onError: (error: unknown) => void,
  onReceive?: (fileCount: number) => void,
  onStatus?: (status: DesktopFileDropStatus) => void,
): Promise<void> {
  const api = await loadWindowsDropApi(receiverLibraryPath);
  if (window.isDestroyed()) return;
  window.webContents.ipc.on(FILE_DROP_STATUS_CHANNEL, (event, status: unknown) => {
    if (event.senderFrame === window.webContents.mainFrame && isDropStatus(status))
      onStatus?.(status);
  });
  const controller = installWindowsDropHandler(
    window,
    api,
    (drop) => {
      onReceive?.(drop.paths.length);
      const zoom = window.webContents.getZoomFactor();
      const targetUrl = window.webContents.getURL();
      void readDesktopDrop(drop, zoom, targetUrl)
        .then((payload) => {
          if (!window.isDestroyed() && !window.webContents.isDestroyed())
            window.webContents.send(FILE_DROP_CHANNEL, payload);
        })
        .catch(onError);
    },
    onError,
  );
  const setInternalDragActive = (active: boolean) => {
    try {
      controller.setInternalDragActive(active);
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };
  window.webContents.ipc.on(INTERNAL_DRAG_CHANNEL, (event, active: unknown) => {
    event.returnValue =
      event.senderFrame === window.webContents.mainFrame &&
      typeof active === "boolean" &&
      setInternalDragActive(active);
  });
  window.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) setInternalDragActive(false);
  });
  window.webContents.on("render-process-gone", () => setInternalDragActive(false));
  window.webContents.on("did-finish-load", () => controller.refresh());
  window.once("closed", () => controller.dispose());
}
