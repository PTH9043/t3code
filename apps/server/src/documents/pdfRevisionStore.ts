import {
  OrchestrationCommand,
  type ProjectId,
  type ThreadId,
  type MessageId,
  type WorkspaceRagMatch,
  WorkspaceKnowledgeItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { pdfDocumentKey } from "./pdfRevisionPaths.ts";

export interface PdfScope {
  projectId: ProjectId;
  threadId: ThreadId;
  messageId: MessageId;
  attachmentId: string;
}
export class PdfRevisionError extends Schema.TaggedErrorClass<PdfRevisionError>()(
  "PdfRevisionError",
  { message: Schema.String },
) {}
export const revisionError = (message: string) => new PdfRevisionError({ message });
const encodeSearchKeys = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ doc: Schema.String, hash: Schema.String }))),
);

/** Attach publication state only to hits from the exact indexed edition and original batch. */
export const labelPdfRevisionHits = Effect.fn("labelPdfRevisionHits")(function* (
  sql: SqlClient.SqlClient,
  matches: readonly WorkspaceRagMatch[],
) {
  const keys = matches.map((match) => {
    const a = match.research?.attachment;
    return a
      ? { doc: pdfDocumentKey({ projectId: match.projectId, ...a }), hash: a.contentHash }
      : null;
  });
  const documents = [
    ...new Map(keys.flatMap((k) => (k ? [[k.doc + ":" + k.hash, k] as const] : []))).values(),
  ];
  const rows = yield* sql<{
    doc: string;
    hash: string;
    batch_prefix: string;
    published: number;
    pending: number | null;
    state: "indexing" | "failed" | null;
  }>`SELECT d.doc,p.hash,d.batch_prefix,d.published,d.pending,v.state FROM json_each(${encodeSearchKeys(documents)}) h
     JOIN pdf_revision_documents d ON d.doc=h.value->>'doc'
     JOIN pdf_revision_versions p ON p.doc=d.doc AND p.version=d.published AND p.hash=h.value->>'hash'
     LEFT JOIN pdf_revision_versions v ON v.doc=d.doc AND v.version=d.pending`;
  const byDoc = new Map(rows.map((r) => [r.doc, r]));
  return matches.map((match, i) => {
    const key = keys[i];
    const r = key ? byDoc.get(key.doc) : undefined;
    if (
      !r ||
      r.hash !== key?.hash ||
      !match.itemId.startsWith(r.batch_prefix) ||
      !/^[1-9][0-9]*$/.test(match.itemId.slice(r.batch_prefix.length))
    )
      return match;
    return {
      ...match,
      pdfRevision: {
        publishedVersion: r.published,
        pending:
          r.pending !== null && r.state !== null ? { version: r.pending, status: r.state } : null,
      },
    };
  });
});

export const assertRevisionOwner = Effect.fn("assertPdfRevisionOwner")(function* (
  sql: SqlClient.SqlClient,
  s: PdfScope,
) {
  const [owner] =
    yield* sql`SELECT 1 FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id
    JOIN projection_projects p ON p.project_id=t.project_id
    WHERE t.project_id=${s.projectId} AND t.thread_id=${s.threadId} AND m.message_id=${s.messageId}
      AND t.deleted_at IS NULL AND p.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM json_each(m.attachments_json) a
        WHERE a.value->>'type'='file' AND a.value->>'id'=${s.attachmentId})`;
  if (!owner) return yield* revisionError("PDF source attachment is no longer available.");
});

type Publish = Extract<OrchestrationCommand, { type: "project.pdf-revision.publish" }>;
export const publicationCommandId = (
  doc: string,
  version: number,
  hash: string,
  attempt: number | null,
) => `server:pdf-publish:${doc}:${version}:${hash}${attempt == null ? "" : ":" + attempt}`;
const decodePart = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationCommand));

