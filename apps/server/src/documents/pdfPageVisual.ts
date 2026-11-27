// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { publishedPdfReadScope } from "./pdfRevisionPaths.ts";
import { listPendingPdfJobs } from "./pdfIndexJob.ts";
import { readPinnedPdfDocumentRange } from "./pdfDocumentReader.ts";
import { acquirePdfDocument } from "./pdfDocumentLock.ts";
import type { PdfAnalysisScope } from "./pdfAnalysisLedger.ts";

const receipts = new Map<
  string,
  {
    projectId: string;
    threadId: string;
    attachmentId: string;
    contentHash: string;
    page: number;
    verificationContext: string;
  }
>();
export function hasPdfVisualReceipt(
  scope: PdfAnalysisScope,
  page: number,
  contentHash: string,
  token: string | undefined,
) {
  const receipt = token ? receipts.get(token) : undefined;
  return (
    !!receipt &&
    receipt.projectId === scope.projectId &&
    receipt.threadId === scope.threadId &&
    receipt.attachmentId === scope.attachmentId &&
    receipt.contentHash === contentHash &&
    receipt.page === page &&
    receipt.verificationContext === (scope.verificationContext ?? "")
  );
}
export async function renderPdfPage(scope: PdfAnalysisScope, pageNumber: number) {
  const pinned = publishedPdfReadScope(scope);
  if (pinned)
    scope = { ...scope, stateDir: pinned.stateDir, attachmentsDir: pinned.attachmentsDir };
  const pageInfo = await readPinnedPdfDocumentRange({
    ...scope,
    ...pinned,
    page: pageNumber,
    offset: 0,
    maxBytes: 128,
  });
  const jobs = await listPendingPdfJobs(scope.stateDir);
  const job = jobs.completed.find(
    (item) =>
      item.projectId === scope.projectId &&
      item.threadId === scope.threadId &&
      item.attachment.id === scope.attachmentId &&
      item.contentHash === pageInfo.contentHash,
  );
  if (!job) throw new Error("PDF 원본 색인을 확인하지 못했습니다.");
  const original = resolveAttachmentPath({
    attachmentsDir: scope.attachmentsDir,
    attachment: job.attachment,
  });
  if (!original) throw new Error("PDF 원본 경로를 확인하지 못했습니다.");
  const bytes = await Fs.readFile(original);
  if (Crypto.createHash("sha256").update(bytes).digest("hex") !== pageInfo.contentHash)
    throw new Error("PDF 원본이 바뀌었습니다.");
  const release = await acquirePdfDocument();
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    Object.assign(globalThis, {
      pdfjsWorker: await import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    });
    const loading = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    try {
      const document = await loading.promise;
      const page = await document.getPage(pageNumber);
      try {
        const originalViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1800 / Math.max(originalViewport.width, originalViewport.height));
        const viewport = page.getViewport({ scale });
        const { createCanvas } = await import("@napi-rs/canvas");
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        try {
          await page.render({
            viewport,
            canvas: canvas as unknown as Parameters<typeof page.render>[0]["canvas"],
            canvasContext: canvas.getContext("2d") as unknown as Parameters<
              typeof page.render
            >[0]["canvasContext"],
          }).promise;
          const data = canvas.toBuffer("image/png");
          const token = Crypto.randomBytes(24).toString("base64url");
          if (receipts.size >= 1000) receipts.delete(receipts.keys().next().value!);
          receipts.set(token, {
            projectId: scope.projectId,
            threadId: scope.threadId,
            attachmentId: scope.attachmentId,
            contentHash: pageInfo.contentHash,
            page: pageNumber,
            verificationContext: scope.verificationContext ?? "",
          });
          return {
            file: pageInfo.file,
            page: pageNumber,
            totalPages: pageInfo.totalPages,
            contentHash: pageInfo.contentHash,
            width: canvas.width,
            height: canvas.height,
            visualReceipt: token,
            image: { mimeType: "image/png", data: data.toString("base64") },
          };
        } finally {
          canvas.width = 1;
          canvas.height = 1;
        }
      } finally {
        page.cleanup();
      }
    } finally {
      await loading.destroy();
    }
  } finally {
    release();
  }
}
