import {
  DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
  DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
  DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
  WorkspaceControlSettings,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_ProjectionProjectsWorkspaceControl", (it) => {
  it.effect("backfills strict isolated Workspace settings for existing projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'existing-project',
          'Existing project',
          'D:/existing-project',
          NULL,
          '[]',
          '2026-08-08T00:00:00.000Z',
          '2026-08-08T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const rows = yield* sql<{ readonly workspaceControl: string }>`
        SELECT workspace_control_json AS "workspaceControl"
        FROM projection_projects
        WHERE project_id = 'existing-project'
      `;
      const workspaceControl = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(WorkspaceControlSettings),
      )(rows[0]?.workspaceControl).pipe(Effect.orDie);
      assert.deepStrictEqual(workspaceControl, {
        isolationMode: "strict",
        longTermMemoryRoot: null,
        conversationRag: DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
        agentKnowledge: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
        monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
        orchestra: DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
      });
    }),
  );
});
