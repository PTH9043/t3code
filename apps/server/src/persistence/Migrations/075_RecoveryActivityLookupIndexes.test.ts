import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("075_RecoveryActivityLookupIndexes", (it) => {
  it.effect("looks up recovery kinds and scheduled tools without scanning every tool payload", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      yield* runMigrations({ toMigrationInclusive: 75 });
      yield* runMigrations({ toMigrationInclusive: 75 });
      const plan = yield* sql<{ detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id, payload_json
        FROM projection_thread_activities
        WHERE (thread_id = ${"recovery-thread"} AND kind IN ('task.started', 'task.completed'))
          OR (thread_id = ${"recovery-thread"} AND kind = 'tool.completed'
            AND json_extract(payload_json, '$.data.toolName') IN ('ScheduleWakeup'))
      `;
      assert.ok(plan.some((row) => row.detail.includes("idx_projection_recovery_activity_kind")));
      assert.ok(plan.some((row) => row.detail.includes("idx_projection_recovery_completed_tool")));
      assert.ok(!plan.some((row) => row.detail.startsWith("SCAN ")));
    }),
  );
});
