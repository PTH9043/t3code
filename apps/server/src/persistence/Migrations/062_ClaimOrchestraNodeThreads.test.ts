import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const AT = "2026-09-08T00:00:00.000Z";

const project = `
  INSERT INTO projection_projects (
    project_id, title, workspace_root, default_model_selection_json,
    scripts_json, workspace_control_json, created_at, updated_at, deleted_at
  ) VALUES (
    'project-1', 'Orchestra', 'D:/project-1', NULL, '[]',
    '{"isolationMode":"strict","longTermMemoryRoot":null}', '${AT}', '${AT}', NULL
  )
`;

const thread = (id: string) => `
  INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
    branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at
  ) VALUES (
    '${id}', 'project-1', '${id}', '{"instanceId":"codex","model":"gpt-5-codex"}',
    'full-access', 'default', NULL, NULL, NULL, '${AT}', '${AT}', NULL
  )
`;

const run = (input: {
  readonly orchestraJson: string | null;
  readonly meetingThreadId: string | null;
  readonly nodeThreadIds: ReadonlyArray<string | null>;
}) => `
  INSERT INTO projection_workspace_collaboration_runs (
    run_id, project_id, source, schedule_id, incident_id, task, status,
    steps_json, graph_json, final_output, error, created_at, updated_at,
    meeting_json, orchestra_json
  ) VALUES (
    'run-1', 'project-1', 'user', NULL, NULL, '작업', 'completed',
    '[]',
    '${JSON.stringify({
      revision: 1,
      nodes: input.nodeThreadIds.map((threadId, index) => ({ id: `n${index}`, threadId })),
    })}',
    NULL, NULL, '${AT}', '${AT}',
    ${
      input.meetingThreadId === null
        ? "NULL"
        : `'${JSON.stringify({ threadId: input.meetingThreadId })}'`
    },
    ${input.orchestraJson === null ? "NULL" : `'${input.orchestraJson}'`}
  )
`;

const ownership = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly threadId: string; readonly owner: string | null }>`
    SELECT thread_id AS "threadId", orchestra_run_thread_id AS "owner"
    FROM projection_threads ORDER BY thread_id
  `;
});

it.effect("claims the node conversations orchestra runs already spawned", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* sql.unsafe(project);
    for (const id of ["owner", "node-a", "node-b"]) yield* sql.unsafe(thread(id));
    yield* sql.unsafe(
      run({
        orchestraJson: '{"maxParallel":3,"isolateWorktrees":false}',
        meetingThreadId: "owner",
        // A node that never started has no conversation, and the run's own
        // conversation is the person's — neither may be claimed.
        nodeThreadIds: ["node-a", "node-b", null, "owner"],
      }),
    );

    yield* runMigrations({ toMigrationInclusive: 62 });

    assert.deepStrictEqual(yield* ownership, [
      { threadId: "node-a", owner: "owner" },
      { threadId: "node-b", owner: "owner" },
      { threadId: "owner", owner: null },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("leaves the conversations of runs with no orchestra alone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* sql.unsafe(project);
    for (const id of ["owner", "step"]) yield* sql.unsafe(thread(id));
    yield* sql.unsafe(
      run({ orchestraJson: null, meetingThreadId: "owner", nodeThreadIds: ["step"] }),
    );

    yield* runMigrations({ toMigrationInclusive: 62 });

    assert.deepStrictEqual(yield* ownership, [
      { threadId: "owner", owner: null },
      { threadId: "step", owner: null },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("leaves an unattended run's conversations listed, having none to hide behind", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* sql.unsafe(project);
    yield* sql.unsafe(thread("node-a"));
    yield* sql.unsafe(
      run({
        orchestraJson: '{"maxParallel":3,"isolateWorktrees":false}',
        meetingThreadId: null,
        nodeThreadIds: ["node-a"],
      }),
    );

    yield* runMigrations({ toMigrationInclusive: 62 });

    assert.deepStrictEqual(yield* ownership, [{ threadId: "node-a", owner: null }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
