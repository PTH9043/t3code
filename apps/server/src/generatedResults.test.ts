// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { GENERATED_TEXT_PREVIEW_BYTES } from "@t3tools/shared/generatedResults";
import { attachmentRelativePath } from "./attachmentStore.ts";
import {
  collectGeneratedAttachments,
  nativeResultSources,
  readGeneratedTextPreview,
} from "./generatedResults.ts";
const roots: string[] = [];
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-generated-results-"));
  roots.push(root);
  const workspaceRoot = NodePath.join(root, "project"),
    attachmentsDir = NodePath.join(root, "attachments");
  await NodeFSP.mkdir(workspaceRoot);
  return { root, workspaceRoot, attachmentsDir, threadId: "thread-output", turnId: "turn-1" };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      NodePath.dirname(root) !== NodeOS.tmpdir() ||
      !NodePath.basename(root).startsWith("t3-generated-results-")
    )
      throw new Error("Unsafe fixture cleanup");
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
describe("generated result snapshots", () => {
  it("preserves original bytes after the workspace file is changed and removed", async () => {
    const input = await fixture();
    const file = NodePath.join(input.workspaceRoot, "한글 결과.txt");
    const original = Buffer.from("\uFEFF첫 결과\r\nhttps://example.com/reference\r\n");
    await NodeFSP.writeFile(file, original);
    const first = await collectGeneratedAttachments({ ...input, text: "[결과](<" + file + ">)" });
    expect(first.failures).toEqual([]);
    expect(first.attachments).toHaveLength(1);
    const attachment = first.attachments[0]!;
    await NodeFSP.writeFile(file, "revised");
    const second = await collectGeneratedAttachments({
      ...input,
      turnId: "turn-2",
      text: "[결과](<" + file + ">)",
    });
    expect(second.attachments[0]?.id).not.toBe(attachment.id);
    await NodeFSP.unlink(file);
    expect(
      await NodeFSP.readFile(
        NodePath.join(input.attachmentsDir, attachmentRelativePath(attachment)),
      ),
    ).toEqual(original);
    expect(attachment.result).toMatchObject({ kind: "text", language: "txt" });
  });
  it("publishes native image bytes once per turn without putting bytes in message metadata", async () => {
    const input = await fixture();
    const sources = nativeResultSources({
      item: { type: "imageGeneration", result: png, status: "completed" },
    });
    const first = await collectGeneratedAttachments({ ...input, sources });
    const second = await collectGeneratedAttachments({ ...input, sources });
    expect(first.failures).toEqual([]);
    expect(first.attachments).toHaveLength(1);
    expect(first.attachments[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      result: { kind: "image", width: 1, height: 1 },
    });
    expect(first.attachments[0]?.id).toBe(second.attachments[0]?.id);
    expect(JSON.stringify(first.attachments)).not.toContain(png);
  });
  it("reads Claude MCP image outputs and excludes image inspection", () => {
    const data = {
      toolName: "mcp__image_gen__imagegen",
      result: {
        type: "tool_result",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        ],
      },
    };
    expect(nativeResultSources(data)).toHaveLength(1);
    expect(nativeResultSources({ ...data, toolName: "mcp__browser__screenshot" })).toEqual([]);
    expect(nativeResultSources({ ...data, toolName: "Read" })).toEqual([]);
  });
  it("uses the savedPath returned by the installed Codex protocol", () => {
    expect(
      nativeResultSources({
        item: { type: "imageGeneration", savedPath: "D:/output.png", result: png },
      }),
    ).toEqual([{ path: "D:/output.png", native: true }]);
  });
  it("rejects workspace escapes, missing files, invalid images and invalid UTF-8", async () => {
    const input = await fixture();
    await NodeFSP.writeFile(NodePath.join(input.root, "outside.txt"), "outside");
    await NodeFSP.writeFile(NodePath.join(input.workspaceRoot, "bad.png"), "not png");
    await NodeFSP.writeFile(
      NodePath.join(input.workspaceRoot, "bad.txt"),
      new Uint8Array([255, 254, 0]),
    );
    const collected = await collectGeneratedAttachments({
      ...input,
      sources: [
        { path: "../outside.txt" },
        { path: "missing.txt" },
        { path: "bad.png" },
        { path: "bad.txt" },
      ],
    });
    expect(collected.attachments).toEqual([]);
    expect(collected.failures).toHaveLength(4);
  });
  it("returns a bounded UTF-8 preview without replacing a split multibyte character", async () => {
    const input = await fixture();
    const file = NodePath.join(input.workspaceRoot, "long.txt");
    const text = "가".repeat(GENERATED_TEXT_PREVIEW_BYTES);
    await NodeFSP.writeFile(file, text);
    const preview = await readGeneratedTextPreview(file);
    expect(preview.truncated).toBe(true);
    expect(preview.byteLength).toBe(Buffer.byteLength(text));
    expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(GENERATED_TEXT_PREVIEW_BYTES);
    expect(preview.text).not.toContain("�");
    expect(text.startsWith(preview.text)).toBe(true);
  });
  it("keeps results from separate threads and turns distinct", async () => {
    const input = await fixture();
    const sources = [{ data: png, mimeType: "image/png" }];
    const first = await collectGeneratedAttachments({ ...input, sources });
    const other = await collectGeneratedAttachments({
      ...input,
      threadId: "another-thread",
      sources,
    });
    expect(first.attachments[0]?.id).not.toBe(other.attachments[0]?.id);
  });
});
