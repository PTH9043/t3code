import * as DateTime from "effect/DateTime";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import {
  createAttachmentId,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { upgradeModelAvailable, upgradeRoomAllowsCommand } from "../upgradeRoom.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as Option from "effect/Option";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { taskConditionsError } from "./taskConditions.ts";
import { clientTurnRequestDigest } from "./turnRequestDigest.ts";

function withNewAttachmentFiles<A, E, R>(
  fileSystem: FileSystem.FileSystem,
  work: (
    write: (file: string, bytes: Uint8Array) => Effect.Effect<void, PlatformError>,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const allocated: string[] = [];
  const write = (file: string, bytes: Uint8Array) =>
    Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(file, { flag: "wx" });
          allocated.push(file);
          yield* restore(handle.writeAll(bytes));
        }),
      ),
    );
  return work(write).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.forEach(
            allocated,
            (file) =>
              fileSystem
                .remove(file, { force: true })
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Could not remove incomplete attachment", { cause }),
                  ),
                ),
            { concurrency: 1, discard: true },
          ).pipe(Effect.uninterruptible)
        : Effect.void,
    ),
  );
}

/** Remove only files allocated for a turn definitively rejected before commit. */
export const discardRejectedTurnAttachments = (
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    yield* Effect.forEach(
      command.message.attachments,
      (attachment) => {
        const file = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        return file
          ? fileSystem.remove(file, { force: true })
          : Effect.logWarning("Could not resolve a rejected turn attachment for cleanup", {
              attachmentId: attachment.id,
            });
      },
      { concurrency: 1, discard: true },
    );
  });

/** Remove only image copies allocated for this normalized answer attempt. */
export const discardAnswerAttemptImages = (
  command: Extract<OrchestrationCommand, { type: "project.collaboration.run.answer" }>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const root = NodePath.resolve(config.attachmentsDir);
    yield* Effect.forEach(
      command.imageReferences ?? [],
      (reference) => {
        const file = NodePath.resolve(reference.path);
        const id = parseAttachmentIdFromRelativePath(NodePath.basename(file));
        const segment = id ? parseThreadSegmentFromAttachmentId(id) : null;
        if (
          NodePath.dirname(file) !== root ||
          !segment ||
          segment !== toSafeThreadAttachmentSegment(command.runId)
        )
          return Effect.logWarning("Could not verify a question image for cleanup");
        return fileSystem.remove(file, { force: true });
      },
      { concurrency: 1, discard: true },
    );
  });

