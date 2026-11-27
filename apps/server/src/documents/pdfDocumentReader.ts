// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { publishedPdfReadScope } from "./pdfRevisionPaths.ts";
import { decodePdfPages, listPendingPdfJobs, pdfJobKey, readStoredPdfJob } from "./pdfIndexJob.ts";
import { readPdfPages } from "./pdfPageReader.ts";

/** Read a bounded, source-identified page range without handing a whole PDF to a model. */
type PdfPageRead = {
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly attachmentId: string;
  readonly page: number;
  readonly offset: number;
  readonly maxBytes: number;
};
export function readPdfDocumentRange(input: PdfPageRead) {
  const pinned = publishedPdfReadScope(input);
  return readPinnedPdfDocumentRange(pinned ? { ...input, ...pinned } : input);
}
export async function readPinnedPdfDocumentRange(
  input: PdfPageRead & { jobKey?: string; contentHash?: string },
) {
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 128 ||
    input.maxBytes > 8192
  )
    throw new RangeError("문서 페이지 또는 읽기 크기가 올바르지 않습니다.");
  const target = input.jobKey ? await readStoredPdfJob(input.stateDir, input.jobKey) : null;
  const candidates = input.jobKey
    ? target?.complete && target.contentHash === input.contentHash
      ? [target]
      : []
    : (await listPendingPdfJobs(input.stateDir)).completed;
  const matches = candidates.filter(
    (job) =>
      job.projectId === input.projectId &&
      job.threadId === input.threadId &&
      job.attachment.id === input.attachmentId,
  );
  if (matches.length !== 1)
    throw new Error("현재 대화에서 완료된 PDF 색인을 하나로 확인하지 못했습니다.");
  const job = matches[0]!;
  if (input.page > job.totalPages) throw new RangeError("PDF 페이지 범위를 벗어났습니다.");
  const original = resolveAttachmentPath({
    attachmentsDir: input.attachmentsDir,
    attachment: job.attachment,
  });
  if (!original) throw new Error("PDF 원본 경로를 확인하지 못했습니다.");
  const bytes = await Fs.readFile(original);
  if (Crypto.createHash("sha256").update(bytes).digest("hex") !== job.contentHash)
    throw new Error("PDF 원본이 바뀌어 이전 색인을 사용할 수 없습니다.");
  const key =
    input.jobKey ?? pdfJobKey(job.projectId, job.attachment.id, job.contentHash, job.ocrEnabled);
  const first = job.batchFiles
    .map((name) => {
      const match = new RegExp(`^${key}-([1-9][0-9]*)\\.txt$`).exec(name);
      if (!match) throw new Error("PDF 페이지 색인 경로가 올바르지 않습니다.");
      return Number(match[1]);
    })
    .filter((page) => page <= input.page)
    .sort((a, b) => b - a)[0];
  if (first === undefined) throw new Error("요청한 페이지의 색인을 찾지 못했습니다.");
  const sidecar = Path.join(
    input.stateDir,
    "document-rag",
    "pdf-jobs",
    `${key}-${first}.pages.json`,
  );
  let page;
  try {
    const sidecarText = await Fs.readFile(sidecar, "utf8");
    const digest = job.pageDigests?.find((entry) => entry.file === Path.basename(sidecar));
    if (!digest) throw Object.assign(new Error("No verified page cache"), { code: "ENOENT" });
    if (Crypto.createHash("sha256").update(sidecarText).digest("hex") !== digest.sha256)
      throw new Error("PDF 페이지 색인 내용이 변경되었습니다.");
    const saved = decodePdfPages(sidecarText);
    if (saved.contentHash !== job.contentHash)
      throw new Error("PDF 페이지의 원본 해시가 다릅니다.");
    page = saved.pages.find(
      (item) => item.page === input.page && item.totalPages === job.totalPages,
    );
    if (!page) throw new Error("PDF 페이지 색인이 불완전합니다.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
    const iterator = readPdfPages({
      bytes,
      fromPage: input.page,
      ...(job.ocrEnabled ? { ocrCacheDirectory: Path.join(input.stateDir, "document-ocr") } : {}),
    });
    try {
      page = (await iterator.next()).value;
    } finally {
      await iterator.return(undefined);
    }
    if (!page || page.page !== input.page || page.totalPages !== job.totalPages)
      throw new Error("PDF 원본 페이지를 다시 확인하지 못했습니다.");
  }
  // Older cached pages predate visual classification; re-read the original page.
  if (!page.contentType) {
    const iterator = readPdfPages({
      bytes,
      fromPage: input.page,
      ...(job.ocrEnabled ? { ocrCacheDirectory: Path.join(input.stateDir, "document-ocr") } : {}),
    });
    try {
      page = (await iterator.next()).value;
    } finally {
      await iterator.return(undefined);
    }
    if (!page || page.page !== input.page || page.totalPages !== job.totalPages)
      throw new Error("PDF 원본 페이지를 다시 확인하지 못했습니다.");
  }
  if (
    input.offset > page.text.length ||
    (input.offset > 0 &&
      /[\uD800-\uDBFF]/.test(page.text[input.offset - 1] ?? "") &&
      /[\uDC00-\uDFFF]/.test(page.text[input.offset] ?? ""))
  )
    throw new RangeError("PDF 페이지 읽기 위치가 올바르지 않습니다.");
  let text = "",
    end = input.offset,
    size = 0;
  for (const character of page.text.slice(input.offset)) {
    const length = Buffer.byteLength(character, "utf8");
    if (size + length > input.maxBytes) break;
    text += character;
    size += length;
    end += character.length;
  }
  const next =
    end < page.text.length
      ? { page: input.page, offset: end }
      : input.page < job.totalPages
        ? { page: input.page + 1, offset: 0 }
        : null;
  return {
    file: job.attachment.name,
    messageId: job.messageId,
    contentHash: job.contentHash,
    page: input.page,
    totalPages: job.totalPages,
    offset: input.offset,
    next,
    text,
    status: page.status,
    contentType: page.contentType ?? "unknown",
    hasTable: page.hasTable ?? false,
    visualReviewRequired: page.visualReviewRequired ?? page.status === "empty",
    ...(page.message ? { message: page.message } : {}),
    issuePages: job.issues.slice(0, 20),
    issuePageCount: job.issues.length,
  };
}
