// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface PdfRevisionIdentity {
  readonly projectId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly attachmentId: string;
}

export const revisionDigest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const pdfDocumentKey = (s: PdfRevisionIdentity) =>
  revisionDigest(JSON.stringify([s.projectId, s.threadId, s.messageId, s.attachmentId]));

export function revisionPaths(
  stateDir: string,
  doc: string,
  version: number,
  attempt?: number | null,
) {
  if (!/^[a-f0-9]{64}$/.test(doc) || !Number.isSafeInteger(version) || version < 1)
    throw new Error("PDF revision identity is invalid.");
  if (attempt != null && (!Number.isSafeInteger(attempt) || attempt < 1))
    throw new Error("Invalid PDF attempt.");
  const dir = Path.join(
    stateDir,
    "document-rag",
    "pdf-revisions",
    doc,
    attempt == null ? String(version) : `${version}-${attempt}`,
  );
  return { stateDir: dir, attachmentsDir: Path.join(dir, "source") };
}

/** Pin one published version for the entire file read. Earlier immutable files remain readable. */
export function publishedPdfReadScope(input: {
  stateDir: string;
  attachmentsDir: string;
  projectId: string;
  threadId: string;
  attachmentId: string;
}) {
  const database = Path.join(input.stateDir, "state.sqlite");
  if (!existsSync(database)) return undefined;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='pdf_revision_documents'").get())
      return undefined;
    const row = db
      .prepare(`SELECT d.doc,d.published AS version,v.hash,v.job_key,v.source_attempt,
      EXISTS(SELECT 1 FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id
        WHERE t.project_id=d.project_id AND t.deleted_at IS NULL AND m.thread_id=d.thread_id AND m.message_id=d.message_id
        AND EXISTS (SELECT 1 FROM json_each(m.attachments_json) a WHERE a.value->>'id'=d.attachment_id AND a.value->>'type'='file')) AS alive
      FROM pdf_revision_documents d JOIN pdf_revision_versions v ON d.doc=v.doc AND v.version=d.published
      WHERE d.project_id=? AND d.thread_id=? AND d.attachment_id=?`)
      .get(input.projectId, input.threadId, input.attachmentId);
    if (!row) return undefined;
    if (!row.alive) throw new Error("PDF source is no longer available.");
    const version = Number(row.version);
    return {
      ...revisionPaths(
        input.stateDir,
        String(row.doc),
        version,
        row.source_attempt == null ? null : Number(row.source_attempt),
      ),
      ...(version === 1 ? { stateDir: input.stateDir } : {}),
      version,
      contentHash: String(row.hash),
      jobKey: String(row.job_key),
    };
  } finally {
    db.close();
  }
}
