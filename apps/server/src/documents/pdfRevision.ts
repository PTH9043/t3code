// @effect-diagnostics nodeBuiltinImport:off
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { CommandId, OrchestrationCommand, type ChatFileAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as FileSystem from "effect/FileSystem";
import type * as EffectPath from "effect/Path";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { indexPdfJob, readStoredPdfJob, decodePdfPages } from "./pdfIndexJob.ts";
import { documentKnowledgeContent } from "./extractDocument.ts";
import { pdfDocumentKey, revisionPaths, revisionDigest } from "./pdfRevisionPaths.ts";
import {
  assertRevisionOwner,
  publicationCommandId,
  revisionError,
  type PdfScope,
} from "./pdfRevisionStore.ts";

interface Context {
  stateDir: string;
  attachmentsDir: string;
  engine: Pick<OrchestrationEngineShape, "dispatch">;
}
const io = <A>(work: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: () => revisionError("Could not read or verify the PDF revision files."),
  });
const legacy = Effect.fn("legacyPdfRevision")(function* (ctx: Context, s: PdfScope) {
  const sql = yield* SqlClient.SqlClient;
  const [src] = yield* sql<{
    id: string;
    hash: string;
    parser: string;
  }>`SELECT item_id id,research_json->>'$.attachment.contentHash' hash,
    research_json->>'$.attachment.parserVersion' parser FROM projection_workspace_knowledge_items
    WHERE project_id=${s.projectId} AND source_item_id IS NULL AND status<>'archived'
      AND research_json->>'$.attachment.attachmentId'=${s.attachmentId} AND research_json->>'$.attachment.threadId'=${s.threadId}
      AND research_json->>'$.attachment.messageId'=${s.messageId}
      AND EXISTS(SELECT 1 FROM json_each(tags_json) WHERE value='pdf-page-batch') LIMIT 1`;
  if (!src) return yield* revisionError("A completed indexed PDF is required.");
  for (const ocr of [false, true]) {
    const key = revisionDigest(
      [s.projectId, s.attachmentId, src.hash, src.parser, String(ocr)].join("\n"),
    );
    if (!src.id.startsWith("pdf-" + key.slice(0, 32) + "-")) continue;
    const job = yield* io(() => readStoredPdfJob(ctx.stateDir, key));
    if (
      job?.complete &&
      job.threadId === s.threadId &&
      job.messageId === s.messageId &&
      job.contentHash === src.hash
    )
      return job;
  }
  return yield* revisionError("A completed indexed PDF is required.");
});