function formatQuestionImageReference(name: string, file: string): string {
  return `사용자가 첨부한 이미지: ${JSON.stringify(name)}; 서버 파일: ${JSON.stringify(file.replaceAll("\\", "/"))}. 이미지를 열어 답변에 참고하세요.`;
}

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    if (canonicalCommand.type === "thread.turn.start") {
      const conditionsError = taskConditionsError(canonicalCommand);
      if (conditionsError !== null)
        return yield* new OrchestrationDispatchCommandError({ message: conditionsError });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    if (serverConfig.upgradeRoom) {
      if (!upgradeRoomAllowsCommand(command))
        return yield* new OrchestrationDispatchCommandError({
          message: "전용 업그레이드 방에서 허용되지 않는 명령입니다.",
        });
      if ("modelSelection" in command && command.modelSelection) {
        const registry = yield* Effect.serviceOption(ProviderRegistry);
        if (
          Option.isNone(registry) ||
          !upgradeModelAvailable(command.modelSelection, yield* registry.value.getProviders)
        )
          return yield* new OrchestrationDispatchCommandError({
            message: "등록된 계정과 모델을 다시 선택하세요.",
          });
      }
    }
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    const normalizeLongTermMemoryRoot = (memoryRoot: string, createIfMissing: boolean) =>
      workspacePaths.normalizeWorkspaceRoot(memoryRoot, { createIfMissing }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: `Invalid long-term memory root: ${cause.message}`,
            }),
        ),
      );

    if (canonicalCommand.type === "project.create") {
      const requestedLongTermMemoryRoot =
        canonicalCommand.longTermMemoryRoot ??
        path.join(
          serverConfig.baseDir,
          "workspaces",
          canonicalCommand.projectId,
          "memory",
          "long-term",
        );
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
        longTermMemoryRoot: yield* normalizeLongTermMemoryRoot(
          requestedLongTermMemoryRoot,
          canonicalCommand.longTermMemoryRoot === undefined ||
            canonicalCommand.createLongTermMemoryRootIfMissing === true,
        ),
        createLongTermMemoryRootIfMissing:
          canonicalCommand.longTermMemoryRoot === undefined ||
          canonicalCommand.createLongTermMemoryRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.workspace-control.update" &&
      canonicalCommand.longTermMemoryRoot !== null
    ) {
      return {
        ...canonicalCommand,
        longTermMemoryRoot: yield* normalizeLongTermMemoryRoot(
          canonicalCommand.longTermMemoryRoot,
          canonicalCommand.createLongTermMemoryRootIfMissing === true,
        ),
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.knowledge.item.upsert" &&
      canonicalCommand.relativeFolder !== null
    ) {
      return {
        ...canonicalCommand,
        relativeFolder: canonicalCommand.relativeFolder.replaceAll("\\", "/"),
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.collaboration.run.answer" &&
      canonicalCommand.images?.length
    ) {
      let totalBytes = 0;
      const validated = yield* Effect.forEach(
        canonicalCommand.images,
        (image) =>
          Effect.gen(function* () {
            const parsed = parseBase64DataUrl(image.dataUrl);
            const sizeBytes = parsed ? Buffer.byteLength(parsed.base64, "base64") : 0;
            if (
              !parsed ||
              !parsed.mimeType.startsWith("image/") ||
              sizeBytes === 0 ||
              sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            )
              return yield* new OrchestrationDispatchCommandError({
                message: `이미지 '${image.name}'을 읽을 수 없거나 크기 제한을 초과했습니다.`,
              });
            totalBytes += sizeBytes;
            if (totalBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES)
              return yield* new OrchestrationDispatchCommandError({
                message: "첨부 이미지의 합계는 50MB까지입니다.",
              });
            return { image, parsed, sizeBytes };
          }),
        { concurrency: 1 },
      );
      const imageReferences = yield* withNewAttachmentFiles(fileSystem, (write) =>
        Effect.forEach(
          validated,
          ({ image, parsed, sizeBytes }) =>
            Effect.gen(function* () {
              const id = createAttachmentId(canonicalCommand.runId);
              if (!id)
                return yield* new OrchestrationDispatchCommandError({
                  message: "이미지 보관 ID를 만들지 못했습니다.",
                });
              const file = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment: {
                  type: "image",
                  id,
                  name: image.name,
                  mimeType: parsed.mimeType.toLowerCase(),
                  sizeBytes,
                },
              });
              if (!file || file.length > 4096)
                return yield* new OrchestrationDispatchCommandError({
                  message: "이미지 보관 경로를 만들지 못했습니다.",
                });
              yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true }).pipe(
                Effect.mapError(
                  () =>
                    new OrchestrationDispatchCommandError({
                      message: "이미지 폴더를 만들지 못했습니다.",
                    }),
                ),
              );
              yield* write(file, Buffer.from(parsed.base64, "base64")).pipe(
                Effect.mapError(
                  () =>
                    new OrchestrationDispatchCommandError({
                      message: "질문 이미지를 저장하지 못했습니다.",
                    }),
                ),
              );
              return { name: image.name, path: file.replaceAll("\\", "/") };
            }),
          { concurrency: 1 },
        ),
      );
      const { images: _uploads, ...answer } = canonicalCommand;
      return { ...answer, imageReferences } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type === "thread.user-input.respond" && canonicalCommand.images?.length) {
      let totalBytes = 0;
      const validated = yield* Effect.forEach(
        canonicalCommand.images,
        ({ questionId, image }) =>
          Effect.gen(function* () {
            if (!Object.hasOwn(canonicalCommand.answers, questionId))
              return yield* new OrchestrationDispatchCommandError({
                message: "이미지에 연결된 질문을 찾을 수 없습니다.",
              });
            const answer = canonicalCommand.answers[questionId];
            const validAnswer =
              typeof answer === "string" ||
              (Array.isArray(answer) && answer.every((entry) => typeof entry === "string")) ||
              (!!answer &&
                typeof answer === "object" &&
                "answers" in answer &&
                Array.isArray(answer.answers) &&
                answer.answers.every((entry) => typeof entry === "string"));
            if (!validAnswer)
              return yield* new OrchestrationDispatchCommandError({
                message: "이미지를 연결할 질문 답변 형식이 올바르지 않습니다.",
              });
            const parsed = parseBase64DataUrl(image.dataUrl);
            const sizeBytes = parsed ? Buffer.byteLength(parsed.base64, "base64") : 0;
            if (
              !parsed ||
              !parsed.mimeType.startsWith("image/") ||
              sizeBytes === 0 ||
              sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            )
              return yield* new OrchestrationDispatchCommandError({
                message: `이미지 '${image.name}'을 읽을 수 없거나 크기 제한을 초과했습니다.`,
              });
            totalBytes += sizeBytes;
            if (totalBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES)
              return yield* new OrchestrationDispatchCommandError({
                message: "첨부 이미지의 합계는 50MB까지입니다.",
              });
            return { questionId, image, parsed, sizeBytes };
          }),
        { concurrency: 1 },
      );
      const answers = { ...canonicalCommand.answers };
      const images = yield* withNewAttachmentFiles(fileSystem, (write) =>
        Effect.forEach(
          validated,
          ({ questionId, image, parsed, sizeBytes }) =>
            Effect.gen(function* () {
              const id = createAttachmentId(canonicalCommand.threadId);
              if (!id)
                return yield* new OrchestrationDispatchCommandError({
                  message: "이미지 보관 ID를 만들지 못했습니다.",
                });
              const persisted = {
                type: "image" as const,
                id,
                name: image.name,
                mimeType: parsed.mimeType.toLowerCase(),
                sizeBytes,
              };
              const file = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment: persisted,
              });
              if (!file)
                return yield* new OrchestrationDispatchCommandError({
                  message: "이미지 보관 경로를 만들지 못했습니다.",
                });
              yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true }).pipe(
                Effect.mapError(
                  () =>
                    new OrchestrationDispatchCommandError({
                      message: "이미지 보관 폴더를 만들지 못했습니다.",
                    }),
                ),
              );
              yield* write(file, Buffer.from(parsed.base64, "base64")).pipe(
                Effect.mapError(
                  () =>
                    new OrchestrationDispatchCommandError({
                      message: "질문 이미지를 저장하지 못했습니다.",
                    }),
                ),
              );
              const reference = formatQuestionImageReference(image.name, file);
              const answer = answers[questionId];
              if (typeof answer === "string") answers[questionId] = `${answer}\n${reference}`;
              else if (Array.isArray(answer) && answer.every((entry) => typeof entry === "string"))
                answers[questionId] = [...answer, reference];
              else if (
                answer &&
                typeof answer === "object" &&
                "answers" in answer &&
                Array.isArray(answer.answers) &&
                answer.answers.every((entry) => typeof entry === "string")
              )
                answers[questionId] = { ...answer, answers: [...answer.answers, reference] };
              else
                return yield* new OrchestrationDispatchCommandError({
                  message: "이미지를 연결할 질문 답변 형식이 올바르지 않습니다.",
                });
              return { questionId, image: persisted };
            }),
          { concurrency: 1 },
        ),
      );
      return { ...canonicalCommand, answers, images } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      return canonicalCommand as OrchestrationCommand;
    }

    // Validate the whole batch before allocating decoded buffers or writing files.
    let totalBytes = 0;
    const validatedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || (attachment.type === "image" && !parsed.mimeType.startsWith("image/"))) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid ${attachment.type} attachment payload for '${attachment.name}'.`,
            });
          }

          const sizeBytes = Buffer.byteLength(parsed.base64, "base64");
          const byteLimit =
            attachment.type === "image"
              ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
              : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
          if (sizeBytes === 0 || sizeBytes > byteLimit) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' is empty or too large.`,
            });
          }

          totalBytes += sizeBytes;
          if (totalBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: "첨부 파일의 합계는 메시지당 50MB까지입니다. 나누어 보내세요.",
            });
          }
          return { attachment, parsed, sizeBytes };
        }),
      { concurrency: 1 },
    );

    const normalizedAttachments = yield* withNewAttachmentFiles(fileSystem, (write) =>
      Effect.forEach(
        validatedAttachments,
        ({ attachment, parsed, sizeBytes }) =>
          Effect.gen(function* () {
            const attachmentId = createAttachmentId(canonicalCommand.threadId);
            if (!attachmentId) {
              return yield* new OrchestrationDispatchCommandError({
                message: "Failed to create a safe attachment id.",
              });
            }

            const persistedAttachment = {
              type: attachment.type,
              id: attachmentId,
              name: attachment.name,
              mimeType: parsed.mimeType.toLowerCase(),
              sizeBytes,
            };

            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: persistedAttachment,
            });
            if (!attachmentPath) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Failed to resolve persisted path for '${attachment.name}'.`,
              });
            }

            yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
              Effect.mapError(
                () =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to create attachment directory for '${attachment.name}'.`,
                  }),
              ),
            );
            yield* write(attachmentPath, Buffer.from(parsed.base64, "base64")).pipe(
              Effect.mapError(
                () =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to persist attachment '${attachment.name}'.`,
                  }),
              ),
            );

            return persistedAttachment;
          }),
        { concurrency: 1 },
      ),
    );

    return {
      ...canonicalCommand,
      requestFingerprint: clientTurnRequestDigest(
        command as Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>,
      ),
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
