import {
  CommandId,
  ApprovalRequestId,
  MessageId,
  ProjectId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type UploadChatAttachment,
  type OrchestrationEvent,
  ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import { resolveAttachmentPath, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { prepareFileAttachmentsForProvider } from "../provider/fileAttachments.ts";
import {
  discardAnswerAttemptImages,
  discardRejectedTurnAttachments,
  normalizeDispatchCommand,
} from "./Normalizer.ts";
import { clientTurnRequestDigest } from "./turnRequestDigest.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
const isClientCommand = Schema.is(ClientOrchestrationCommand);

const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(".", { prefix: "t3-file-attachments-" }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

it("enforces the total attachment limit for document-only batches at the client contract", () => {
  const file = {
    type: "file" as const,
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    dataUrl: "data:text/plain;base64,aGVsbG8=",
  };
  expect(isClientCommand(turn(Array.from({ length: 8 }, () => file)))).toBe(true);
  expect(isClientCommand(turn(Array.from({ length: 9 }, () => file)))).toBe(false);
});

function turn(attachments: UploadChatAttachment[]) {
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.make("upload-files"),
    threadId: ThreadId.make("file-test-thread"),
    message: {
      messageId: MessageId.make("file-message"),
      role: "user" as const,
      text: "Compare the attached files",
      attachments,
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    createdAt: "2026-10-12T00:00:00.000Z",
  };
}

it("binds a retried turn to its contents while ignoring server-independent timestamps", () => {
  const attachment = {
    type: "file" as const,
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    dataUrl: "data:text/plain;base64,aGVsbG8=",
  };
  const original = turn([attachment]);
  const digest = clientTurnRequestDigest(original);
  expect(clientTurnRequestDigest({ ...original, createdAt: "2026-10-13T00:00:00.000Z" })).toBe(
    digest,
  );
  expect(
    clientTurnRequestDigest({ ...original, message: { ...original.message, text: "changed" } }),
  ).not.toBe(digest);
  expect(
    clientTurnRequestDigest(turn([{ ...attachment, dataUrl: "data:text/plain;base64,d29ybGQ=" }])),
  ).not.toBe(digest);
});

it.layer(testLayer)("File attachments", (it) => {
  it.effect("does not remove an existing file when exclusive creation fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const existing = yield* fs.makeTempFileScoped({ prefix: "t3-existing-attachment-" });
        yield* fs.writeFileString(existing, "keep");
        const created: string[] = [];
        let calls = 0;
        const faulty = new Proxy(fs, {
          get(target, property, receiver) {
            if (property !== "open") return Reflect.get(target, property, receiver);
            return (...args: Parameters<typeof fs.open>) => {
              if (++calls === 2) return fs.open(existing, { flag: "wx" });
              return fs
                .open(...args)
                .pipe(Effect.tap(() => Effect.sync(() => created.push(args[0]))));
            };
          },
        });
        const image = {
          type: "image" as const,
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 1,
          dataUrl: "data:image/png;base64,YQ==",
        };
        const result = yield* normalizeDispatchCommand(turn([image, image])).pipe(
          Effect.provideService(FileSystem.FileSystem, faulty),
          Effect.exit,
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(created).toHaveLength(1);
        expect(yield* fs.exists(created[0]!)).toBe(false);
        expect(yield* fs.readFileString(existing)).toBe("keep");
      }),
    ),
  );

  it.effect("closes and removes an incomplete image when normalization is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const entered = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      let created: string | undefined;
      const faulty = new Proxy(fs, {
        get(target, property, receiver) {
          if (property !== "open") return Reflect.get(target, property, receiver);
          return (...args: Parameters<typeof fs.open>) =>
            fs.open(...args).pipe(
              Effect.map((file) => {
                created = args[0];
                return new Proxy(file, {
                  get(handle, method, fileReceiver) {
                    if (method !== "writeAll") return Reflect.get(handle, method, fileReceiver);
                    return (bytes: Uint8Array) =>
                      handle
                        .writeAll(bytes)
                        .pipe(
                          Effect.andThen(Deferred.succeed(entered, undefined)),
                          Effect.andThen(Deferred.await(never)),
                        );
                  },
                });
              }),
            );
        },
      });
      const image = {
        type: "image" as const,
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,YQ==",
      };
      const fiber = yield* normalizeDispatchCommand(turn([image])).pipe(
        Effect.provideService(FileSystem.FileSystem, faulty),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(created).toBeDefined();
      expect(yield* fs.exists(created!)).toBe(false);
    }),
  );
  it.effect("cleans only newly created files when a later attachment write fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const image = {
        type: "image" as const,
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,YQ==",
      };
      const questionRef = { nodeId: null, askedAt: "2026-10-28T00:00:00.000Z" };
      const inputs: ClientOrchestrationCommand[] = [
        turn([image, image]),
        {
          type: "project.collaboration.run.answer",
          commandId: CommandId.make("batch-answer"),
          projectId: ProjectId.make("project"),
          runId: WorkspaceCollaborationRunId.make("batch-run"),
          question: "질문",
          questionRef,
          answer: "답변",
          images: [image, image],
          createdAt: questionRef.askedAt,
        },
        {
          type: "thread.user-input.respond",
          commandId: CommandId.make("batch-question"),
          threadId: ThreadId.make("batch-thread"),
          requestId: ApprovalRequestId.make("request"),
          answers: { first: "답변" },
          images: [
            { questionId: "first", image },
            { questionId: "first", image },
          ],
          createdAt: questionRef.askedAt,
        },
      ];
      for (const input of inputs) {
        const created: string[] = [];
        const faulty = new Proxy(fs, {
          get(target, property, receiver) {
            if (property !== "open") return Reflect.get(target, property, receiver);
            return (...args: Parameters<typeof fs.open>) =>
              fs.open(...args).pipe(
                Effect.map((file) => {
                  created.push(args[0]);
                  if (created.length !== 2) return file;
                  return new Proxy(file, {
                    get(handle, method, fileReceiver) {
                      if (method !== "writeAll") return Reflect.get(handle, method, fileReceiver);
                      return (bytes: Uint8Array) =>
                        handle
                          .writeAll(bytes)
                          .pipe(Effect.andThen(Effect.die(new Error("synthetic write failure"))));
                    },
                  });
                }),
              );
          },
        });
        const result = yield* normalizeDispatchCommand(input).pipe(
          Effect.provideService(FileSystem.FileSystem, faulty),
          Effect.exit,
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(created).toHaveLength(2);
        for (const file of created) expect(yield* fs.exists(file)).toBe(false);
      }
    }),
  );
  it.effect("removes only the newly allocated attachment for a rejected turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const input = turn([
        {
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          dataUrl: "data:text/plain;base64,aGVsbG8=",
        },
      ]);
      const first = yield* normalizeDispatchCommand(input);
      const second = yield* normalizeDispatchCommand(input);
      if (first.type !== "thread.turn.start" || second.type !== "thread.turn.start")
        throw new Error("Expected turn");
      const firstPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: first.message.attachments[0]!,
      })!;
      const secondPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: second.message.attachments[0]!,
      })!;
      expect(first.requestFingerprint).toBe(second.requestFingerprint);
      expect(firstPath).not.toBe(secondPath);
      yield* discardRejectedTurnAttachments(second);
      expect(yield* fs.exists(firstPath)).toBe(true);
      expect(yield* fs.exists(secondPath)).toBe(false);
    }),
  );
  it.effect(
    "stores an orchestra question image without changing the answer or persisting its bytes in the command",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
        const input = {
          type: "project.collaboration.run.answer" as const,
          commandId: CommandId.make("meeting-question-image"),
          projectId: ProjectId.make("project"),
          runId: WorkspaceCollaborationRunId.make("meeting-run"),
          question: "계속할까요?",
          questionRef: {
            nodeId: WorkspaceTaskNodeId.make("node"),
            askedAt: "2026-10-28T00:00:00.000Z",
          },
          answer: "건너뛰기",
          images: [
            {
              type: "image" as const,
              name: "photo.png",
              mimeType: "image/png",
              sizeBytes: bytes.length,
              dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
            },
          ],
          createdAt: "2026-10-28T00:00:00.000Z",
        };
        expect(isClientCommand(input)).toBe(true);
        const normalized = yield* normalizeDispatchCommand(input);
        if (normalized.type !== "project.collaboration.run.answer")
          throw new Error("Expected answer");
        expect(normalized.answer).toBe("건너뛰기");
        expect(normalized).not.toHaveProperty("images");
        expect(normalized.imageReferences).toHaveLength(1);
        const image = normalized.imageReferences![0]!;
        expect(image.name).toBe("photo.png");
        expect(Buffer.from(yield* fs.readFile(image.path))).toEqual(bytes);
        const retry = yield* normalizeDispatchCommand(input);
        if (retry.type !== "project.collaboration.run.answer") throw new Error("Expected answer");
        const retryPath = retry.imageReferences![0]!.path;
        expect(retryPath).not.toBe(image.path);
        yield* discardAnswerAttemptImages(retry);
        expect(yield* fs.exists(retryPath)).toBe(false);
        expect(yield* fs.exists(image.path)).toBe(true);
        yield* discardAnswerAttemptImages({
          ...normalized,
          runId: WorkspaceCollaborationRunId.make("other-run"),
        });
        expect(yield* fs.exists(image.path)).toBe(true);
        let readModel = createEmptyReadModel(input.createdAt);
        const created = yield* decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("create-meeting-project"),
            projectId: input.projectId,
            title: "Questions",
            workspaceRoot: "D:/questions",
            createdAt: input.createdAt,
          },
          readModel,
        });
        const projectCreated = Array.isArray(created) ? created[0]! : created;
        readModel = yield* projectEvent(readModel, {
          ...projectCreated,
          sequence: 1,
        } as OrchestrationEvent);
        const result = yield* decideOrchestrationCommand({ command: normalized, readModel });
        const event = Array.isArray(result) ? result[0]! : result;
        expect(event.type).toBe("project.collaboration-run-answered");
        if (event.type !== "project.collaboration-run-answered")
          throw new Error("Expected answer event");
        expect(event.payload.imageReferences).toEqual([image]);
      }),
  );
  it.effect(
    "stores question images and associates each path with its answer without recording image bytes in the event",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
        const input = {
          type: "thread.user-input.respond" as const,
          commandId: CommandId.make("question-image"),
          threadId: ThreadId.make("question-thread"),
          requestId: ApprovalRequestId.make("request"),
          answers: { first: "look at this", second: ["option"] },
          images: [
            {
              questionId: "first",
              image: {
                type: "image" as const,
                name: "photo.png",
                mimeType: "image/png",
                sizeBytes: bytes.length,
                dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
              },
            },
          ],
          createdAt: "2026-10-28T00:00:00.000Z",
        };
        expect(isClientCommand(input)).toBe(true);
        const normalized = yield* normalizeDispatchCommand(input);
        if (normalized.type !== "thread.user-input.respond")
          throw new Error("Expected question response");
        const attachment = normalized.images?.[0];
        expect(attachment?.questionId).toBe("first");
        const file = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: attachment!.image,
        })!;
        expect(Buffer.from(yield* fs.readFile(file))).toEqual(bytes);
        expect(normalized.answers.first).toContain(file.replaceAll("\\", "/"));
        expect(normalized.answers.second).toEqual(["option"]);
        expect(attachment!.image).not.toHaveProperty("dataUrl");
      }),
  );

  it.effect("rejects a question image for an unknown answer before writing a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const before = yield* fs.readDirectory(config.attachmentsDir);
      const failure = yield* Effect.flip(
        normalizeDispatchCommand({
          type: "thread.user-input.respond",
          commandId: CommandId.make("bad-question-image"),
          threadId: ThreadId.make("question-thread"),
          requestId: ApprovalRequestId.make("request"),
          answers: { other: "answer" },
          images: [
            {
              questionId: "missing",
              image: {
                type: "image",
                name: "photo.png",
                mimeType: "image/png",
                sizeBytes: 1,
                dataUrl: "data:image/png;base64,YQ==",
              },
            },
          ],
          createdAt: "2026-10-28T00:00:00.000Z",
        }),
      );
      expect(failure.message).toContain("질문");
      expect(yield* fs.readDirectory(config.attachmentsDir)).toEqual(before);
    }),
  );
  it.effect(
    "accepts and persists a 50 MB original and sends its path, without adding its contents to the prompt",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const bytes = Buffer.alloc(PROVIDER_SEND_TURN_MAX_FILE_BYTES, 0x61);
        bytes.write("LARGE_ATTACHMENT_ORIGINAL");
        const expected = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const command = turn([
          {
            type: "file",
            name: "대용량 원본.txt",
            mimeType: "text/plain",
            sizeBytes: bytes.length,
            dataUrl: `data:text/plain;base64,${bytes.toString("base64")}`,
          },
        ]);
        expect(isClientCommand(command)).toBe(true);
        const normalized = yield* normalizeDispatchCommand(command);
        if (normalized.type !== "thread.turn.start") throw new Error("Expected turn command");
        const attachment = normalized.message.attachments[0]!;
        expect(attachment.sizeBytes).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
        const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!;
        const saved = yield* fs.readFile(path);
        expect(NodeCrypto.createHash("sha256").update(saved).digest("hex")).toBe(expected);
        const prepared = prepareFileAttachmentsForProvider({
          text: "Read the document",
          attachments: [attachment],
          attachmentsDir: config.attachmentsDir,
        });
        expect(prepared.attachments).toEqual([]);
        expect(prepared.text).toContain(attachment.id);
        expect(prepared.text).not.toContain("LARGE_ATTACHMENT_ORIGINAL");
        expect(prepared.text!.length).toBeLessThan(2_000);
      }),
  );

  it.effect("rejects a forged oversized batch before writing any of its files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const before = yield* fs.readDirectory(config.attachmentsDir);
      const dataUrl = `data:application/octet-stream;base64,${Buffer.alloc(26 * 1024 * 1024).toString("base64")}`;
      const command = turn(
        [0, 1].map((index) => ({
          type: "file",
          name: `part-${index}.bin`,
          mimeType: "application/octet-stream",
          sizeBytes: 1,
          dataUrl,
        })),
      );
      expect(isClientCommand(command)).toBe(true);
      const failure = yield* Effect.flip(normalizeDispatchCommand(command));
      expect(failure.message).toContain("합계");
      expect(yield* fs.readDirectory(config.attachmentsDir)).toEqual(before);
      expect(
        isClientCommand(
          turn(
            command.message.attachments.map((attachment) => ({
              ...attachment,
              sizeBytes: 26 * 1024 * 1024,
            })),
          ),
        ),
      ).toBe(false);
    }),
  );

  it.effect(
    "preserves multiple original documents and sends readable host paths alongside native images",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const originals = [
          Buffer.from("document content in UTF-8: 한글"),
          Buffer.from("%PDF-1.7\noriginal binary document"),
          Buffer.from([137, 80, 78, 71]),
        ];
        const uploads: UploadChatAttachment[] = originals.map((bytes, index) => ({
          type: index === 2 ? "image" : "file",
          name: ["회의 자료.txt", "report.pdf", "screenshot.png"][index]!,
          mimeType: ["text/plain", "application/pdf", "image/png"][index]!,
          sizeBytes: bytes.byteLength,
          dataUrl: `data:${["text/plain", "application/pdf", "image/png"][index]};base64,${bytes.toString("base64")}`,
        }));
        const normalized = yield* normalizeDispatchCommand(turn(uploads));
        if (normalized.type !== "thread.turn.start") throw new Error("Expected turn command");
        expect(normalized.message.attachments.map((item) => item.type)).toEqual([
          "file",
          "file",
          "image",
        ]);
        for (const [index, attachment] of normalized.message.attachments.entries()) {
          const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
          if (!path) throw new Error("Missing attachment path");
          expect(Buffer.from(yield* fs.readFile(path))).toEqual(originals[index]);
          expect(
            resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: attachment.id,
            }),
          ).toBe(path);
        }
        const providerInput = prepareFileAttachmentsForProvider({
          text: normalized.message.text,
          attachments: normalized.message.attachments,
          attachmentsDir: config.attachmentsDir,
        });
        expect(providerInput.attachments).toEqual([normalized.message.attachments[2]]);
        expect(providerInput.text).toContain("회의 자료.txt");
        expect(providerInput.text).toContain("report.pdf");
        expect(providerInput.text).toContain(normalized.message.attachments[0]!.id);
        expect(normalized.message.text).toBe("Compare the attached files");
      }),
  );

  it.effect("rejects malformed file data instead of saving truncated bytes", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        normalizeDispatchCommand(
          turn([
            {
              type: "file",
              name: "bad.txt",
              mimeType: "text/plain",
              sizeBytes: 3,
              dataUrl: "data:text/plain;base64,not-valid!",
            },
          ]),
        ),
      );
      expect(failure.message).toContain("Invalid file attachment payload");
    }),
  );

  it.effect("checks the actual decoded file size even if the client claims a smaller size", () =>
    Effect.gen(function* () {
      const dataUrl = `data:application/octet-stream;base64,${Buffer.alloc(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1).toString("base64")}`;
      const failure = yield* Effect.flip(
        normalizeDispatchCommand(
          turn([
            {
              type: "file",
              name: "large.bin",
              mimeType: "application/octet-stream",
              sizeBytes: 1,
              dataUrl,
            },
          ]),
        ),
      );
      expect(failure.message).toContain("too large");
    }),
  );
});
