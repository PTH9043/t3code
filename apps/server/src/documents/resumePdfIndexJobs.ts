// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  indexPdfJob,
  listPendingPdfJobs,
  retirePdfJob,
  purgePdfJobsForThread,
} from "./pdfIndexJob.ts";
import * as NodePath from "node:path";

class PdfRecoveryError extends Schema.TaggedErrorClass<PdfRecoveryError>()("PdfRecoveryError", {
  cause: Schema.Defect(),
}) {}

export const resumePdfIndexJobs = Effect.fn("resumePdfIndexJobs")(function* (input: {
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly queries: Pick<ProjectionSnapshotQueryShape, "getThreadRuntimeContext">;
}) {
  const fs = yield* FileSystem.FileSystem;
  const runPromise = Effect.runPromiseWith(
    yield* Effect.context<FileSystem.FileSystem | Path.Path>(),
  );
  const pending = yield* Effect.tryPromise(() => listPendingPdfJobs(input.stateDir)).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("PDF 색인 복구 기록을 읽지 못했습니다", { cause }).pipe(
            Effect.as({ jobs: [], retiring: [], completed: [], invalid: 0 }),
          ),
    ),
  );
  if (pending.invalid)
    yield* Effect.logWarning("읽을 수 없는 PDF 색인 복구 기록이 있습니다", {
      count: pending.invalid,
    });
  const orphaned = new Set<string>();
  const examined = new Set<string>();
  const retainedByThread = new Map<string, ReadonlySet<string>>();
  const projectByThread = new Map<string, string>();
  for (const job of [...pending.jobs, ...pending.retiring, ...pending.completed]) {
    if (examined.has(job.threadId)) continue;
    examined.add(job.threadId);
    yield* Effect.gen(function* () {
      const thread = yield* input.queries.getThreadRuntimeContext(job.threadId, { messages: true });
      const retained = Option.isSome(thread)
        ? new Set(thread.value.messages.map((message) => message.id))
        : undefined;
      if (Option.isNone(thread)) orphaned.add(job.threadId);
      else if (retained) {
        retainedByThread.set(job.threadId, retained);
        projectByThread.set(job.threadId, thread.value.projectId);
      }
      yield* Effect.tryPromise({
        try: () => purgePdfJobsForThread(input.stateDir, job.threadId, retained),
        catch: (cause) => new PdfRecoveryError({ cause }),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("PDF 원본 대화 확인에 실패해 정리를 건너뜁니다", {
              threadId: job.threadId,
              cause,
            }),
      ),
    );
  }
  for (const job of pending.retiring) {
    if (
      orphaned.has(job.threadId) ||
      projectByThread.get(job.threadId) !== job.projectId ||
      !retainedByThread.get(job.threadId)?.has(job.messageId)
    )
      continue;
    yield* Effect.tryPromise({
      try: () =>
        retirePdfJob({
          job,
          dir: NodePath.join(input.stateDir, "document-rag", "pdf-jobs"),
          dispatch: (command) => runPromise(input.engine.dispatch(command)),
          writeAtomic: (filePath, contents) =>
            runPromise(writeFileStringAtomically({ filePath, contents })),
        }),
      catch: (cause) => new PdfRecoveryError({ cause }),
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("기존 PDF 색인 정리를 재개하지 못했습니다", {
              attachmentId: job.attachment.id,
              cause,
            }),
      ),
    );
  }
  for (const job of pending.jobs) {
    yield* Effect.gen(function* () {
      const thread = yield* input.queries.getThreadRuntimeContext(job.threadId, { messages: true });
      if (Option.isNone(thread) || thread.value.projectId !== job.projectId) return;
      const message = thread.value.messages.find((item) => item.id === job.messageId);
      if (
        !message?.attachments?.some((item) => item.type === "file" && item.id === job.attachment.id)
      )
        return;
      const original = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment: job.attachment,
      });
      if (!original || !(yield* fs.exists(original))) return;
      const bytes = yield* fs.readFile(original);
      if (Crypto.createHash("sha256").update(bytes).digest("hex") !== job.contentHash) {
        return yield* Effect.logWarning("PDF 원본이 바뀌어 이전 색인을 재개하지 않았습니다", {
          attachmentId: job.attachment.id,
        });
      }
      yield* Effect.tryPromise({
        try: (signal) =>
          indexPdfJob({
            projectId: job.projectId,
            threadId: job.threadId,
            messageId: job.messageId,
            createdAt: job.createdAt,
            attachment: job.attachment,
            bytes,
            stateDir: input.stateDir,
            attachmentsDir: input.attachmentsDir,
            ocrEnabled: job.ocrEnabled,
            signal,
            dispatch: (command) => runPromise(input.engine.dispatch(command)),
            writeAtomic: (filePath, contents) =>
              runPromise(writeFileStringAtomically({ filePath, contents })),
          }),
        catch: (cause) => new PdfRecoveryError({ cause }),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("PDF 색인 재개에 실패했습니다", {
              attachmentId: job.attachment.id,
              cause,
            }),
      ),
    );
  }
});
