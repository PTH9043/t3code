// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { ChatAttachment } from "@t3tools/contracts";
import {
  GENERATED_RESULT_MAX_BYTES,
  GENERATED_TEXT_PREVIEW_BYTES,
  extractResultFileLinks,
  resultFileType,
  resultPathKey,
} from "@t3tools/shared/generatedResults";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { attachmentRelativePath, toSafeThreadAttachmentSegment } from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";

export type ResultSource =
  | { readonly path: string; readonly native?: boolean }
  | { readonly data: string; readonly mimeType: string; readonly name?: string };
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const record = (value: unknown) => Option.getOrUndefined(decodeRecord(value));
const string = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Only generation outputs are published; image reads and browser screenshots stay tool activity. */
export function nativeResultSources(data: unknown): ResultSource[] {
  const outer = record(data);
  if (!outer) return [];
  const item = record(outer.item) ?? outer;
  const type = string(item.type) ?? "";
  const tool = string(item.tool) ?? string(outer.toolName) ?? "";
  const nativeGeneration = /^(imageGeneration|image_generation)$/i.test(type);
  const generationTool =
    /image[_ -]?gen|generate[_ -]?(image|picture)|create[_ -]?image|render[_ -]?image/i.test(tool);
  if (!nativeGeneration && !generationTool) return [];
  if (
    item.status === "failed" ||
    record(outer.result)?.is_error === true ||
    record(item.result)?.isError === true
  )
    return [];
  const found: ResultSource[] = [];
  if (nativeGeneration) {
    const output =
      string(item.savedPath) ??
      string(item.outputPath) ??
      string(item.output_path) ??
      string(item.path);
    const result = string(item.result);
    if (output) found.push({ path: output, native: true });
    else if (result && /^(?:[A-Za-z]:[\\/]|\/|\.\.?\/)/.test(result))
      found.push({ path: result, native: true });
    else if (result) found.push({ data: result, mimeType: string(item.mimeType) ?? "image/png" });
  }
  let visited = 0;
  const visit = (value: unknown, depth: number) => {
    if (depth > 7 || ++visited > 160 || found.length >= 16) return;
    if (Array.isArray(value)) {
      value.slice(0, 32).forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const node = record(value);
    if (!node) return;
    const source = record(node.source);
    const mimeType = string(node.mimeType) ?? string(node.media_type) ?? string(source?.media_type);
    const bytes = string(node.data) ?? string(node.blob) ?? string(source?.data);
    if (mimeType?.startsWith("image/") && bytes) {
      found.push({
        data: bytes,
        mimeType,
        ...(string(node.name) ? { name: string(node.name)! } : {}),
      });
    }
    const imageUrl = string(node.image_url) ?? string(record(node.image_url)?.url);
    if (imageUrl?.startsWith("data:image/")) {
      const mime = imageUrl.slice(5, imageUrl.indexOf(";"));
      found.push({ data: imageUrl, mimeType: mime });
    }
    const output =
      string(node.output_file) ??
      string(node.output_path) ??
      string(node.savedPath) ??
      string(node.path) ??
      string(node.uri);
    if (output && resultFileType(resultPathKey(output))?.kind === "image")
      found.push({ path: output, native: true });
    for (const key of [
      "result",
      "content",
      "structuredContent",
      "resource",
      "images",
      "files",
      "outputs",
    ])
      visit(node[key], depth + 1);
  };
  visit(item.result, 0);
  if (outer !== item) visit(outer.result, 0);
  return found;
}

function inside(root: string, file: string) {
  const relative = NodePath.relative(root, file);
  return (
    relative !== ".." && !relative.startsWith(".." + NodePath.sep) && !NodePath.isAbsolute(relative)
  );
}

function validImage(bytes: Uint8Array, mimeType: string) {
  const prefix = Buffer.from(bytes.subarray(0, 16));
  if (mimeType === "image/png")
    return (
      bytes.length >= 24 &&
      prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      Buffer.from(bytes).readUInt32BE(16) > 0 &&
      Buffer.from(bytes).readUInt32BE(20) > 0
    );
  if (mimeType === "image/jpeg") return prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
  if (mimeType === "image/webp")
    return prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WEBP";
  if (mimeType === "image/gif") return /^GIF8[79]a/.test(prefix.toString("ascii"));
  if (mimeType === "image/avif") return prefix.toString("ascii", 4, 8) === "ftyp";
  // SVG is displayed as a non-executable image, never mounted as HTML.
  if (mimeType === "image/svg+xml")
    return /<svg(?:\s|>)/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)));
  return false;
}

