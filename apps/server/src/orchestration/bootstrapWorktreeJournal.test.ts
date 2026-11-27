import { CommandId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { makeBootstrapWorktreeJournal } from "./bootstrapWorktreeJournal.ts";

it.effect("records owned bootstrap stages and rejects stale or unrelated transitions", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 87 });
    yield* sql`INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)
      VALUES ('legacy','thread','old-thread','2026-01-01T00:00:00.000Z',3,'accepted',NULL)`;
    expect(yield* runMigrations()).toContainEqual([88, "BootstrapWorktreeJournal"]);
    const journal = makeBootstrapWorktreeJournal(sql);
    const id = {
      commandId: CommandId.make("task"),
      threadId: ThreadId.make("thread"),
      requestFingerprint: "a".repeat(64),
      creationCommandId: CommandId.make("create"),
    };
    expect((yield* journal.begin(id)).phase).toBe("initial");
    expect((yield* journal.begin(id)).phase).toBe("initial");
    expect(
      (yield* Effect.exit(
        sql`UPDATE bootstrap_worktree_journal SET phase='worktree-ready' WHERE command_id='task'`,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.exit(journal.begin({ ...id, requestFingerprint: "b".repeat(64) })))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.exit(journal.begin({ ...id, threadId: ThreadId.make("other") })))._tag,
    ).toBe("Failure");
    expect((yield* journal.advance(id, { from: "initial", to: "provisioning" })).phase).toBe(
      "provisioning",
    );
    expect((yield* journal.begin(id)).phase).toBe("provisioning");
    expect(
      (yield* Effect.exit(
        journal.advance(id, {
          from: "provisioning",
          to: "worktree-ready",
          worktreePath: "",
          worktreeRef: "main",
        }),
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.exit(journal.advance(id, { from: "initial", to: "provisioning" })))._tag,
    ).toBe("Failure");
    const ready = yield* journal.advance(id, {
      from: "provisioning",
      to: "worktree-ready",
      worktreePath: "/repo/worktree",
      worktreeRef: "t3/task",
    });
    expect(ready.worktreePath).toBe("/repo/worktree");
    expect(ready.worktreeRef).toBe("t3/task");
    yield* journal.advance(id, { from: "worktree-ready", to: "setting-up" });
    const finished = yield* journal.advance(id, {
      from: "setting-up",
      to: "setup-finished",
      setupOutcome: "started",
    });
    expect(finished.setupOutcome).toBe("started");
    expect(yield* journal.begin(id)).toEqual(finished);
    expect(
      yield* sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id='legacy'`,
    ).toEqual([{ command_id: "legacy" }]);
    expect(yield* runMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("preserves in-progress and completed setup stages when the database is reopened", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-journal-test-" });
    const filename = path.join(directory, "journal.sqlite");
    const id = {
      commandId: CommandId.make("restart-task"),
      threadId: ThreadId.make("restart-thread"),
      requestFingerprint: "c".repeat(64),
      creationCommandId: CommandId.make("restart-create"),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(NodeSqliteClient.layer({ filename }));
        const sql = yield* Effect.service(SqlClient.SqlClient).pipe(Effect.provide(services));
        yield* runMigrations().pipe(Effect.provide(services));
        const journal = makeBootstrapWorktreeJournal(sql);
        yield* journal.begin(id);
        yield* journal.advance(id, { from: "initial", to: "provisioning" });
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(NodeSqliteClient.layer({ filename }));
        const sql = yield* Effect.service(SqlClient.SqlClient).pipe(Effect.provide(services));
        const journal = makeBootstrapWorktreeJournal(sql);
        expect((yield* journal.begin(id)).phase).toBe("provisioning");
        yield* journal.advance(id, {
          from: "provisioning",
          to: "worktree-ready",
          worktreePath: "/repo/tree",
          worktreeRef: "t3/ref",
        });
        yield* journal.advance(id, { from: "worktree-ready", to: "setting-up" });
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(NodeSqliteClient.layer({ filename }));
        const sql = yield* Effect.service(SqlClient.SqlClient).pipe(Effect.provide(services));
        const journal = makeBootstrapWorktreeJournal(sql);
        const state = yield* journal.begin(id);
        expect(state.phase).toBe("setting-up");
        expect(state.worktreePath).toBe("/repo/tree");
        expect(state.setupOutcome).toBeNull();
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
