// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as NodeFs from "node:fs";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readPdfDocumentRange } from "./pdfDocumentReader.ts";
import { withPdfAnalysisLock } from "./pdfAnalysisCleanup.ts";
import { withPdfAttachmentLock } from "./pdfIndexJob.ts";
import { hasPdfVisualReceipt } from "./pdfPageVisual.ts";

type Cursor = { page: number; offset: number };
export type PdfAnalysisScope = {
  stateDir: string;
  attachmentsDir: string;
  projectId: string;
  threadId: string;
  attachmentId: string;
  verificationContext?: string;
};
type Header = {
  project_id: string;
  thread_id: string;
  attachment_id: string;
  content_hash: string;
  total_pages: number;
  page: number | null;
  offset: number | null;
};
const hash = (s: string) => Crypto.createHash("sha256").update(s).digest("hex");
const pathFor = (scope: PdfAnalysisScope, id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new Error("분석 기록 ID가 올바르지 않습니다.");
  return Path.join(scope.stateDir, "document-rag", "pdf-analysis", id + ".sqlite");
};
function open(scope: PdfAnalysisScope, id: string): { db: DatabaseSync; header: Header } {
  const file = pathFor(scope, id);
  if (!NodeFs.existsSync(file)) throw new Error("PDF 분석 기록을 찾지 못했습니다.");
  const db = new DatabaseSync(file, { readOnly: false, open: true });
  try {
    const h = db.prepare("SELECT * FROM analysis LIMIT 1").get() as Header | undefined;
    if (
      !h ||
      h.project_id !== scope.projectId ||
      h.thread_id !== scope.threadId ||
      h.attachment_id !== scope.attachmentId
    )
      throw new Error("현재 대화의 PDF 분석 기록이 아닙니다.");
    return { db, header: h };
  } catch (e) {
    db.close();
    throw e;
  }
}
function status(db: DatabaseSync, id: string, h: Header) {
  const counts = db
    .prepare(
      "SELECT count(*) total, sum(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) failed FROM chunks",
    )
    .get() as { total: number; failed: number | null };
  const failedPages = (
    db
      .prepare("SELECT DISTINCT page FROM chunks WHERE outcome='failed' ORDER BY page LIMIT 20")
      .all() as { page: number }[]
  ).map((r) => r.page);
  const failedPageCount = (
    db.prepare("SELECT count(DISTINCT page) AS total FROM chunks WHERE outcome='failed'").get() as {
      total: number;
    }
  ).total;
  return {
    runId: id,
    contentHash: h.content_hash,
    totalPages: h.total_pages,
    next: h.page === null ? null : { page: h.page, offset: h.offset! },
    processedRanges: counts.total - (counts.failed ?? 0),
    failedRanges: counts.failed ?? 0,
    failedPages,
    failedPageCount,
    readComplete: h.page === null,
    reportedComplete: h.page === null && failedPageCount === 0,
  };
}
const tokenFor = (
  id: string,
  contentHash: string,
  page: number,
  offset: number,
  maxBytes: number,
  text: string,
  next: Cursor | null,
) => hash(JSON.stringify([id, contentHash, page, offset, maxBytes, text, next]));
async function readAnalysisChunk(scope: PdfAnalysisScope, start: Cursor, maxBytes: number) {
  let cursor: Cursor | null = start;
  let totalBytes = 0;
  const segments: Array<{
    page: number;
    offset: number;
    text: string;
    status: string;
    contentType: string;
    hasTable: boolean;
    visualReviewRequired: boolean;
    message?: string;
  }> = [];
  let last: Awaited<ReturnType<typeof readPdfDocumentRange>> | undefined;
  while (cursor && segments.length < 16) {
    const prefix = segments.length ? "\n" : "";
    const available = maxBytes - totalBytes - Buffer.byteLength(prefix);
    if (available < 128) break;
    const part = await readPdfDocumentRange({ ...scope, ...cursor, maxBytes: available });
    if (segments.length && (part.status === "empty" || part.status === "failed" || part.message))
      break;
    segments.push({
      page: part.page,
      offset: part.offset,
      text: part.text,
      status: part.status,
      contentType: part.contentType,
      hasTable: part.hasTable,
      visualReviewRequired: part.visualReviewRequired,
      ...(part.message ? { message: part.message } : {}),
    });
    totalBytes += Buffer.byteLength(prefix) + Buffer.byteLength(part.text);
    last = part;
    cursor = part.next;
    if (
      part.status === "empty" ||
      part.status === "failed" ||
      part.message ||
      cursor?.page === part.page
    )
      break;
  }
  if (!last || segments.length === 0) throw new Error("PDF 분석 구간을 읽지 못했습니다.");
  return {
    ...last,
    page: start.page,
    offset: start.offset,
    next: cursor,
    text: segments.map((segment) => segment.text).join("\n"),
    segments,
    status: segments.some((segment) => segment.status === "failed")
      ? "failed"
      : segments.some((segment) => segment.status === "empty")
        ? "empty"
        : "text",
  };
}
export async function startPdfAnalysis(scope: PdfAnalysisScope) {
  return withPdfAttachmentLock(scope.projectId, scope.attachmentId, async () => {
    const first = await readPdfDocumentRange({ ...scope, page: 1, offset: 0, maxBytes: 128 });
    const id = Crypto.randomUUID(),
      file = pathFor(scope, id);
    await Fs.mkdir(Path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TABLE analysis(project_id TEXT NOT NULL, thread_id TEXT NOT NULL, attachment_id TEXT NOT NULL, message_id TEXT NOT NULL, content_hash TEXT NOT NULL, total_pages INTEGER NOT NULL, page INTEGER, offset INTEGER) STRICT; CREATE TABLE chunks(seq INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, page INTEGER NOT NULL, offset INTEGER NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('processed','failed')), note TEXT NOT NULL) STRICT;",
      );
      db.prepare("INSERT INTO analysis VALUES(?,?,?,?,?,?,?,?)").run(
        scope.projectId,
        scope.threadId,
        scope.attachmentId,
        first.messageId,
        first.contentHash,
        first.totalPages,
        1,
        0,
      );
      const h = db.prepare("SELECT * FROM analysis").get() as Header;
      return status(db, id, h);
    } finally {
      db.close();
    }
  });
}
export async function readPdfAnalysis(scope: PdfAnalysisScope, id: string, maxBytes: number) {
  const { db, header: h } = open(scope, id);
  let snapshot;
  try {
    snapshot = status(db, id, h);
  } finally {
    db.close();
  }
  if (!snapshot.next) return { ...snapshot, chunk: null };
  const part = await readAnalysisChunk(scope, snapshot.next, maxBytes);
  if (part.contentHash !== h.content_hash || part.totalPages !== h.total_pages)
    throw new Error("분석 도중 PDF 원본이 변경되었습니다.");
  return {
    ...snapshot,
    chunk: {
      ...part,
      maxBytes,
      token: tokenFor(id, part.contentHash, part.page, part.offset, maxBytes, part.text, part.next),
    },
  };
}
export async function recordPdfAnalysis(
  scope: PdfAnalysisScope,
  id: string,
  maxBytes: number,
  token: string,
  outcome: "processed" | "failed",
  note: string,
  visualReceipt?: string,
) {
  if (
    Buffer.byteLength(note, "utf8") > 1024 ||
    Buffer.byteLength(JSON.stringify(note), "utf8") > 1200 ||
    !note.trim()
  )
    throw new Error("분석 근거 또는 실패 사유를 입력하세요 (최대 1024바이트).");
  return withPdfAnalysisLock(pathFor(scope, id), async () => {
    const { db, header: h } = open(scope, id);
    try {
      const prior = db.prepare("SELECT outcome,note FROM chunks WHERE token=?").get(token) as
        | { outcome: string; note: string }
        | undefined;
      if (prior) {
        if (prior.outcome !== outcome || prior.note !== note)
          throw new Error("같은 구간의 다른 결과가 이미 기록되었습니다.");
        return status(db, id, h);
      }
      if (h.page === null || h.offset === null)
        throw new Error("이미 모든 구간의 처리가 기록되었습니다.");
      const part = await readAnalysisChunk(scope, { page: h.page, offset: h.offset }, maxBytes);
      if (
        part.contentHash !== h.content_hash ||
        part.totalPages !== h.total_pages ||
        tokenFor(id, part.contentHash, part.page, part.offset, maxBytes, part.text, part.next) !==
          token
      )
        throw new Error("PDF 구간이 변경됐거나 순서가 맞지 않습니다. 다시 읽으세요.");
      if (
        ((part.status === "empty" && part.contentType !== "blank") ||
          part.status === "failed" ||
          part.message) &&
        outcome === "processed" &&
        !hasPdfVisualReceipt(scope, part.page, part.contentHash, visualReceipt)
      )
        throw new Error("읽지 못한 페이지는 이미지 확인 영수증이 없으면 실패로 기록해야 합니다.");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO chunks(token,page,offset,outcome,note) VALUES(?,?,?,?,?)").run(
          token,
          part.page,
          part.offset,
          outcome,
          note,
        );
        db.prepare("UPDATE analysis SET page=?, offset=?").run(
          part.next?.page ?? null,
          part.next?.offset ?? null,
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return status(db, id, db.prepare("SELECT * FROM analysis").get() as Header);
    } finally {
      db.close();
    }
  });
}
export async function pdfAnalysisStatus(scope: PdfAnalysisScope, id: string, after = 0) {
  const { db, header: h } = open(scope, id);
  try {
    const rows = db
      .prepare(
        "SELECT seq,page,offset,outcome,note FROM chunks WHERE seq > ? ORDER BY seq LIMIT 51",
      )
      .all(after) as Array<{
      seq: number;
      page: number;
      offset: number;
      outcome: string;
      note: string;
    }>;
    const records: typeof rows = [];
    let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row), "utf8");
      if (bytes + size > 1800 || records.length >= 50) break;
      records.push(row);
      bytes += size;
    }
    return {
      ...status(db, id, h),
      records,
      nextAfter: records.length < rows.length ? (records.at(-1)?.seq ?? after) : null,
    };
  } finally {
    db.close();
  }
}
