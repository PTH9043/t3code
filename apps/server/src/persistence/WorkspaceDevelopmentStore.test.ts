import { CommandId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { WorkspaceDevelopmentStore, layer as StoreLayer } from "./WorkspaceDevelopmentStore.ts";
import { state, task, workspace } from "../orchestration/workspaceDevelopmentFixtures.ts";
import { developmentRecoveryBarrier } from "../orchestration/workspaceDevelopmentRecovery.ts";

const testLayer = it.layer(StoreLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
testLayer("WorkspaceDevelopmentStore", (it) => {
  it.effect(
    "outbox and immutable input reference commit together and duplicate command is ignored",
    () =>
      Effect.gen(function* () {
        const store = yield* WorkspaceDevelopmentStore;
        const commandId = CommandId.make("durable-input");
        const mutation = {
          kind: "input.queued",
          source: "main" as const,
          payload: { messageId: task.messageId },
        };
        const first = yield* store.mutate(state.projectId, commandId, mutation, () =>
          Effect.succeed({ ...state, tasks: [task] }),
        );
        const repeated = yield* store.mutate(state.projectId, commandId, mutation, () =>
          Effect.die("Duplicate should never invoke mutation"),
        );
        expect(repeated.revision).toBe(first.revision);
        expect(repeated.tasks).toHaveLength(1);
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql`SELECT command_id FROM workspace_development_events WHERE project_id=${state.projectId}`,
        ).toEqual([{ command_id: commandId }]);
      }),
  );
  it.effect("serializes independent updates without holding a transaction across an LLM run", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceDevelopmentStore;
      yield* Effect.forEach(
        ["one", "two", "three"],
        (key) =>
          store.mutate(
            state.projectId,
            CommandId.make(key),
            { kind: "counter", source: "runtime", payload: {} },
            (current) =>
              Effect.succeed({
                ...(current ?? state),
                mainActedRevision: (current?.mainActedRevision ?? 0) + 1,
              }),
          ),
        { concurrency: "unbounded" },
      );
      const loaded = yield* store.read(state.projectId);
      expect(loaded?.mainActedRevision).toBe(3);
      expect(loaded?.tasks[0]?.messageId).toBe(task.messageId);
    }),
  );
  it.effect(
    "retains uncertain delivery and its barrier after persistence and checkout changes",
    () =>
      Effect.gen(function* () {
        const store = yield* WorkspaceDevelopmentStore;
        yield* store.mutate(
          state.projectId,
          CommandId.make("uncertain-durable"),
          { kind: "run.interrupted", source: "runtime", payload: {} },
          () =>
            Effect.succeed({
              ...state,
              tasks: [
                {
                  ...task,
                  status: "delivery_unknown",
                  delivery: "delivery_unknown",
                  failureCodeFingerprint: "old-checkout",
                },
              ],
            }),
        );
        const saved = yield* store.read(state.projectId);
        const changed = {
          ...workspace,
          observedFingerprint: "changed-checkout",
          requirementRevision: 2,
        };
        expect(
          developmentRecoveryBarrier(saved!, changed, task.objective, "repair-and-verify"),
        ).toContain("전달 여부");
        expect(saved?.tasks[0]?.messageId).toBe(task.messageId);
        expect(saved?.tasks[0]?.commandId).toBe(task.commandId);
        expect(saved?.runtimeMode).toBe(state.runtimeMode);
      }),
  );
});
