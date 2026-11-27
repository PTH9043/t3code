import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE pdf_revision_requests ADD COLUMN failed_attempt INTEGER`;
  yield* sql`ALTER TABLE pdf_revision_versions ADD COLUMN source_attempt INTEGER`;
  yield* sql`CREATE TABLE pdf_revision_failed_attempts (
    doc TEXT NOT NULL REFERENCES pdf_revision_documents(doc) ON DELETE CASCADE,
    version INTEGER NOT NULL, attempt INTEGER NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL, error TEXT,
    last_page INTEGER NOT NULL, total_pages INTEGER NOT NULL, PRIMARY KEY(doc,version,attempt)
  )`;
});