/** Called only inside the engine's receipt/event/projection transaction. */
export const commitPdfRevision = Effect.fn("commitPdfRevision")(function* (
  sql: SqlClient.SqlClient,
  c: Publish,
) {
  yield* assertRevisionOwner(sql, c);
  const doc = pdfDocumentKey(c);
  const [head] = yield* sql<{
    batch_prefix: string;
    total_pages: number;
    source_attempt: number | null;
  }>`SELECT d.batch_prefix,v.total_pages,v.source_attempt
    FROM pdf_revision_documents d JOIN pdf_revision_versions v ON d.doc=v.doc AND d.pending=v.version
    WHERE d.doc=${doc} AND d.published=${c.version - 1} AND d.pending=${c.version} AND v.hash=${c.contentHash}
      AND v.state='indexing' AND v.last_page=v.total_pages AND v.total_pages>0`;
  if (
    !head ||
    c.commandId !== publicationCommandId(doc, c.version, c.contentHash, head.source_attempt)
  )
    return yield* revisionError("PDF revision is not ready to publish.");
  // Check at the publication boundary, after any user archive or merge that
  // committed during indexing. Only a batch retired by this publisher can return.
  const [hidden] = yield* sql`SELECT 1 FROM projection_workspace_knowledge_items k
    WHERE k.project_id=${c.projectId} AND k.source_item_id IS NULL AND k.status<>'active'
      AND substr(k.item_id,1,length(${head.batch_prefix}))=${head.batch_prefix}
      AND NOT EXISTS (SELECT 1 FROM pdf_revision_item_aliases a
        WHERE a.doc=${doc} AND a.project_id=k.project_id AND a.item_id=k.item_id
          AND k.status='archived' AND (
            SELECT e.command_id FROM orchestration_events e
            WHERE e.aggregate_kind='project' AND e.stream_id=k.project_id
              AND e.event_type IN ('project.knowledge-item-upserted','project.knowledge-item-archived')
              AND e.payload_json->>'itemId'=k.item_id ORDER BY e.sequence DESC LIMIT 1
          ) LIKE ${"server:pdf-publish:" + doc + ":%"})
    LIMIT 1`;
  if (hidden) return yield* revisionError("An indexed PDF item is no longer active.");
  const parts = yield* sql<{
    first_page: number;
    payload: string;
  }>`SELECT first_page,payload FROM pdf_revision_parts
    WHERE doc=${doc} AND version=${c.version} ORDER BY first_page`;
  const commands: OrchestrationCommand[] = [];
  const retained = new Set<string>();
  for (const part of parts) {
    const staged = yield* decodePart(part.payload);
    if (
      staged.type !== "project.knowledge.item.upsert" ||
      staged.projectId !== c.projectId ||
      staged.research?.attachment?.threadId !== c.threadId ||
      staged.research.attachment.messageId !== c.messageId ||
      staged.research.attachment.attachmentId !== c.attachmentId ||
      staged.research.attachment.contentHash !== c.contentHash ||
      part.first_page < 1 ||
      part.first_page > head.total_pages
    )
      return yield* revisionError("Staged PDF content does not match the revision.");
    const itemId = WorkspaceKnowledgeItemId.make(head.batch_prefix + part.first_page);
    retained.add(itemId);
    yield* sql`DELETE FROM pdf_revision_item_aliases WHERE doc=${doc} AND item_id=${itemId}`;
    commands.push({ ...staged, itemId, commandId: c.commandId, createdAt: c.createdAt });
  }
  if (!commands.length) return yield* revisionError("PDF revision contains no searchable pages.");
  const previous = yield* sql<{
    item_id: string;
  }>`SELECT item_id FROM projection_workspace_knowledge_items
    WHERE project_id=${c.projectId} AND status<>'archived' AND source_item_id IS NULL
      AND research_json->>'$.attachment.threadId'=${c.threadId} AND research_json->>'$.attachment.messageId'=${c.messageId}
      AND research_json->>'$.attachment.attachmentId'=${c.attachmentId}
      AND EXISTS(SELECT 1 FROM json_each(tags_json) WHERE value='pdf-page-batch')`;
  for (const row of previous)
    if (!retained.has(row.item_id)) {
      yield* sql`INSERT OR REPLACE INTO pdf_revision_item_aliases(project_id,item_id,doc) VALUES(${c.projectId},${row.item_id},${doc})`;
      commands.push({
        type: "project.knowledge.item.archive",
        commandId: c.commandId,
        projectId: c.projectId,
        itemId: WorkspaceKnowledgeItemId.make(row.item_id),
        createdAt: c.createdAt,
      });
    }
  yield* sql`UPDATE pdf_revision_documents SET published=pending,pending=NULL WHERE doc=${doc}`;
  yield* sql`UPDATE pdf_revision_versions SET state='published',error=NULL WHERE doc=${doc} AND version=${c.version}`;
  yield* sql`DELETE FROM pdf_revision_parts WHERE doc=${doc} AND version=${c.version}`;
  yield* sql`UPDATE pdf_revision_epoch SET generation=generation+1 WHERE id=1`;
  return commands;
});
