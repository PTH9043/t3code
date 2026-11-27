import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("indexes forgotten message sources and tolerates malformed older metadata", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 84 });
    yield* sql`INSERT INTO workspace_memory_v2
      (id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,created_at,updated_at)
      VALUES ('valid','p','project','t','', '{"kind":"message","id":"m1"}', 'x','user','user-statement','forgotten','t','t'),
             ('bad','p','project','t','', 'invalid-json', 'x','user','user-statement','forgotten','t','t'),
             ('active','p','project','t','keep', '{"kind":"message","id":"m2"}', 'x','user','user-statement','observed','t','t')`;
    expect(yield* runMigrations()).toContainEqual([85, "WorkspaceForgottenMessageLookup"]);
    const rows = yield* sql`SELECT id FROM workspace_memory_v2 forgotten
      WHERE forgotten.project_id='p' AND forgotten.status='forgotten'
        AND CASE WHEN json_valid(forgotten.source_json)
          AND json_extract(forgotten.source_json,'$.kind')='message'
          THEN json_extract(forgotten.source_json,'$.id') END = 'm1'`;
    expect(rows).toEqual([{ id: "valid" }]);
    const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT id FROM workspace_memory_v2 forgotten
      WHERE forgotten.project_id='p' AND forgotten.status='forgotten'
        AND CASE WHEN json_valid(forgotten.source_json)
          AND json_extract(forgotten.source_json,'$.kind')='message'
          THEN json_extract(forgotten.source_json,'$.id') END = 'm1'`;
    expect(plan.some((row) => row.detail.includes("idx_workspace_forgotten_message"))).toBe(true);
    expect(yield* runMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