export async function collectGeneratedAttachments(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceRoot: string;
  readonly attachmentsDir: string;
  readonly text?: string;
  readonly sources?: ReadonlyArray<ResultSource>;
}) {
  const sources: ResultSource[] = [
    ...(input.sources ?? []),
    ...extractResultFileLinks(input.text ?? "").map((file) => ({ path: file })),
  ];
  const attachments: ChatAttachment[] = [];
  const failures: string[] = [];
  if (sources.length === 0) return { attachments, failures };
  const root = await NodeFSP.realpath(input.workspaceRoot);
  const segment = toSafeThreadAttachmentSegment(input.threadId);
  if (!segment) return { attachments, failures: ["Invalid result thread"] };
  await NodeFSP.mkdir(input.attachmentsDir, { recursive: true });
  for (const source of sources.slice(0, 32)) {
    try {
      let bytes: Buffer;
      let name: string;
      let sourcePath: string | undefined;
      let mimeType: string;
      let language: string | undefined;
      let kind: "image" | "text";
      if ("path" in source) {
        const normalized = resultPathKey(source.path);
        if (!normalized) throw new Error("Unsupported result URI");
        const target = NodePath.resolve(root, normalized);
        if (!source.native && !inside(root, target))
          throw new Error("Result is outside this workspace");
        const real = await NodeFSP.realpath(target);
        if ((!source.native || resultFileType(real)?.kind !== "image") && !inside(root, real))
          throw new Error("Result is outside this workspace");
        const handle = await NodeFSP.open(real, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > GENERATED_RESULT_MAX_BYTES)
            throw new Error("Result is not a supported file or exceeds 64 MB");
          name = NodePath.basename(real);
          const format = resultFileType(name);
          if (!format) continue;
          kind = format.kind;
          mimeType = format.mimeType;
          language = "language" in format ? format.language : undefined;
          bytes = await handle.readFile();
          if (bytes.length > GENERATED_RESULT_MAX_BYTES)
            throw new Error("Result changed size while reading");
          const after = await handle.stat();
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
            throw new Error("Result is still being written");
          sourcePath = real;
        } finally {
          await handle.close();
        }
      } else {
        if (source.data.length > Math.ceil(GENERATED_RESULT_MAX_BYTES / 3) * 4 + 256)
          throw new Error("Result exceeds 64 MB");
        const decoded = parseBase64DataUrl(
          source.data.startsWith("data:")
            ? source.data
            : "data:" + source.mimeType + ";base64," + source.data,
        );
        if (!decoded) throw new Error("Invalid result encoding");
        bytes = Buffer.from(decoded.base64, "base64");
        if (bytes.length > GENERATED_RESULT_MAX_BYTES) throw new Error("Result exceeds 64 MB");
        mimeType = decoded.mimeType;
        const extension = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/webp": "webp",
          "image/gif": "gif",
          "image/avif": "avif",
          "image/svg+xml": "svg",
        }[mimeType];
        if (!extension) throw new Error("Unsupported generated image type");
        name = source.name ? NodePath.basename(source.name) : "generated-image." + extension;
        kind = "image";
      }
      if (kind === "image" && !validImage(bytes, mimeType)) throw new Error("Invalid image data");
      if (kind === "text") new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const key = NodeCrypto.createHash("sha256")
        .update(input.threadId + "\0" + input.turnId + "\0" + mimeType + "\0" + sha256)
        .digest("hex")
        .slice(0, 32);
      const uuid = [
        key.slice(0, 8),
        key.slice(8, 12),
        key.slice(12, 16),
        key.slice(16, 20),
        key.slice(20),
      ].join("-");
      const result = {
        kind,
        sha256,
        ...(sourcePath ? { sourcePath } : {}),
        ...(language ? { language } : {}),
        ...(mimeType === "image/png" && bytes.length >= 24
          ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
          : {}),
      };
      const attachment: ChatAttachment = {
        type: kind === "image" ? "image" : "file",
        id: segment + "-" + uuid,
        name: name.slice(0, 255),
        mimeType,
        sizeBytes: bytes.length,
        result,
      };
      if (attachments.some((existing) => existing.id === attachment.id)) continue;
      const snapshot = NodePath.join(input.attachmentsDir, attachmentRelativePath(attachment));
      const stored = await NodeFSP.readFile(snapshot).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (stored) {
        if (NodeCrypto.createHash("sha256").update(stored).digest("hex") !== sha256)
          throw new Error("Result snapshot checksum mismatch");
      } else {
        const temporary = snapshot + "." + NodeCrypto.randomUUID() + ".pending";
        try {
          await NodeFSP.writeFile(temporary, bytes, { flag: "wx" });
          await NodeFSP.rename(temporary, snapshot);
        } finally {
          await NodeFSP.unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
      attachments.push(attachment);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "Could not read result");
    }
  }
  return { attachments, failures };
}

export async function readGeneratedTextPreview(file: string) {
  const handle = await NodeFSP.open(file, "r");
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, GENERATED_TEXT_PREVIEW_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead < size;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead), {
      stream: truncated,
    });
    return { text, byteLength: size, truncated };
  } finally {
    await handle.close();
  }
}
