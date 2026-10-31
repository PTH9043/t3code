import * as NodeCrypto from "node:crypto";
import {
  WORKSPACE_EVIDENCE_MAX_BYTES,
  WORKSPACE_EVIDENCE_MAX_FILES,
  WORKSPACE_EVIDENCE_MAX_TOTAL_BYTES,
  WorkspaceDevelopmentError,
  type DevelopmentArtifactMediaType,
  type DevelopmentVerificationArtifact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

const isWorkspaceDevelopmentError = Schema.is(WorkspaceDevelopmentError);

const mediaTypes: Readonly<Record<string, DevelopmentArtifactMediaType>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
};

export function isEvidenceDescendant(relative: string, separator: string, absolute: boolean) {
  return !!relative && relative !== ".." && !relative.startsWith(`..${separator}`) && !absolute;
}

export const readBoundedEvidenceBytes = Effect.fn("readBoundedEvidenceBytes")(function* (
  filename: string,
  maximum: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const chunks = yield* fs
    .stream(filename, { bytesToRead: maximum + 1, chunkSize: 65_536 })
    .pipe(Stream.runCollect);
  const length = chunks.reduce((size, chunk) => size + chunk.length, 0);
  if (length > maximum) {
    return yield* new WorkspaceDevelopmentError({
      message: `결과물은 파일당 최대 ${Math.floor(maximum / 1024 / 1024)} MiB까지 보관합니다.`,
    });
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
});

export const captureVerificationArtifacts = Effect.fn("captureVerificationArtifacts")(function* (
  cwd: string,
  relativePaths: readonly string[],
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (relativePaths.length > WORKSPACE_EVIDENCE_MAX_FILES) {
    return yield* new WorkspaceDevelopmentError({
      message: "검증 결과물은 한 번에 최대 8개까지 지정할 수 있습니다.",
    });
  }
  const artifacts: DevelopmentVerificationArtifact[] = [];
  let total = 0;
  for (const relativePath of relativePaths) {
    const normalized = relativePath.replaceAll("\\", "/");
    const label = normalized.split("/").at(-1) || relativePath;
    const captured = yield* Effect.gen(function* () {
      if (
        !normalized ||
        normalized.length > 500 ||
        normalized.includes("\0") ||
        path.isAbsolute(relativePath) ||
        normalized.startsWith("/") ||
        /^[a-z]:/iu.test(normalized) ||
        normalized.split("/").some((part) => ["..", ".git", ".t3"].includes(part.toLowerCase()))
      )
        return yield* new WorkspaceDevelopmentError({
          message: "결과물은 검증 작업실 안의 상대 경로로 지정하세요.",
        });
      const extension = path.extname(normalized).toLowerCase();
      const mediaType = mediaTypes[extension];
      if (!mediaType)
        return yield* new WorkspaceDevelopmentError({
          message: "지원하는 결과물은 PNG·JPEG·WebP·PDF·HTML·TXT입니다.",
        });
      const root = yield* fs.realPath(cwd);
      const source = yield* fs.realPath(path.resolve(cwd, normalized));
      const relative = path.relative(root, source);
      if (!isEvidenceDescendant(relative, path.sep, path.isAbsolute(relative))) {
        return yield* new WorkspaceDevelopmentError({
          message: "검증 작업실 밖의 결과물은 보관할 수 없습니다.",
        });
      }
      const stat = yield* fs.stat(source);
      if (stat.type !== "File")
        return yield* new WorkspaceDevelopmentError({
          message: "결과물은 일반 파일이어야 합니다.",
        });
      if (Number(stat.size) > WORKSPACE_EVIDENCE_MAX_BYTES) {
        return yield* new WorkspaceDevelopmentError({
          message: "결과물은 파일당 최대 4 MiB까지 보관합니다.",
        });
      }
      const bytes = yield* readBoundedEvidenceBytes(source, WORKSPACE_EVIDENCE_MAX_BYTES);
      if (!bytes.length)
        return yield* new WorkspaceDevelopmentError({ message: "결과물 파일이 비어 있습니다." });
      const header = Buffer.from(bytes.subarray(0, 16));
      const valid =
        mediaType === "image/png"
          ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mediaType === "image/jpeg"
            ? header[0] === 255 && header[1] === 216 && header[2] === 255
            : mediaType === "image/webp"
              ? header.subarray(0, 4).toString() === "RIFF" &&
                header.subarray(8, 12).toString() === "WEBP"
              : mediaType === "application/pdf"
                ? header.subarray(0, 5).toString() === "%PDF-"
                : true;
      if (!valid)
        return yield* new WorkspaceDevelopmentError({
          message: "결과물 확장자와 파일 형식이 일치하지 않습니다.",
        });
      if (mediaType.startsWith("text/")) {
        yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: () =>
            new WorkspaceDevelopmentError({ message: "텍스트 결과물은 UTF-8 파일이어야 합니다." }),
        });
      }
      if (total + bytes.length > WORKSPACE_EVIDENCE_MAX_TOTAL_BYTES) {
        return yield* new WorkspaceDevelopmentError({
          message: "한 번의 검증 결과물 합계는 최대 16 MiB입니다.",
        });
      }
      yield* fs.makeDirectory(directory, { recursive: true });
      const snapshotPath = path.join(directory, `${NodeCrypto.randomUUID()}${extension}`);
      yield* fs.writeFile(snapshotPath, bytes);
      total += bytes.length;
      return {
        relativePath: normalized,
        label,
        mediaType,
        snapshotPath,
        byteLength: bytes.length,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        error: null,
      } satisfies DevelopmentVerificationArtifact;
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          relativePath: normalized,
          label,
          mediaType: null,
          snapshotPath: null,
          byteLength: null,
          sha256: null,
          error: isWorkspaceDevelopmentError(cause)
            ? cause.message
            : "결과물 파일을 보관하지 못했습니다. 경로와 파일 상태를 확인하세요.",
        } satisfies DevelopmentVerificationArtifact),
      ),
    );
    artifacts.push(captured);
  }
  return artifacts;
});