async function ensureSource(
  dir: string,
  attachment: ChatFileAttachment,
  bytes: Uint8Array,
  hash: string,
) {
  await Fs.mkdir(dir, { recursive: true });
  const file = resolveAttachmentPath({ attachmentsDir: dir, attachment });
  if (!file) throw Error("Invalid PDF path");
  const existing = await Fs.readFile(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (existing && revisionDigest(existing) !== hash) throw Error("Immutable source mismatch");
  if (!existing) {
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      await Fs.writeFile(temp, bytes, { flag: "wx" });
      try {
        await Fs.link(temp, file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (revisionDigest(await Fs.readFile(file)) !== hash)
          throw Error("Competing source mismatch");
      }
    } finally {
      await Fs.rm(temp, { force: true });
    }
  }
  return file;
}
type StatusRow = {
  published: number;
  hash: string;
  pages: number;
  pending: number | null;
  pending_hash: string | null;
  state: "failed" | "indexing" | null;
  last_page: number | null;
  total_pages: number | null;
  error: string | null;
};
const statusRow = (
  sql: SqlClient.SqlClient,
  doc: string,
) => sql<StatusRow>`SELECT d.published,p.hash,p.total_pages pages,d.pending,
  v.hash pending_hash,v.state,v.last_page,v.total_pages,v.error FROM pdf_revision_documents d
  JOIN pdf_revision_versions p ON p.doc=d.doc AND p.version=d.published
  LEFT JOIN pdf_revision_versions v ON v.doc=d.doc AND v.version=d.pending WHERE d.doc=${doc}`;
const status = (r: StatusRow) => ({
  published: { version: r.published, contentHash: r.hash, totalPages: r.pages },
  pending:
    r.pending === null
      ? null
      : {
          version: r.pending,
          contentHash: r.pending_hash!,
          status: r.state!,
          lastPage: r.last_page!,
          totalPages: r.total_pages!,
          error: r.error,
        },
});
export const getPdfRevisionStatus = Effect.fn("getPdfRevisionStatus")(function* (
  ctx: Context,
  s: PdfScope,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* assertRevisionOwner(sql, s);
  const [row] = yield* statusRow(sql, pdfDocumentKey(s));
  if (row) return status(row);
  const j = yield* legacy(ctx, s);
  return {
    published: { version: 1, contentHash: j.contentHash, totalPages: j.totalPages },
    pending: null,
  };
});

export const startPdfRevision = Effect.fn("startPdfRevision")(function* (
  ctx: Context,
  s: PdfScope,
  input: {
    bytes: Uint8Array;
    expectedVersion: number;
    requestId: string;
  },
) {
  const sql = yield* SqlClient.SqlClient,
    doc = pdfDocumentKey(s),
    hash = revisionDigest(input.bytes);
  yield* assertRevisionOwner(sql, s);
  const [exists] = yield* statusRow(sql, doc);
  if (!exists && input.expectedVersion !== 1)
    return yield* revisionError("The published version has changed.");
  const base = exists ? null : yield* legacy(ctx, s);
  const original = base
    ? yield* io(async () => {
        const path = resolveAttachmentPath({
          attachmentsDir: ctx.attachmentsDir,
          attachment: base.attachment,
        });
        if (!path) throw Error("Invalid source");
        const bytes = await Fs.readFile(path);
        if (revisionDigest(bytes) !== base.contentHash) throw Error("Source changed");
        await ensureSource(
          revisionPaths(ctx.stateDir, doc, 1).attachmentsDir,
          base.attachment,
          bytes,
          base.contentHash,
        );
        return bytes;
      })
    : null;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertRevisionOwner(sql, s);
      if (base && original) {
        const prefix = "pdf-" + base.batchFiles[0]!.slice(0, 32) + "-";
        yield* sql`INSERT OR IGNORE INTO pdf_revision_documents(doc,project_id,thread_id,message_id,attachment_id,name,batch_prefix,ocr,published)
        VALUES(${doc},${s.projectId},${s.threadId},${s.messageId},${s.attachmentId},${base.attachment.name},${prefix},${Number(base.ocrEnabled)},1)`;
        yield* sql`INSERT OR IGNORE INTO pdf_revision_versions(doc,version,hash,bytes,state,last_page,total_pages,job_key)
        VALUES(${doc},1,${base.contentHash},${original},'published',${base.lastPage},${base.totalPages},${base.batchFiles[0]!.slice(0, 64)})`;
      }
      const [head] = yield* statusRow(sql, doc);
      if (!head) return yield* revisionError("Published PDF could not be located.");
      const [prior] = yield* sql<{
        base_version: number;
        hash: string;
        failed_attempt: number | null;
      }>`SELECT base_version,hash,failed_attempt FROM pdf_revision_requests
      WHERE doc=${doc} AND request_id=${input.requestId}`;
      if (prior) {
        if (prior.hash !== hash || prior.base_version !== input.expectedVersion)
          return yield* revisionError("Request ID was already used for a different revision.");
        if (prior.failed_attempt !== null)
          return yield* revisionError("This failed upload was replaced. Refresh the PDF version.");
        return status(head);
      }
      if (head.published !== input.expectedVersion)
        return yield* revisionError("The published version has changed.");
      const replacing = head.pending !== null && head.pending_hash !== hash;
      if (replacing && head.state !== "failed")
        return yield* revisionError("Another PDF revision is pending.");
      if (replacing) {
        // Preserve the failed bytes and terminal outcome before replacing the
        // pending attempt. Its request IDs can never start new work on replay.
        yield* sql`INSERT INTO pdf_revision_failed_attempts(doc,version,attempt,hash,bytes,error,last_page,total_pages)
          SELECT doc,version,COALESCE(source_attempt,0),hash,bytes,error,last_page,total_pages FROM pdf_revision_versions
          WHERE doc=${doc} AND version=${head.pending} AND state='failed'`;
        yield* sql`UPDATE pdf_revision_requests SET failed_attempt=(SELECT COALESCE(source_attempt,0)
          FROM pdf_revision_versions WHERE doc=${doc} AND version=${head.pending})
          WHERE doc=${doc} AND base_version=${head.published} AND hash=${head.pending_hash} AND failed_attempt IS NULL`;
        yield* sql`DELETE FROM pdf_revision_versions WHERE doc=${doc} AND version=${head.pending} AND state='failed'`;
        yield* sql`UPDATE pdf_revision_documents SET pending=NULL WHERE doc=${doc}`;
      }
      yield* sql`INSERT INTO pdf_revision_requests(doc,request_id,base_version,hash)
        VALUES(${doc},${input.requestId},${head.published},${hash})`;
      if (!replacing && head.pending !== null) return status(head);
      if (hash === head.hash) return status((yield* statusRow(sql, doc))[0]!);
      const v = head.published + 1;
      yield* sql`INSERT INTO pdf_revision_versions(doc,version,hash,bytes,state,source_attempt)
        SELECT ${doc},${v},${hash},${input.bytes},'indexing',COALESCE(MAX(attempt),0)+1
        FROM pdf_revision_failed_attempts WHERE doc=${doc} AND version=${v}`;
      yield* sql`UPDATE pdf_revision_documents SET pending=${v} WHERE doc=${doc}`;
      return status((yield* statusRow(sql, doc))[0]!);
    }),
  );
});

