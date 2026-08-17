import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Compaction sizes as numbers instead of tag strings.
 *
 * Automatic capture already recorded them as `original-chars-N` / `stored-chars-N`
 * tags, which render fine but cannot be summed, sorted or compared. Unlike the
 * usage counters, these are backfilled: the values genuinely exist on the rows,
 * only in a shape no query can aggregate.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_workspace_knowledge_items')`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("original_chars")) {
    yield* sql`
      ALTER TABLE projection_workspace_knowledge_items
      ADD COLUMN original_chars INTEGER
    `;
  }
  if (!existing.has("stored_chars")) {
    yield* sql`
      ALTER TABLE projection_workspace_knowledge_items
      ADD COLUMN stored_chars INTEGER
    `;
  }

  const rows = yield* sql<{
    readonly project_id: string;
    readonly item_id: string;
    readonly tags_json: string;
  }>`
    SELECT project_id, item_id, tags_json
    FROM projection_workspace_knowledge_items
    WHERE original_chars IS NULL
      AND tags_json LIKE '%original-chars-%'
  `;

  const readTag = (tags: ReadonlyArray<string>, prefix: string): number | null => {
    const tag = tags.find((candidate) => candidate.startsWith(prefix));
    if (tag === undefined) return null;
    const parsed = Number.parseInt(tag.slice(prefix.length), 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };

  const decodeTags = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

  for (const row of rows) {
    // A row whose tags cannot be read is left for a later capture to fill in
    // rather than failing the whole migration.
    const tags = yield* decodeTags(row.tags_json).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    const originalChars = readTag(tags, "original-chars-");
    const storedChars = readTag(tags, "stored-chars-");
    if (originalChars === null && storedChars === null) continue;
    yield* sql`
      UPDATE projection_workspace_knowledge_items
      SET original_chars = ${originalChars}, stored_chars = ${storedChars}
      WHERE project_id = ${row.project_id} AND item_id = ${row.item_id}
    `;
  }
});
