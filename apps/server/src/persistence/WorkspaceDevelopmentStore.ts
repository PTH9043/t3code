import {
  WorkspaceDevelopmentError,
  WorkspaceDevelopmentState,
  type CommandId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const StateJson = Schema.fromJsonString(WorkspaceDevelopmentState);
const decodeState = Schema.decodeUnknownEffect(StateJson);
const encodeState = Schema.encodeEffect(StateJson);
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isDevelopmentError = Schema.is(WorkspaceDevelopmentError);

export interface DevelopmentMutation {
  readonly kind: string;
  readonly source: "user" | "main" | "architect" | "runtime" | "git" | "verification";
  readonly payload: unknown;
}

export class WorkspaceDevelopmentStore extends Context.Service<
  WorkspaceDevelopmentStore,
  {
    readonly read: (
      projectId: ProjectId,
    ) => Effect.Effect<WorkspaceDevelopmentState | null, WorkspaceDevelopmentError>;
    readonly list: Effect.Effect<readonly WorkspaceDevelopmentState[], WorkspaceDevelopmentError>;
    readonly hasCommand: (
      projectId: ProjectId,
      commandId: CommandId,
    ) => Effect.Effect<boolean, WorkspaceDevelopmentError>;
    readonly mutate: (
      projectId: ProjectId,
      commandId: CommandId,
      event: DevelopmentMutation,
      change: (
        current: WorkspaceDevelopmentState | null,
      ) => Effect.Effect<WorkspaceDevelopmentState, WorkspaceDevelopmentError>,
    ) => Effect.Effect<WorkspaceDevelopmentState, WorkspaceDevelopmentError>;
  }
>()("t3/persistence/WorkspaceDevelopmentStore") {}

export const layer = Layer.effect(
  WorkspaceDevelopmentStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
    const failure = (cause: unknown) =>
      new WorkspaceDevelopmentError({
        message: "작업실 상태를 저장하거나 조회하지 못했습니다.",
        cause,
      });
    const read = Effect.fn("WorkspaceDevelopmentStore.read")(function* (projectId: ProjectId) {
      const rows = yield* sql<{
        state_json: string;
      }>`SELECT state_json FROM workspace_development_state WHERE project_id = ${projectId}`;
      return rows[0] ? yield* decodeState(rows[0].state_json) : null;
    }, Effect.mapError(failure));
    const list = Effect.gen(function* () {
      const rows = yield* sql<{
        state_json: string;
      }>`SELECT state_json FROM workspace_development_state ORDER BY project_id`;
      return yield* Effect.forEach(rows, (row) => decodeState(row.state_json));
    }).pipe(Effect.mapError(failure));
    const hasCommand = (projectId: ProjectId, commandId: CommandId) =>
      sql`SELECT sequence FROM workspace_development_events WHERE project_id=${projectId} AND command_id=${commandId}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(failure),
      );
    const mutate = Effect.fn("WorkspaceDevelopmentStore.mutate")(
      function* (
        projectId: ProjectId,
        commandId: CommandId,
        event: DevelopmentMutation,
        change: (
          current: WorkspaceDevelopmentState | null,
        ) => Effect.Effect<WorkspaceDevelopmentState, WorkspaceDevelopmentError>,
      ) {
        return yield* lock.withPermits(1)(
          sql.withTransaction(
            Effect.gen(function* () {
              const current = yield* read(projectId);
              const existing =
                yield* sql`SELECT sequence FROM workspace_development_events WHERE project_id = ${projectId} AND command_id = ${commandId}`;
              if (existing.length > 0 && current !== null) return current;
              const changed = yield* change(current);
              const next = { ...changed, revision: (current?.revision ?? 0) + 1 };
              const encoded = yield* encodeState(next);
              const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
              const payload = yield* encodePayload(event.payload);
              yield* sql`INSERT INTO workspace_development_events(project_id,command_id,kind,source,payload_json,created_at)
        VALUES(${projectId},${commandId},${event.kind},${event.source},${payload},${createdAt})`;
              yield* sql`INSERT INTO workspace_development_state(project_id,state_json) VALUES(${projectId},${encoded})
        ON CONFLICT(project_id) DO UPDATE SET state_json = excluded.state_json`;
              return next;
            }),
          ),
        );
      },
      Effect.mapError((cause) => (isDevelopmentError(cause) ? cause : failure(cause))),
    );
    return WorkspaceDevelopmentStore.of({ read, list, mutate, hasCommand });
  }),
);
