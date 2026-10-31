import { DesignImageUploadError, type DesignImageUploadInput } from "@t3tools/contracts";
import { Effect, FileSystem, Option, Schema } from "effect";
import { ServerConfig } from "../config.ts";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const isUploadError = Schema.is(DesignImageUploadError);

export function decodeDesignImage(dataUrl: string) {
  const parsed = parseBase64DataUrl(dataUrl);
  if (!parsed || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(parsed.mimeType))
    throw new Error("PNG·JPEG·WebP·GIF 이미지를 선택하세요.");
  const bytes = Buffer.from(parsed.base64, "base64");
  if (!bytes.length || bytes.length > 8_000_000) throw new Error("이미지는 8 MB 이내여야 합니다.");
  const signature =
    parsed.mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : parsed.mimeType === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : parsed.mimeType === "image/gif"
          ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())
          : bytes.subarray(0, 4).toString() === "RIFF" &&
            bytes.subarray(8, 12).toString() === "WEBP";
  if (!signature) throw new Error("이미지 내용과 파일 형식이 다릅니다.");
  return { mimeType: parsed.mimeType, bytes };
}

export const uploadDesignImage = Effect.fn("DesignImageUpload.upload")(
  function* (input: typeof DesignImageUploadInput.Type) {
    if (Option.isNone(yield* (yield* ProjectionSnapshotQuery).getProjectShellById(input.projectId)))
      return yield* new DesignImageUploadError({ message: "프로젝트를 찾을 수 없습니다." });
    const image = yield* Effect.try({
      try: () => decodeDesignImage(input.dataUrl),
      catch: (cause) =>
        new DesignImageUploadError({
          message: cause instanceof Error ? cause.message : "이미지를 확인하세요.",
        }),
    });
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const attachmentId = createAttachmentId(`design-${input.projectId}`);
    const path = attachmentId
      ? resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: {
            type: "image",
            id: attachmentId,
            name: input.name,
            mimeType: image.mimeType,
            sizeBytes: image.bytes.length,
          },
        })
      : null;
    if (!path || !attachmentId)
      return yield* new DesignImageUploadError({
        message: "이미지 보관 경로를 만들지 못했습니다.",
      });
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(path, image.bytes);
    return { attachmentId, caption: input.name };
  },
  Effect.mapError((cause) =>
    isUploadError(cause)
      ? cause
      : new DesignImageUploadError({ message: "이미지 보관에 실패했습니다." }),
  ),
);
