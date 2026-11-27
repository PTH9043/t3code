import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE pdf_revision_documents (
    doc TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL, name TEXT NOT NULL, batch_prefix TEXT NOT NULL, ocr INTEGER NOT NULL,
    published INTEGER NOT NULL, pending INTEGER, UNIQUE(project_id,thread_id,message_id,attachment_id)
  )`;
  yield* sql`CREATE TABLE pdf_revision_versions (
    doc TEXT NOT NULL REFERENCES pdf_revision_documents(doc) ON DELETE CASCADE, version INTEGER NOT NULL,
    hash TEXT NOT NULL, bytes BLOB NOT NULL, state TEXT NOT NULL, last_page INTEGER NOT NULL DEFAULT 0,
    total_pages INTEGER NOT NULL DEFAULT 0, error TEXT, job_key TEXT, PRIMARY KEY(doc,version)
  )`;
  yield* sql`CREATE TABLE pdf_revision_item_aliases (
    project_id TEXT NOT NULL, item_id TEXT NOT NULL, doc TEXT NOT NULL REFERENCES pdf_revision_documents(doc) ON DELETE CASCADE,
    PRIMARY KEY(project_id,item_id)
  )`;
  yield* sql`CREATE TABLE pdf_revision_requests (
    doc TEXT NOT NULL REFERENCES pdf_revision_documents(doc) ON DELETE CASCADE, request_id TEXT NOT NULL,
    base_version INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(doc,request_id)
  )`;
  yield* sql`CREATE TABLE pdf_revision_parts (
    doc TEXT NOT NULL, version INTEGER NOT NULL, first_page INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(doc,version,first_page), FOREIGN KEY(doc,version) REFERENCES pdf_revision_versions(doc,version) ON DELETE CASCADE
  )`;
  yield* sql`CREATE TABLE pdf_revision_epoch (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL)`;
  yield* sql`INSERT INTO pdf_revision_epoch VALUES(1,0)`;
});
