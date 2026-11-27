// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import {
  ChatFileAttachment,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  WorkspaceKnowledgeItemId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { documentKnowledgeContent, DOCUMENT_PARSER_VERSION } from "./extractDocument.ts";
import { pdfDocumentKey, publishedPdfReadScope, revisionPaths } from "./pdfRevisionPaths.ts";
import { readPdfPageBatches } from "./pdfPageBatches.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { purgePdfAnalysisForThread, purgePdfAnalysisForVersion } from "./pdfAnalysisCleanup.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

const sha = (value: string | Uint8Array) => Crypto.createHash("sha256").update(value).digest("hex");
const PdfJob = Schema.Struct({
  version: Schema.Literal(1),
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: Schema.String,
  attachment: ChatFileAttachment,
  contentHash: Schema.String,
  parserVersion: Schema.String,
  ocrEnabled: Schema.Boolean,
  lastPage: Schema.Number,
  totalPages: Schema.Number,
  chars: Schema.Number,
  issues: Schema.Array(Schema.Number),
  batchFiles: Schema.Array(Schema.String),
  complete: Schema.Boolean,
  generation: Schema.optionalKey(Schema.String),
  retiring: Schema.optionalKey(Schema.Boolean),
  pageDigests: Schema.optionalKey(
    Schema.Array(Schema.Struct({ file: Schema.String, sha256: Schema.String })),
  ),
});
export type PdfJob = typeof PdfJob.Type;
const decodeJob = Schema.decodeUnknownSync(Schema.fromJsonString(PdfJob));
export async function readStoredPdfJob(stateDir: string, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid PDF job key.");
  try {
    const job = decodeJob(
      await Fs.readFile(Path.join(stateDir, "document-rag", "pdf-jobs", key + ".json"), "utf8"),
    );
    if (savedJobKey(job) !== key) throw new Error("PDF job identity mismatch.");
    return job;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}
const encodeJob = Schema.encodeSync(Schema.fromJsonString(PdfJob));
const PdfPages = Schema.Struct({
  contentHash: Schema.String,
  pages: Schema.Array(
    Schema.Struct({
      page: Schema.Number,
      totalPages: Schema.Number,
      text: Schema.String,
      status: Schema.Literals(["text", "ocr", "empty", "failed"]),
      message: Schema.optionalKey(Schema.String),
      contentType: Schema.optionalKey(
        Schema.Literals(["text", "scan", "blank", "visual", "mixed", "unknown"]),
      ),
      hasTable: Schema.optionalKey(Schema.Boolean),
      visualReviewRequired: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const encodePages = Schema.encodeSync(Schema.fromJsonString(PdfPages));
export const decodePdfPages = Schema.decodeUnknownSync(Schema.fromJsonString(PdfPages));
const savedJobKey = (job: PdfJob) =>
  sha(
    `${job.projectId}\n${job.attachment.id}\n${job.contentHash}\n${job.parserVersion}\n${job.ocrEnabled}`,
  );

export function pdfJobKey(
  projectId: string,
  attachmentId: string,
  contentHash: string,
  ocrEnabled: boolean,
) {
  return sha(
    `${projectId}\n${attachmentId}\n${contentHash}\n${DOCUMENT_PARSER_VERSION}\n${ocrEnabled}`,
  );
}

/** Persisted batch receipts are replayed with the same command ID after interruption. */
type PdfIndexInput = {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly createdAt: string;
  readonly attachment: typeof ChatFileAttachment.Type;
  readonly bytes: Uint8Array;
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly ocrEnabled: boolean;
  readonly signal?: AbortSignal;
  readonly dispatch: (
    command: Parameters<OrchestrationEngineShape["dispatch"]>[0],
  ) => Promise<unknown>;
  readonly writeAtomic: (file: string, text: string) => Promise<void>;
};
type PdfIndexResult = { job: PdfJob; textPath: string; resumed: boolean };
const runningJobs = new Map<string, Promise<unknown>>();

async function serializeAttachment<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = runningJobs.get(key);
  const current = (async () => {
    if (previous) await previous.catch(() => undefined);
    return run();
  })();
  runningJobs.set(key, current);
  try {
    return await current;
  } finally {
    if (runningJobs.get(key) === current) runningJobs.delete(key);
  }
}

/** Serialize all version changes and analysis starts for an attachment. */
export function withPdfAttachmentLock<T>(
  projectId: string,
  attachmentId: string,
  run: () => Promise<T>,
) {
  return serializeAttachment(`${projectId}\n${attachmentId}`, run);
}

async function unlinkIfPresent(file: string) {
  try {
    await Fs.unlink(file);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}

/** Archive only batches named by the old job, including a possibly accepted last batch. */
type RetireInput = {
  readonly job: PdfJob;
  readonly dir: string;
  readonly dispatch: PdfIndexInput["dispatch"];
  readonly writeAtomic: PdfIndexInput["writeAtomic"];
};
export function retirePdfJob(input: RetireInput) {
  return serializeAttachment(`${input.job.projectId}\n${input.job.attachment.id}`, () =>
    retirePdfJobUnlocked(input),
  );
}
async function retirePdfJobUnlocked(input: RetireInput) {
  const { job, dir } = input;
  const key = savedJobKey(job);
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !Number.isSafeInteger(job.lastPage) ||
    job.lastPage < 0 ||
    !Number.isSafeInteger(job.totalPages) ||
    job.lastPage > job.totalPages ||
    job.batchFiles.some((name) => !new RegExp(`^${key}-[1-9][0-9]*\\.txt$`).test(name))
  )
    throw new Error("PDF 색인 정리 기록이 올바르지 않습니다.");
  const jobPath = Path.join(dir, `${key}.json`);
  await input.writeAtomic(jobPath, encodeJob({ ...job, retiring: true }));
  const starts = new Set(job.batchFiles.map((name) => Number(name.slice(key.length + 1, -4))));
  starts.add(job.lastPage + 1);
  for (const first of starts) {
    await input.dispatch({
      type: "project.knowledge.item.archive",
      commandId: CommandId.make(
        `pdf-retire:${sha(`${key}:${job.generation ?? "legacy"}:${first}`)}`,
      ),
      projectId: job.projectId,
      itemId: WorkspaceKnowledgeItemId.make(`pdf-${key.slice(0, 32)}-${first}`),
      createdAt: job.createdAt,
    });
  }
  await purgePdfAnalysisForVersion(
    Path.dirname(Path.dirname(dir)),
    job.projectId,
    job.attachment.id,
    job.contentHash,
  );
  for (const file of [
    ...job.batchFiles,
    ...job.batchFiles.map((name) => name.replace(/\.txt$/, ".pages.json")),
    `${key}-${job.lastPage + 1}.txt`,
    `${key}-${job.lastPage + 1}.pages.json`,
    `${key}.txt`,
    `${key}.txt.tmp`,
  ])
    await unlinkIfPresent(Path.join(dir, file));
  await unlinkIfPresent(jobPath);
}

async function retireOtherPdfJobs(input: PdfIndexInput, currentKey: string, dir: string) {
  const entries = await Fs.readdir(dir);
  for (const name of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(name) || name === `${currentKey}.json`) continue;
    let old: PdfJob;
    try {
      old = decodeJob(await Fs.readFile(Path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (savedJobKey(old) !== name.slice(0, -5)) continue;
    if (old.projectId === input.projectId && old.attachment.id === input.attachment.id)
      await retirePdfJobUnlocked({
        job: old,
        dir,
        dispatch: input.dispatch,
        writeAtomic: input.writeAtomic,
      });
  }
}

/** Remove only this thread's derived PDF files after its index projection is removed. */
export async function purgePdfJobsForThread(
  stateDir: string,
  threadId: string,
  retainedMessageIds?: ReadonlySet<string>,
) {
  const dir = Path.join(stateDir, "document-rag", "pdf-jobs");
  const entries = await Fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    let initial: PdfJob;
    try {
      initial = decodeJob(await Fs.readFile(Path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (
      initial.threadId !== threadId ||
      retainedMessageIds?.has(initial.messageId) ||
      savedJobKey(initial) !== name.slice(0, -5)
    )
      continue;
    await serializeAttachment(`${initial.projectId}\n${initial.attachment.id}`, async () => {
      let job: PdfJob;
      try {
        job = decodeJob(await Fs.readFile(Path.join(dir, name), "utf8"));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return;
        throw error;
      }
      const key = savedJobKey(job);
      if (
        job.threadId !== threadId ||
        retainedMessageIds?.has(job.messageId) ||
        name !== `${key}.json` ||
        !Number.isSafeInteger(job.lastPage) ||
        job.lastPage < 0 ||
        job.batchFiles.some((file) => !new RegExp(`^${key}-[1-9][0-9]*\\.txt$`).test(file))
      )
        throw new Error("삭제할 PDF 색인 기록이 올바르지 않습니다.");
      const doc = pdfDocumentKey({ ...job, attachmentId: job.attachment.id });
      const revisionDir = Path.dirname(revisionPaths(stateDir, doc, 1).stateDir);
      await Fs.rm(revisionDir, { recursive: true, force: true });
      for (const file of [
        ...job.batchFiles,
        ...job.batchFiles.map((name) => name.replace(/\.txt$/, ".pages.json")),
        `${key}-${job.lastPage + 1}.txt`,
        `${key}-${job.lastPage + 1}.pages.json`,
        `${key}.txt`,
        `${key}.txt.tmp`,
        name,
      ])
        await unlinkIfPresent(Path.join(dir, file));
    });
  }
  await purgePdfAnalysisForThread(stateDir, threadId, retainedMessageIds);
}

export async function indexPdfJob(input: PdfIndexInput): Promise<PdfIndexResult> {
  // Different versions of the same attachment must not write concurrently.
  const lockKey = `${input.projectId}\n${input.attachment.id}`;
  return serializeAttachment(lockKey, async () => {
    input.signal?.throwIfAborted();
    const published = publishedPdfReadScope({ ...input, attachmentId: input.attachment.id });
    if (published) {
      const job = await readStoredPdfJob(published.stateDir, published.jobKey);
      if (!job?.complete || job.contentHash !== published.contentHash)
        throw new Error("Published PDF checkpoint is unavailable.");
      return {
        job,
        textPath: Path.join(
          published.stateDir,
          "document-rag",
          "pdf-jobs",
          published.jobKey + ".txt",
        ),
        resumed: true,
      };
    }
    return runPdfIndexJob(input);
  });
}

async function runPdfIndexJob(input: PdfIndexInput): Promise<PdfIndexResult> {
  const contentHash = sha(input.bytes);
  const key = pdfJobKey(input.projectId, input.attachment.id, contentHash, input.ocrEnabled);
  const dir = Path.join(input.stateDir, "document-rag", "pdf-jobs");
  const jobPath = Path.join(dir, `${key}.json`);
  const textPath = Path.join(dir, `${key}.txt`);
  const original = resolveAttachmentPath({
    attachmentsDir: input.attachmentsDir,
    attachment: input.attachment,
  });
  if (!original) throw new Error("PDF 첨부 원본 경로가 올바르지 않습니다.");
  await Fs.mkdir(dir, { recursive: true });
  let job: PdfJob = {
    version: 1,
    projectId: input.projectId,
    threadId: input.threadId,
    messageId: input.messageId,
    createdAt: input.createdAt,
    attachment: input.attachment,
    contentHash,
    parserVersion: DOCUMENT_PARSER_VERSION,
    ocrEnabled: input.ocrEnabled,
    lastPage: 0,
    totalPages: 0,
    chars: 0,
    issues: [],
    batchFiles: [],
    complete: false,
    generation: Crypto.randomUUID(),
  };
  let resumed = false;
  try {
    const saved = decodeJob(await Fs.readFile(jobPath, "utf8"));
    if (
      saved.contentHash !== contentHash ||
      saved.projectId !== input.projectId ||
      saved.attachment.id !== input.attachment.id ||
      saved.parserVersion !== DOCUMENT_PARSER_VERSION
    )
      throw new Error("PDF 색인 기록이 원본과 일치하지 않습니다.");
    if (
      !Number.isSafeInteger(saved.lastPage) ||
      saved.lastPage < 0 ||
      !Number.isSafeInteger(saved.totalPages) ||
      saved.lastPage > saved.totalPages ||
      saved.batchFiles.some((file) => !new RegExp(`^${key}-[1-9][0-9]*\\.txt$`).test(file))
    )
      throw new Error("PDF 색인 복구 기록이 올바르지 않습니다.");
    if (saved.retiring) {
      await retirePdfJobUnlocked({
        job: saved,
        dir,
        dispatch: input.dispatch,
        writeAtomic: input.writeAtomic,
      });
      await input.writeAtomic(jobPath, encodeJob(job));
    } else {
      job = saved;
      resumed = true;
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
    await input.writeAtomic(jobPath, encodeJob(job));
  }
  await retireOtherPdfJobs(input, key, dir);
  if (
    job.complete &&
    !(await Fs.stat(textPath).then(
      () => true,
      () => false,
    ))
  ) {
    job = { ...job, complete: false };
  }
  if (!job.complete) {
    const generation = job.generation ? `:${job.generation}` : "";
    for await (const batch of readPdfPageBatches({
      bytes: input.bytes,
      fromPage: job.lastPage + 1,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(job.ocrEnabled ? { ocrCacheDirectory: Path.join(input.stateDir, "document-ocr") } : {}),
    })) {
      input.signal?.throwIfAborted();
      const sections = batch.pages
        .filter((page) => page.text.trim())
        .map((page) => ({
          location: `페이지 ${page.page}${page.status === "ocr" ? " · OCR" : ""}`,
          text: page.text,
        }));
      const knowledge = documentKnowledgeContent(sections);
      const batchFile = `${key}-${batch.firstPage}.txt`;
      if (knowledge.content) {
        await input.dispatch({
          type: "project.knowledge.item.upsert",
          commandId: CommandId.make(`pdf-index:${key}${generation}:${batch.firstPage}`),
          projectId: job.projectId,
          itemId: WorkspaceKnowledgeItemId.make(`pdf-${key.slice(0, 32)}-${batch.firstPage}`),
          provenance: { threadId: job.threadId },
          kind: "rag-source",
          title: job.attachment.name,
          content: knowledge.content,
          status: "active",
          origin: "imported",
          relativeFolder: null,
          scope: "project",
          tags: ["attachment-document", `sha256-${contentHash}`, "pdf-page-batch"],
          research: {
            query: job.attachment.name,
            capturedAt: job.createdAt,
            verification: "unverified",
            sources: [original, textPath],
            attachment: {
              threadId: job.threadId,
              messageId: job.messageId,
              attachmentId: job.attachment.id,
              name: job.attachment.name,
              contentHash,
              parserVersion: DOCUMENT_PARSER_VERSION,
              partial: true,
              locations: knowledge.locations,
            },
          },
          originalChars: sections.reduce((sum, section) => sum + section.text.length, 0),
          storedChars: knowledge.content.length,
          createdAt: job.createdAt,
        });
      }
      await input.writeAtomic(Path.join(dir, batchFile), knowledge.content);
      const pageFile = batchFile.replace(/\.txt$/, ".pages.json");
      const pageData = encodePages({ contentHash, pages: batch.pages });
      await input.writeAtomic(Path.join(dir, pageFile), pageData);
      job = {
        ...job,
        lastPage: batch.lastPage,
        totalPages: batch.totalPages,
        chars: job.chars + sections.reduce((sum, section) => sum + section.text.length, 0),
        issues: [
          ...job.issues,
          ...batch.pages
            .filter(
              (page) =>
                (page.status === "empty" && page.contentType !== "blank") ||
                page.status === "failed" ||
                page.message !== undefined,
            )
            .map((page) => page.page),
        ],
        batchFiles: [...job.batchFiles, batchFile],
        pageDigests: [...(job.pageDigests ?? []), { file: pageFile, sha256: sha(pageData) }],
      };
      await input.writeAtomic(jobPath, encodeJob(job));
    }
    const temp = `${textPath}.tmp`;
    const output = await Fs.open(temp, "w");
    try {
      for (const file of job.batchFiles) {
        input.signal?.throwIfAborted();
        await output.writeFile(await Fs.readFile(Path.join(dir, file)));
      }
    } finally {
      await output.close();
    }
    await Fs.rename(temp, textPath);
    await input.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`pdf-index-finished:${key}${generation}`),
      threadId: job.threadId,
      createdAt: job.createdAt,
      activity: {
        id: EventId.make(`pdf-index-finished:${key}${generation}`),
        kind: "document-rag.pdf-index-finished",
        tone: "info",
        summary: `PDF 색인: ${job.lastPage}/${job.totalPages}쪽${job.issues.length ? ` · 확인 필요 ${job.issues.length}쪽` : ""}`,
        payload: { attachmentId: job.attachment.id, pages: job.totalPages, issuePages: job.issues },
        turnId: null,
        createdAt: job.createdAt,
      },
    });
    job = { ...job, complete: true };
    await input.writeAtomic(jobPath, encodeJob(job));
  }
  return { job, textPath, resumed };
}

export async function listPendingPdfJobs(
  stateDir: string,
): Promise<{ jobs: PdfJob[]; retiring: PdfJob[]; completed: PdfJob[]; invalid: number }> {
  const dir = Path.join(stateDir, "document-rag", "pdf-jobs");
  const entries = await Fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const jobs: PdfJob[] = [];
  const retiring: PdfJob[] = [];
  const completed: PdfJob[] = [];
  let invalid = 0;
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
    try {
      const job = decodeJob(await Fs.readFile(Path.join(dir, entry), "utf8"));
      if (entry !== `${savedJobKey(job)}.json`) {
        invalid++;
      } else if (job.retiring) retiring.push(job);
      else if (!job.complete) jobs.push(job);
      else completed.push(job);
    } catch {
      invalid++;
    }
  }
  return { jobs, retiring, completed, invalid };
}
