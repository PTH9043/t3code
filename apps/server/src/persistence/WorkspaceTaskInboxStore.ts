import {
  WorkspaceInboxTask,
  WorkspaceTaskRecipe,
  WorkspaceTaskInboxError,
  type ProjectId,
  type WorkspaceTaskRecipeDefinition,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const TaskJson = Schema.fromJsonString(WorkspaceInboxTask);
const RecipeJson = Schema.fromJsonString(WorkspaceTaskRecipe);
const decodeTask = Schema.decodeUnknownEffect(TaskJson);
const encodeTask = Schema.encodeEffect(TaskJson);
const decodeRecipe = Schema.decodeUnknownEffect(RecipeJson);
const encodeRecipe = Schema.encodeEffect(RecipeJson);
const isInboxError = Schema.is(WorkspaceTaskInboxError);
const failure = (cause: unknown) =>
  isInboxError(cause)
    ? cause
    : new WorkspaceTaskInboxError({
        message: "자동 업무 기록을 저장하거나 조회하지 못했습니다.",
        cause,
      });

export class WorkspaceTaskInboxStore extends Context.Service<
  WorkspaceTaskInboxStore,
  {
    readonly recipes: (
      projectId: ProjectId,
    ) => Effect.Effect<readonly WorkspaceTaskRecipe[], WorkspaceTaskInboxError>;
    readonly recipe: (
      projectId: ProjectId,
      id: string,
      revision?: number,
    ) => Effect.Effect<WorkspaceTaskRecipe | null, WorkspaceTaskInboxError>;
    readonly saveRecipe: (
      projectId: ProjectId,
      recipe: WorkspaceTaskRecipeDefinition,
      now: string,
    ) => Effect.Effect<WorkspaceTaskRecipe, WorkspaceTaskInboxError>;
    readonly get: (
      projectId: ProjectId,
      id: string,
    ) => Effect.Effect<WorkspaceInboxTask | null, WorkspaceTaskInboxError>;
    readonly insert: (
      task: WorkspaceInboxTask,
    ) => Effect.Effect<WorkspaceInboxTask, WorkspaceTaskInboxError>;
    readonly update: (task: WorkspaceInboxTask) => Effect.Effect<void, WorkspaceTaskInboxError>;
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<readonly WorkspaceInboxTask[], WorkspaceTaskInboxError>;
    readonly pending: Effect.Effect<readonly WorkspaceInboxTask[], WorkspaceTaskInboxError>;
    readonly previousFingerprint: (
      projectId: ProjectId,
      monitorKey: string,
    ) => Effect.Effect<string | null, WorkspaceTaskInboxError>;
    readonly counts: (
      projectId: ProjectId,
    ) => Effect.Effect<
      { totalTasks: number; completed: number; aiSkipped: number; waiting: number },
      WorkspaceTaskInboxError
    >;
    readonly projectBusy: (projectId: ProjectId) => Effect.Effect<boolean, WorkspaceTaskInboxError>;
    readonly hasPendingSource: (
      projectId: ProjectId,
      source: string,
      exceptExternalId: string,
    ) => Effect.Effect<boolean, WorkspaceTaskInboxError>;
  }
>()("t3/persistence/WorkspaceTaskInboxStore") {}

export const layer = Layer.effect(
  WorkspaceTaskInboxStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
    const recipes = Effect.fn("TaskInboxStore.recipes")(function* (projectId: ProjectId) {
      const rows = yield* sql<{
        recipe_json: string;
      }>`SELECT r.recipe_json FROM workspace_task_recipes r
      WHERE r.project_id=${projectId} AND r.revision=(SELECT MAX(v.revision) FROM workspace_task_recipes v
      WHERE v.project_id=r.project_id AND v.recipe_id=r.recipe_id) ORDER BY r.recipe_id`;
      return yield* Effect.forEach(rows, (row) => decodeRecipe(row.recipe_json));
    }, Effect.mapError(failure));
    const recipe = Effect.fn("TaskInboxStore.recipe")(function* (
      projectId: ProjectId,
      id: string,
      revision?: number,
    ) {
      const rows =
        revision === undefined
          ? yield* sql<{
              recipe_json: string;
            }>`SELECT recipe_json FROM workspace_task_recipes WHERE project_id=${projectId} AND recipe_id=${id} ORDER BY revision DESC LIMIT 1`
          : yield* sql<{
              recipe_json: string;
            }>`SELECT recipe_json FROM workspace_task_recipes WHERE project_id=${projectId} AND recipe_id=${id} AND revision=${revision}`;
      return rows[0] ? yield* decodeRecipe(rows[0].recipe_json) : null;
    }, Effect.mapError(failure));
    const saveRecipe = Effect.fn("TaskInboxStore.saveRecipe")(
      (projectId: ProjectId, definition: WorkspaceTaskRecipeDefinition, now: string) =>
        lock
          .withPermit(
            sql.withTransaction(
              Effect.gen(function* () {
                const previous = yield* recipe(projectId, definition.id);
                const next = {
                  ...definition,
                  revision: (previous?.revision ?? 0) + 1,
                  updatedAt: now,
                };
                const encoded = yield* encodeRecipe(next);
                yield* sql`INSERT INTO workspace_task_recipes(project_id,recipe_id,revision,recipe_json) VALUES(${projectId},${next.id},${next.revision},${encoded})`;
                return next;
              }),
            ),
          )
          .pipe(Effect.mapError(failure)),
    );
    const get = Effect.fn("TaskInboxStore.get")(function* (projectId: ProjectId, id: string) {
      const rows = yield* sql<{
        task_json: string;
      }>`SELECT task_json FROM workspace_task_inbox WHERE project_id=${projectId} AND task_id=${id}`;
      return rows[0] ? yield* decodeTask(rows[0].task_json) : null;
    }, Effect.mapError(failure));
    const record = Effect.fn("TaskInboxStore.record")(function* (task: WorkspaceInboxTask) {
      const encoded = yield* encodeTask(task);
      yield* sql`INSERT INTO workspace_task_inbox_events(task_id,status,attempt,created_at,task_json)
      VALUES(${task.id},${task.status},${task.attempt},${task.updatedAt},${encoded})`;
    });
    const insert = Effect.fn("TaskInboxStore.insert")((task: WorkspaceInboxTask) =>
      lock
        .withPermit(
          sql.withTransaction(
            Effect.gen(function* () {
              const current = yield* get(task.projectId, task.id);
              if (current) {
                if (current.inputHash !== task.inputHash)
                  return yield* new WorkspaceTaskInboxError({
                    message:
                      "같은 외부 이벤트 ID에 다른 입력이 전달됐습니다. 새 이벤트 ID를 사용하세요.",
                  });
                return current;
              }
              const encoded = yield* encodeTask(task);
              yield* sql`INSERT INTO workspace_task_inbox(task_id,project_id,source,external_id,status,monitor_key,created_at,ai_skipped,task_json)
      VALUES(${task.id},${task.projectId},${task.source},${task.externalId},${task.status},${task.monitorKey},${task.createdAt},${task.aiSkipped ? 1 : 0},${encoded})`;
              yield* record(task);
              return task;
            }),
          ),
        )
        .pipe(Effect.mapError(failure)),
    );
    const update = Effect.fn("TaskInboxStore.update")((task: WorkspaceInboxTask) =>
      lock
        .withPermit(
          sql.withTransaction(
            Effect.gen(function* () {
              const encoded = yield* encodeTask(task);
              yield* sql`UPDATE workspace_task_inbox SET status=${task.status},ai_skipped=${task.aiSkipped ? 1 : 0},task_json=${encoded} WHERE project_id=${task.projectId} AND task_id=${task.id}`;
              yield* record(task);
            }),
          ),
        )
        .pipe(Effect.mapError(failure)),
    );
    const list = Effect.fn("TaskInboxStore.list")(function* (projectId: ProjectId) {
      const rows = yield* sql<{
        task_json: string;
      }>`SELECT task_json FROM workspace_task_inbox WHERE project_id=${projectId} ORDER BY created_at DESC, task_id DESC LIMIT 50`;
      return yield* Effect.forEach(rows, (row) => decodeTask(row.task_json));
    }, Effect.mapError(failure));
    const pending = Effect.gen(function* () {
      const rows = yield* sql<{ task_json: string }>`SELECT task_json FROM workspace_task_inbox
      WHERE status IN ('queued','checking','dispatching','running','verifying','cancel-requested') ORDER BY created_at,task_id LIMIT 200`;
      return yield* Effect.forEach(rows, (row) => decodeTask(row.task_json));
    }).pipe(Effect.mapError(failure));
    const previousFingerprint = Effect.fn("TaskInboxStore.previousFingerprint")(function* (
      projectId: ProjectId,
      monitorKey: string,
    ) {
      const rows = yield* sql<{
        task_json: string;
      }>`SELECT e.task_json FROM workspace_task_inbox_events e JOIN workspace_task_inbox t ON e.task_id=t.task_id
      WHERE t.project_id=${projectId} AND t.monitor_key=${monitorKey} AND e.status IN ('completed','unchanged') ORDER BY e.sequence DESC LIMIT 1`;
      return rows[0] ? (yield* decodeTask(rows[0].task_json)).precheckFingerprint : null;
    }, Effect.mapError(failure));
    const counts = Effect.fn("TaskInboxStore.counts")(function* (projectId: ProjectId) {
      const rows = yield* sql<{
        total: number;
        completed: number;
        skipped: number;
        waiting: number;
      }>`SELECT COUNT(*) AS total,
      COALESCE(SUM(status='completed'),0) AS completed, COALESCE(SUM(ai_skipped),0) AS skipped,
      COALESCE(SUM(status IN ('queued','held','checking','dispatching','running','verifying','cancel-requested')),0) AS waiting
      FROM workspace_task_inbox WHERE project_id=${projectId}`;
      const row = rows[0];
      return {
        totalTasks: row?.total ?? 0,
        completed: row?.completed ?? 0,
        aiSkipped: row?.skipped ?? 0,
        waiting: row?.waiting ?? 0,
      };
    }, Effect.mapError(failure));
    const projectBusy = Effect.fn("TaskInboxStore.projectBusy")(function* (projectId: ProjectId) {
      const rows =
        yield* sql`SELECT s.thread_id FROM projection_thread_sessions s JOIN projection_threads t ON s.thread_id=t.thread_id
      JOIN projection_turns v ON v.thread_id=s.thread_id AND v.turn_id=s.active_turn_id
      WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND v.state IN ('pending','running') AND v.completed_at IS NULL LIMIT 1`;
      return rows.length > 0;
    }, Effect.mapError(failure));
    const hasPendingSource = Effect.fn("TaskInboxStore.hasPendingSource")(function* (
      projectId: ProjectId,
      source: string,
      exceptExternalId: string,
    ) {
      const rows =
        yield* sql`SELECT task_id FROM workspace_task_inbox WHERE project_id=${projectId} AND source=${source} AND external_id<>${exceptExternalId}
      AND status IN ('queued','held','checking','dispatching','running','verifying','cancel-requested','delivery-unknown','needs-verification') LIMIT 1`;
      return rows.length > 0;
    }, Effect.mapError(failure));
    return WorkspaceTaskInboxStore.of({
      recipes,
      recipe,
      saveRecipe,
      get,
      insert,
      update,
      list,
      pending,
      previousFingerprint,
      counts,
      projectBusy,
      hasPendingSource,
    });
  }),
);
