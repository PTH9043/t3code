import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertItem = (input: { readonly itemId: string; readonly tags: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    INSERT INTO projection_workspace_knowledge_items (
      project_id, item_id, kind, title, content, status, origin,
      relative_folder, tags_json, created_at, updated_at
    ) VALUES (
      'compaction-project', ${input.itemId}, 'rag-source', ${input.itemId}, 'body',
      'active', 'agent', NULL, ${input.tags},
      '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
    )
  `;
  });

layer("053_ProjectionWorkspaceKnowledgeCompaction", (it) => {
  it.effect("backfills compaction sizes that were only recorded as tags", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, workspace_control_json, created_at, updated_at, deleted_at
        ) VALUES (
          'compaction-project', 'Compaction', 'D:/compaction', NULL, '[]',
          '{"isolationMode":"strict","longTermMemoryRoot":null}',
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z', NULL
        )
      `;
      yield* insertItem({
        itemId: "captured",
        tags: '["auto-agent-output","original-chars-4820","stored-chars-1140"]',
      });
      // Written by hand, never compacted: it has no sizes to recover.
      yield* insertItem({ itemId: "hand-written", tags: '["directive"]' });
      // A malformed tag must not fail the migration for every other row.
      yield* insertItem({ itemId: "broken", tags: "not-json-at-all" });

      yield* runMigrations({ toMigrationInclusive: 53 });

      const rows = yield* sql<{
        readonly itemId: string;
        readonly originalChars: number | null;
        readonly storedChars: number | null;
      }>`
        SELECT item_id AS "itemId", original_chars AS "originalChars", stored_chars AS "storedChars"
        FROM projection_workspace_knowledge_items
        WHERE project_id = 'compaction-project'
        ORDER BY item_id ASC
      `;

      assert.deepStrictEqual(
        rows.map((row) => [row.itemId, row.originalChars, row.storedChars]),
        [
          ["broken", null, null],
          ["captured", 4820, 1140],
          ["hand-written", null, null],
        ],
      );
    }),
  );
});