export const retryPdfRevision = Effect.fn("retryPdfRevision")(function* (
  ctx: Context,
  s: PdfScope,
) {
  const sql = yield* SqlClient.SqlClient,
    doc = pdfDocumentKey(s);
  yield* assertRevisionOwner(sql, s);
  yield* sql`UPDATE pdf_revision_versions SET state='indexing', error=NULL WHERE doc=${doc} AND state='failed'
    AND version=(SELECT pending FROM pdf_revision_documents WHERE doc=${doc})`;
  return yield* getPdfRevisionStatus(ctx, s);
});

const running = new Map<string, Promise<void>>();
const encodePart = Schema.encodeEffect(Schema.fromJsonString(OrchestrationCommand));
export const runPdfRevision = Effect.fn("runPdfRevision")(function* (
  ctx: Context,
  s: PdfScope,
  hooks?: {
    afterBatch?: (lastPage: number) => Promise<void>;
  },
) {
  const sql = yield* SqlClient.SqlClient,
    doc = pdfDocumentKey(s);
  const lock = Path.join(ctx.stateDir, doc);
  // A retry can arrive while the failed worker releases its resources. Recheck
  // the durable state after it exits so the retry is never lost.
  let previous;
  while ((previous = running.get(lock))) {
    const finished = previous;
    yield* Effect.promise(() => finished);
  }
  const completion = Promise.withResolvers<void>();
  running.set(lock, completion.promise);
  yield* Effect.gen(function* () {
    yield* assertRevisionOwner(sql, s);
    const [v] = yield* sql<{
      version: number;
      hash: string;
      source_attempt: number | null;
      bytes: Uint8Array;
      name: string;
      ocr: number;
    }>`SELECT v.version,v.hash,v.source_attempt,v.bytes,d.name,d.ocr
    FROM pdf_revision_versions v JOIN pdf_revision_documents d ON d.doc=v.doc AND d.pending=v.version
    WHERE d.doc=${doc} AND v.state='indexing'`;
    if (!v) return;
    const paths = revisionPaths(ctx.stateDir, doc, v.version, v.source_attempt);
    const attachment: ChatFileAttachment = {
      type: "file",
      id: s.attachmentId,
      name: v.name,
      mimeType: "application/pdf",
      sizeBytes: v.bytes.length,
    };
    const run = Effect.runPromiseWith(
      yield* Effect.context<FileSystem.FileSystem | EffectPath.Path>(),
    );
    const work = Effect.gen(function* () {
      const raw = yield* io(async () => {
        if (revisionDigest(v.bytes) !== v.hash) throw Error("PDF hash mismatch");
        await ensureSource(paths.attachmentsDir, attachment, v.bytes, v.hash);
        return v.bytes;
      });
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const result = yield* io((signal) =>
        indexPdfJob({
          ...s,
          ...paths,
          attachment,
          bytes: raw,
          createdAt,
          ocrEnabled: !!v.ocr,
          signal,
          dispatch: async (c) => {
            if (c.type !== "project.knowledge.item.upsert") return;
            const first = Number(c.itemId.slice(c.itemId.lastIndexOf("-") + 1));
            if (!Number.isSafeInteger(first) || first < 1) throw Error("Invalid batch");
            const encoded = await run(encodePart(c));
            await run(sql`INSERT INTO pdf_revision_parts(doc,version,first_page,payload)
              SELECT doc,version,${first},${encoded} FROM pdf_revision_versions
              WHERE doc=${doc} AND version=${v.version} AND hash=${v.hash} AND source_attempt IS ${v.source_attempt} AND state='indexing'
          ON CONFLICT(doc,version,first_page) DO UPDATE SET payload=excluded.payload`);
          },
          writeAtomic: async (filePath, contents) => {
            await run(writeFileStringAtomically({ filePath, contents }));
            if (!/^[0-9a-f]{64}\.json$/.test(Path.basename(filePath))) return;
            const j = JSON.parse(contents) as {
              lastPage: number;
              totalPages: number;
              complete: boolean;
            };
            if (j.lastPage > 0) {
              await run(sql`UPDATE pdf_revision_versions SET last_page=${j.lastPage},total_pages=${j.totalPages}
            WHERE doc=${doc} AND version=${v.version} AND hash=${v.hash} AND source_attempt IS ${v.source_attempt} AND state='indexing'`);
              if (!j.complete) await hooks?.afterBatch?.(j.lastPage);
            }
          },
        }),
      );
      const job = result.job;
      if (!job.complete || job.contentHash !== v.hash || job.lastPage !== job.totalPages)
        return yield* revisionError(
          "PDF has unreadable or unverified pages. The prior version is still published.",
        );
      // Verify every batch against the page sidecar before any visible projection is touched.
      const parts = yield* sql<{
        first_page: number;
        payload: string;
      }>`SELECT first_page,payload FROM pdf_revision_parts
      WHERE doc=${doc} AND version=${v.version}`;
      const staged = new Map(parts.map((p) => [p.first_page, p.payload]));
      yield* io(async () => {
        const digests = new Map(job.pageDigests?.map((d) => [d.file, d.sha256]));
        let next = 1;
        for (const batch of job.batchFiles) {
          const first = next,
            file = batch.replace(/\.txt$/, ".pages.json");
          const data = await Fs.readFile(
            Path.join(paths.stateDir, "document-rag", "pdf-jobs", file),
            "utf8",
          );
          if (revisionDigest(data) !== digests.get(file)) throw Error("Page digest changed");
          const bundle = decodePdfPages(data);
          if (bundle.contentHash !== v.hash || !bundle.pages.length)
            throw Error("Invalid page bundle");
          for (const page of bundle.pages) {
            if (page.page !== next++ || page.totalPages !== job.totalPages)
              throw Error("Missing page");
            if (
              page.status === "failed" ||
              (page.status === "empty" && page.contentType !== "blank")
            )
              throw Error("Unreadable page");
          }
          const knowledge = documentKnowledgeContent(
            bundle.pages
              .filter((p) => p.text.trim())
              .map((p) => ({
                location: `페이지 ${p.page}${p.status === "ocr" ? " · OCR" : ""}`,
                text: p.text,
              })),
          );
          const part = staged.get(first);
          if (knowledge.content) {
            if (!part) throw Error("Missing staged batch");
            const c = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationCommand))(part);
            if (c.type !== "project.knowledge.item.upsert" || c.content !== knowledge.content)
              throw Error("Index differs from pages");
          } else if (part) throw Error("Unexpected nonempty batch");
          staged.delete(first);
        }
        if (next !== job.totalPages + 1 || staged.size) throw Error("Incomplete revision");
      });
      yield* sql`UPDATE pdf_revision_versions SET last_page=${job.lastPage},total_pages=${job.totalPages},job_key=${job.batchFiles[0]!.slice(0, 64)}
      WHERE doc=${doc} AND version=${v.version} AND hash=${v.hash} AND source_attempt IS ${v.source_attempt} AND state='indexing'`;
      yield* ctx.engine.dispatch({
        type: "project.pdf-revision.publish",
        ...s,
        version: v.version,
        contentHash: v.hash,
        commandId: CommandId.make(publicationCommandId(doc, v.version, v.hash, v.source_attempt)),
        createdAt,
      });
    });
    yield* work.pipe(
      Effect.tapError(
        (
          e,
        ) => sql`UPDATE pdf_revision_versions SET state='failed',error=${e._tag === "PdfRevisionError" ? e.message : "Could not publish the indexed PDF. Retry to resume."}
      WHERE doc=${doc} AND version=${v.version} AND hash=${v.hash} AND source_attempt IS ${v.source_attempt} AND state='indexing'`,
      ),
    );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        running.delete(lock);
        completion.resolve();
      }),
    ),
  );
});

