// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { droppedFileMimeType, readDesktopDrop } from "./DesktopFileDrop.ts";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
async function removeFixture(directory: string) {
  const absolute = NodePath.resolve(directory);
  if (
    NodePath.dirname(absolute) !== NodePath.resolve(NodeOS.tmpdir()) ||
    !NodePath.basename(absolute).startsWith("t3-file-drop-")
  )
    throw new Error("Unexpected fixture cleanup path");
  await NodeFSP.rm(absolute, { recursive: true, force: true });
}

describe("native dropped file reading", () => {
  it("recognizes JPEG/PNG/WebP bytes and Explorer image extensions without misclassifying documents", async () => {
    expect(droppedFileMimeType("사진.jfif", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
    expect(droppedFileMimeType("사진.unknown", new Uint8Array([0xff, 0xd8, 0xff, 0xe1]))).toBe(
      "image/jpeg",
    );
    expect(droppedFileMimeType("photo", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(
      "image/png",
    );
    expect(droppedFileMimeType("photo.bin", Buffer.from("RIFF0000WEBP"))).toBe("image/webp");
    expect(droppedFileMimeType("report.pdf", Buffer.from("%PDF-1.7"))).toBe(
      "application/octet-stream",
    );
    expect(droppedFileMimeType("photo.HEIF", new Uint8Array())).toBe("image/heif");
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-file-drop-"));
    try {
      const path = NodePath.join(dir, "사진.JFIF");
      await NodeFSP.writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      const result = await readDesktopDrop(
        { paths: [path], x: 0, y: 0, overflow: false },
        1,
        "app://local",
      );
      expect(result.files[0]?.type).toBe("image/jpeg");
    } finally {
      await removeFixture(dir);
    }
  });
  it("reads images and documents without exposing local paths and preserves the route at drop time", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-file-drop-"));
    try {
      const file = NodePath.join(dir, "사진.PNG");
      await NodeFSP.writeFile(file, Buffer.from([137, 80, 78, 71]));
      const doc = NodePath.join(dir, "notes.txt");
      await NodeFSP.writeFile(doc, "hello");
      const result = await readDesktopDrop(
        { paths: [file, doc], x: 200, y: 300, overflow: false, pointSource: "message" },
        2,
        "http://localhost/draft/a",
      );
      expect(result).toMatchObject({
        targetUrl: "http://localhost/draft/a",
        x: 100,
        y: 150,
        error: null,
        pointSource: "message",
      });
      expect(result.files.map((f) => [f.name, f.type, f.bytes.length])).toEqual([
        ["사진.PNG", "image/png", 4],
        ["notes.txt", "application/octet-stream", 5],
      ]);
      expect(JSON.stringify(result)).not.toContain(dir);
    } finally {
      await removeFixture(dir);
    }
  });
  it("reports folders, empty, missing and oversized documents while retaining valid files", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-file-drop-"));
    try {
      const empty = NodePath.join(dir, "empty.txt");
      await NodeFSP.writeFile(empty, "");
      const large = NodePath.join(dir, "large.pdf");
      const handle = await NodeFSP.open(large, "w");
      await handle.truncate(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1);
      await handle.close();
      const result = await readDesktopDrop(
        {
          paths: [dir, empty, large, NodePath.join(dir, "missing.png")],
          x: 0,
          y: 0,
          overflow: true,
        },
        1,
        "app://local",
      );
      expect(result.files).toHaveLength(0);
      expect(result.error).toContain("8개");
      expect(result.error).toContain("empty.txt");
      expect(result.error).toContain("large.pdf");
      expect(result.error).toContain("missing.png");
    } finally {
      await removeFixture(dir);
    }
  });

  it("reads a 50 MB original and bounds the native batch before sending bytes to the renderer", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-file-drop-"));
    try {
      const large = NodePath.join(dir, "large.pdf");
      const handle = await NodeFSP.open(large, "w");
      await handle.truncate(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
      await handle.close();
      const extra = NodePath.join(dir, "extra.txt");
      await NodeFSP.writeFile(extra, "x");
      const result = await readDesktopDrop(
        { paths: [large, extra], x: 0, y: 0, overflow: false },
        1,
        "app://local",
      );
      expect(result.files.map((item) => [item.name, item.bytes.length])).toEqual([
        ["large.pdf", PROVIDER_SEND_TURN_MAX_FILE_BYTES],
      ]);
      expect(result.error).toContain("합계 50MB");
    } finally {
      await removeFixture(dir);
    }
  });
});
