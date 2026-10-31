import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  WorkspaceTaskInboxError,
  type WorkspaceTaskArtifact,
  type WorkspaceTaskReceipt,
} from "@t3tools/contracts";

const isInboxError = Schema.is(WorkspaceTaskInboxError);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
export const makeWorkspaceTaskChecks = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contained = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  const readTaskFile = Effect.fn("TaskChecks.readFile")(
    function* (cwd: string, relative: string) {
      if (path.isAbsolute(relative) || !contained(path.resolve(cwd), path.resolve(cwd, relative)))
        return yield* new WorkspaceTaskInboxError({
          message: `프로젝트 밖의 파일은 검사할 수 없습니다: ${relative}`,
        });
      const resolved = path.resolve(cwd, relative);
      if (!(yield* fs.exists(resolved))) return null;
      const actual = yield* fs.realPath(resolved);
      if (!contained(yield* fs.realPath(cwd), actual))
        return yield* new WorkspaceTaskInboxError({
          message: `프로젝트 밖으로 연결된 파일입니다: ${relative}`,
        });
      const stat = yield* fs.stat(actual);
      if (stat.type !== "File" || Number(stat.size) > 8 * 1024 * 1024)
        return yield* new WorkspaceTaskInboxError({
          message: `일반 파일이며 8MB 이하여야 합니다: ${relative}`,
        });
      const contents = yield* fs.readFile(actual);
      if (contents.byteLength > 8 * 1024 * 1024)
        return yield* new WorkspaceTaskInboxError({
          message: `검사 중 파일이 8MB를 초과했습니다: ${relative}`,
        });
      return {
        sha256: NodeCrypto.createHash("sha256").update(contents).digest("hex"),
        contents: new TextDecoder().decode(contents),
        size: contents.length,
      };
    },
    Effect.mapError((cause) =>
      isInboxError(cause) ? cause : new WorkspaceTaskInboxError({ message: cause.message, cause }),
    ),
  );

  const checkTaskArtifact = Effect.fn("TaskChecks.artifact")(function* (input: {
    cwd: string;
    artifact: WorkspaceTaskArtifact;
    baseline: string | null;
    now: string;
  }) {
    const result = yield* readTaskFile(input.cwd, input.artifact.path).pipe(
      Effect.map((file) => {
        if (!file || !file.contents.trim())
          return { file, error: "산출물이 없거나 비어 있습니다." };
        if (file.sha256 === input.baseline)
          return {
            file,
            error: "실행 전 파일과 내용이 같아 이번 실행의 산출물인지 확인할 수 없습니다.",
          };
        if (input.artifact.format === "json") {
          const decoded = decodeJson(file.contents);
          if (Option.isNone(decoded)) return { file, error: "올바른 JSON 파일이 아닙니다." };
          const value = decoded.value;
          if (
            input.artifact.requiredKeys.some(
              (key) => typeof value !== "object" || value === null || !Object.hasOwn(value, key),
            )
          )
            return { file, error: "JSON 필수 필드가 없습니다." };
        }
        return { file, error: null };
      }),
      Effect.catch((error) => Effect.succeed({ file: null, error: error.message })),
    );
    return {
      kind: "artifact",
      label: input.artifact.path,
      passed: result.error === null,
      exitCode: null,
      sha256: result.file?.sha256 ?? null,
      output:
        result.error ?? `${result.file?.size ?? 0} bytes · ${input.artifact.format} 검사 통과`,
      observedAt: input.now,
    } satisfies WorkspaceTaskReceipt;
  });
  return { readTaskFile, checkTaskArtifact };
});