export const resumePdfRevisions = Effect.fn("resumePdfRevisions")(function* (ctx: Context) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql<PdfScope>`SELECT d.project_id projectId,d.thread_id threadId,d.message_id messageId,d.attachment_id attachmentId
    FROM pdf_revision_documents d JOIN pdf_revision_versions v ON d.doc=v.doc AND d.pending=v.version WHERE v.state='indexing'`;
  for (const row of rows) yield* runPdfRevision(ctx, row).pipe(Effect.catch(() => Effect.void));
});

export const publishedPdfSource = Effect.fn("publishedPdfSource")(function* (
  ctx: Context,
  s: PdfScope,
  version?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const st = yield* getPdfRevisionStatus(ctx, s);
  const wanted = version ?? st.published.version;
  if (!Number.isSafeInteger(wanted) || wanted < 1 || wanted > st.published.version)
    return yield* revisionError("PDF version is not published.");
  const doc = pdfDocumentKey(s);
  const [row] = yield* sql<{
    hash: string;
    name: string;
    source_attempt: number | null;
  }>`SELECT v.hash,d.name,v.source_attempt FROM pdf_revision_documents d JOIN pdf_revision_versions v ON d.doc=v.doc
    WHERE d.doc=${doc} AND v.version=${wanted} AND v.state='published'`;
  const hash = row?.hash ?? st.published.contentHash;
  const dirs = row ? revisionPaths(ctx.stateDir, doc, wanted, row.source_attempt) : ctx;
  const attachment: ChatFileAttachment = {
    id: s.attachmentId,
    type: "file",
    name: row?.name ?? "source.pdf",
    mimeType: "application/pdf",
    sizeBytes: 0,
  };
  const file = resolveAttachmentPath({ attachmentsDir: dirs.attachmentsDir, attachment });
  if (!file) return yield* revisionError("Invalid PDF source.");
  const present = yield* io(async () => {
    try {
      if (revisionDigest(await Fs.readFile(file)) !== hash) throw Error("Source changed");
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  });
  if (!present) {
    const [stored] = yield* sql<{ bytes: Uint8Array }>`SELECT bytes FROM pdf_revision_versions
      WHERE doc=${doc} AND version=${wanted} AND state='published' AND hash=${hash}`;
    if (!stored || revisionDigest(stored.bytes) !== hash)
      return yield* revisionError("Published PDF source is unavailable.");
    yield* io(() => ensureSource(dirs.attachmentsDir, attachment, stored.bytes, hash));
  }
  return { path: file, version: wanted, contentHash: hash };
});
