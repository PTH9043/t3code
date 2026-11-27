import {
  knowledgeWriteCommand,
  legacyKnowledgeWriteCommand,
  userKnowledgeForkId,
} from "../knowledgeDocuments.ts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import {
  WorkspaceProgramId,
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  ProviderInstanceId,
  WorkspaceCollaborationRunId,
  WorkspaceKnowledgeItemId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { bootstrapCreateCommandId, normalizedTurnRequestDigest } from "../turnRequestDigest.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { upgradeRoomIds } from "../../upgradeRoom.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

async function createOrchestrationSystem(
  eventStore = OrchestrationEventStoreLive,
  dbPath?: string,
  upgradeRoom?: ServerConfig["Service"]["upgradeRoom"],
) {
  const baseConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  const ServerConfigLayer = upgradeRoom
    ? Layer.effect(
        ServerConfig,
        Effect.map(ServerConfig, (cfg) => ({ ...cfg, upgradeRoom })),
      ).pipe(Layer.provide(baseConfig))
    : baseConfig;
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(eventStore),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(dbPath ? makeSqlitePersistenceLive(dbPath) : SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  return {
    engine,
    sql,
    snapshotQuery,
    wikiLinks: (projectId: ProjectId, itemId: string) =>
      runtime.runPromise(
        snapshotQuery.getWorkspaceWikiLinks!({
          projectId,
          itemId: WorkspaceKnowledgeItemId.make(itemId),
        }),
      ),
    replayEvent: (event: OrchestrationEvent) =>
      runtime.runPromise(
        Effect.flatMap(OrchestrationProjectionPipeline, (p) => p.projectEvent(event)),
      ),
    bootstrap: () =>
      runtime.runPromise(Effect.flatMap(OrchestrationProjectionPipeline, (p) => p.bootstrap)),
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

async function createBootstrapRoom(system: Awaited<ReturnType<typeof createOrchestrationSystem>>) {
  const projectId = asProjectId("seed-project");
  const threadId = ThreadId.make("seed-room");
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "answer" };
  const createdAt = now();
  const dispatch = (command: import("@t3tools/contracts").OrchestrationCommand) =>
    system.run(system.engine.dispatch(command));
  const turn = (id: string) => ({
    type: "thread.turn.start" as const,
    commandId: CommandId.make(id),
    threadId,
    modelSelection,
    message: { messageId: asMessageId(id), role: "user" as const, text: id, attachments: [] },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    createdAt,
  });
  const team = {
    threadId,
    answeringInstanceId: modelSelection.instanceId,
    forModel: modelSelection.model,
    members: [],
  };
  const first = {
    ...turn("seed-first"),
    requestFingerprint: "a".repeat(64),
    initialModelTeams: [team],
  };
  const owner = bootstrapCreateCommandId(first);
  await dispatch({
    type: "project.create",
    commandId: CommandId.make("seed-project-create"),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/seed",
    defaultModelSelection: modelSelection,
    createdAt,
  });
  await dispatch({
    type: "thread.create",
    commandId: owner,
    threadId,
    projectId,
    title: "Room",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  const cleanup = (id: string) =>
    dispatch({
      type: "thread.delete",
      commandId: CommandId.make(id),
      threadId,
      expectedCreationCommandId: owner,
    });
  const pending = () =>
    system.run(system.sql<{ event_sequence: number }>`
    SELECT event_sequence FROM pending_thread_model_team_seeds WHERE thread_id=${threadId}`);
  const turns = () =>
    system.run(system.sql<{ sequence: number }>`
    SELECT sequence FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=${threadId}
      AND event_type='thread.turn-start-requested' ORDER BY sequence`);
  return {
    dispatch,
    threadId,
    turn,
    owner,
    team,
    first: { ...first, bootstrapCreateClaim: owner },
    cleanup,
    pending,
    turns,
  };
}

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("OrchestrationEngine", () => {
  it("dedicated upgrade room bootstraps once, rejects other rooms and retains the exact selection and permissions on restart", async () => {
    const { fs, join, root } = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "t3-upgrade-restart-" });
        return { fs, join, root };
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const config = { projectRoot: root, primaryHome: join(root, "offline") };
    const open = () =>
      createOrchestrationSystem(OrchestrationEventStoreLive, join(root, "room.db"), config);
    const modelSelection = {
      instanceId: ProviderInstanceId.make("fixture_account"),
      model: "fixture-model",
    };
    try {
      const first = await open();
      try {
        expect((await first.readModel()).projects.map((p) => p.id)).toEqual([
          upgradeRoomIds.projectId,
        ]);
        expect((await first.readModel()).threads).toHaveLength(0);
        const create = {
          type: "thread.create" as const,
          ...upgradeRoomIds,
          commandId: CommandId.make("pick-model"),
          modelSelection,
          title: "Upgrade",
          branch: null,
          worktreePath: null,
          runtimeMode: "approval-required" as const,
          interactionMode: "plan" as const,
          createdAt: now(),
        };
        await expect(
          first.run(
            first.engine.dispatch({
              ...create,
              commandId: CommandId.make("foreign"),
              threadId: ThreadId.make("another"),
            }),
          ),
        ).rejects.toThrow();
        await first.run(first.engine.dispatch(create));
      } finally {
        await first.dispose();
      }
      const second = await open();
      try {
        const state = await second.readModel();
        expect(state.projects).toHaveLength(1);
        expect(state.threads).toHaveLength(1);
        expect(state.threads[0]).toMatchObject({
          id: upgradeRoomIds.threadId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          messages: [],
        });
        expect(await second.run(second.engine.latestSequence)).toBe(2);
        const createdAt = now();
        await second.run(
          second.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("fake-running-session"),
            threadId: upgradeRoomIds.threadId,
            session: {
              threadId: upgradeRoomIds.threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: modelSelection.instanceId,
              runtimeMode: "approval-required",
              activeTurnId: TurnId.make("fake-turn"),
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
      } finally {
        await second.dispose();
      }
      const recovered = await open();
      try {
        expect((await recovered.readModel()).threads[0]).toMatchObject({
          modelSelection,
          messages: [],
          interactionMode: "plan",
          session: { status: "interrupted", activeTurnId: null, runtimeMode: "approval-required" },
        });
      } finally {
        await recovered.dispose();
      }
    } finally {
      await Effect.runPromise(fs.remove(root, { recursive: true }));
    }
  });
  it("forks plain historical agent documents through both public editor command paths", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("legacy-agent-notes");
    const createdAt = now();
    const dispatch = (command: import("@t3tools/contracts").OrchestrationCommand) =>
      system.run(system.engine.dispatch(command));
    try {
      await dispatch({
        type: "project.create",
        commandId: CommandId.make("legacy-project"),
        projectId,
        title: "Legacy",
        workspaceRoot: "/tmp/legacy",
        defaultModelSelection: null,
        createdAt,
      });
      for (const mode of ["legacy", "edit"] as const) {
        const itemId = WorkspaceKnowledgeItemId.make(mode);
        const source = {
          type: "project.knowledge.item.upsert",
          projectId,
          itemId,
          createdAt,
          kind: "directive",
          origin: "agent",
          status: "active",
          title: "Old note",
          content: "Agent text",
          relativeFolder: null,
          tags: [],
          commandId: CommandId.make(mode + "-capture"),
        } as const;
        const { sequence } = await dispatch(source);
        const edit = {
          projectId,
          itemId,
          title: source.title,
          content: "Human text",
          expectedSequence: sequence,
          commandId: CommandId.make(mode + "-human"),
        };
        const write =
          mode === "legacy"
            ? legacyKnowledgeWriteCommand({
                ...source,
                ...edit,
                origin: "user",
                provenance: { runId: WorkspaceCollaborationRunId.make("unrelated") },
                sourceItemId: itemId,
              })
            : knowledgeWriteCommand(edit, { mode, edit }, createdAt);
        await dispatch(write);
        const read = (id: typeof itemId) =>
          system
            .run(system.snapshotQuery.listWorkspaceKnowledge!({ projectId, itemId: id }))
            .then((page) => page.items[0]);
        expect(await read(itemId)).toMatchObject({
          id: itemId,
          origin: "agent",
          content: "Agent text",
        });
        const fork = await read(userKnowledgeForkId(itemId));
        expect(fork).toMatchObject({ sourceItemId: itemId, origin: "user", content: "Human text" });
        expect(fork?.provenance).toBeFalsy();
      }
    } finally {
      await system.dispose();
    }
  });

  it("keeps captured knowledge, human revisions and run lookups within their owning project", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("knowledge-owner");
    const other = asProjectId("knowledge-other");
    const itemId = WorkspaceKnowledgeItemId.make("same-document-id");
    const runId = WorkspaceCollaborationRunId.make("owner-run");
    const threadId = ThreadId.make("owner-thread");
    const createdAt = now();
    const dispatch = (command: import("@t3tools/contracts").OrchestrationCommand) =>
      system.run(system.engine.dispatch(command));
    const list = (input: import("@t3tools/contracts").WorkspaceKnowledgeListInput) =>
      system
        .run(system.snapshotQuery.listWorkspaceKnowledge!(input))
        .then((result) => result.items);
    const base = {
      projectId,
      itemId,
      createdAt,
      type: "project.knowledge.item.upsert",
      title: "Source",
      content: "Captured",
      status: "active",
      origin: "agent",
      kind: "rag-source",
      tags: ["auto-agent-output"],
      relativeFolder: null,
      provenance: { runId, threadId },
    } as const;
    try {
      for (const id of [projectId, other])
        await dispatch({
          type: "project.create",
          projectId: id,
          commandId: CommandId.make(id),
          title: id,
          workspaceRoot: "/tmp/" + id,
          createdAt,
          defaultModelSelection: null,
        });
      const original = await dispatch({ ...base, commandId: CommandId.make("capture") });
      await dispatch({
        ...base,
        projectId: other,
        content: "other project",
        provenance: { runId: WorkspaceCollaborationRunId.make("other-run") },
        commandId: CommandId.make("other-capture"),
      });
      const key = { projectId, itemId };
      const edit = {
        ...key,
        commandId: CommandId.make("human-edit"),
        expectedSequence: original.sequence,
        title: "User note",
        content: "Manual body",
      };
      const write = knowledgeWriteCommand(edit, { mode: "edit", edit }, createdAt);
      const [first, retry] = await Promise.all([dispatch(write), dispatch(write)]);
      expect(retry.sequence).toBe(first.sequence);
      const forkId = userKnowledgeForkId(itemId);
      expect(
        await system.run(
          system.snapshotQuery.knowledgeWriteResult!(projectId, edit.commandId, first.sequence),
        ),
      ).toBe(forkId);
      expect(await list({ projectId, sourceItemId: itemId })).toMatchObject([
        {
          id: forkId,
          sourceItemId: itemId,
          provenance: { runId, threadId },
          origin: "user",
          content: "Manual body",
        },
      ]);
      const [refresh, again] = await Promise.all([
        dispatch({
          ...base,
          commandId: CommandId.make("new-capture"),
          content: "Updated by agent",
        }),
        dispatch(write),
      ]);
      expect(again.sequence).toBe(first.sequence);
      expect(await list({ projectId, itemId })).toMatchObject([
        { content: "Updated by agent", origin: "agent" },
      ]);
      expect(await list({ projectId: other, itemId })).toMatchObject([
        { content: "other project" },
      ]);
      expect(await list({ projectId: other, sourceRunId: runId, includeShared: true })).toEqual([]);
      expect(await list({ projectId, sourceItemId: itemId, summariesOnly: true })).toMatchObject([
        { id: forkId, content: "", sourceItemId: itemId },
      ]);
      expect((await list({ projectId, sourceRunId: runId })).map((x) => x.id).sort()).toEqual(
        [itemId, forkId].sort(),
      );
      const stale = { ...edit, commandId: CommandId.make("stale-edit") };
      await expect(
        dispatch(knowledgeWriteCommand(stale, { mode: "edit", edit: stale }, createdAt)),
      ).rejects.toThrow();
      const next = {
        ...edit,
        itemId: forkId,
        commandId: CommandId.make("fork-edit"),
        expectedSequence: first.sequence,
        content: "password=synthetic-private-value",
      };
      const revised = await dispatch(
        knowledgeWriteCommand(next, { mode: "edit", edit: next }, createdAt),
      );
      const archive = await dispatch({
        type: "project.knowledge.item.archive",
        projectId,
        itemId: forkId,
        commandId: CommandId.make("archive-fork"),
        createdAt,
      });
      const revisions = (beforeSequence?: number) =>
        system.run(
          system.snapshotQuery.listWorkspaceKnowledgeRevisions!({
            projectId,
            itemId: forkId,
            limit: 2,
            ...(beforeSequence ? { beforeSequence } : {}),
          }),
        );
      const page = await revisions();
      expect(page.revisions.map((x) => x.sequence)).toEqual([archive.sequence, revised.sequence]);
      expect((await revisions(page.nextBeforeSequence!)).revisions.map((x) => x.sequence)).toEqual([
        first.sequence,
      ]);
      const detail = (p: typeof projectId, sequence: number, id = forkId) =>
        system.run(
          system.snapshotQuery.getWorkspaceKnowledgeRevision!({
            projectId: p,
            itemId: id,
            sequence,
          }),
        );
      expect((await detail(projectId, archive.sequence)).revision?.content).toBeNull();
      expect((await detail(projectId, revised.sequence)).revision?.content).not.toContain(
        "synthetic-private-value",
      );
      expect((await detail(other, revised.sequence)).revision).toBeNull();
      expect((await detail(projectId, refresh.sequence)).revision).toBeNull();
      await dispatch(
        knowledgeWriteCommand(
          { ...key, itemId: forkId, commandId: CommandId.make("restore-fork") },
          { mode: "restore" },
          createdAt,
        ),
      );
      expect(await list({ projectId, itemId: forkId })).toMatchObject([
        { status: "active", sourceItemId: itemId, content: next.content },
      ]);
      const searchFork = () =>
        system
          .run(
            system.snapshotQuery.searchWorkspaceRag!({
              projectId,
              query: "synthetic-private-value",
            }),
          )
          .then((result) => result.matches.map((match) => match.itemId));
      expect(await searchFork()).toContain(forkId);
      await system.run(
        system.sql`DELETE FROM projection_workspace_knowledge_items WHERE project_id=${projectId} AND item_id=${itemId}`,
      );
      expect(await searchFork()).not.toContain(forkId);
      expect(await list({ projectId, itemId: forkId })).toEqual([]);
      expect((await detail(projectId, first.sequence)).revision).toBeNull();
    } finally {
      await system.dispose();
    }
  });

  it("projects scoped knowledge metrics and atomically maintains bulk revisions and shared searches", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("knowledge-management");
    const other = asProjectId("other-knowledge-management");
    const a = WorkspaceKnowledgeItemId.make("unrelated-label");
    const b = WorkspaceKnowledgeItemId.make("different-label");
    const c = WorkspaceKnowledgeItemId.make("same-hash-looking-label");
    const stamp = now();
    const base = { projectId, createdAt: stamp };
    const dashboard = (
      filters: Partial<import("@t3tools/contracts").WorkspaceKnowledgeDashboardInput> = {},
    ) =>
      system.run(system.snapshotQuery.getWorkspaceKnowledgeDashboard!({ projectId, ...filters }));
    const dispatch = (command: import("@t3tools/contracts").OrchestrationCommand) =>
      system.run(system.engine.dispatch(command));
    try {
      for (const id of [projectId, other]) {
        await dispatch({
          type: "project.create",
          projectId: id,
          commandId: CommandId.make(id),
          title: id,
          workspaceRoot: `/tmp/${id}`,
          defaultModelSelection: null,
          createdAt: stamp,
        });
      }
      expect((await dashboard()).compaction.reductionRatio).toBeNull();
      for (const [itemId, project, body, originalChars, storedChars] of [
        [a, projectId, "identical", 100, 20],
        [b, projectId, "identical", 10, 10],
        [c, projectId, "different", null, null],
        [a, other, "identical", 500, 30],
      ] as const) {
        await dispatch({
          type: "project.knowledge.item.upsert",
          ...base,
          projectId: project,
          itemId,
          commandId: CommandId.make(`${project}-${itemId}`),
          kind: "rag-source",
          status: "candidate",
          origin: "agent",
          title: itemId,
          content: body,
          relativeFolder: null,
          tags: [],
          research: {
            query: "origin",
            sources: ["source"],
            capturedAt: stamp,
            verification: "verified",
            lineage: { canonicalId: itemId, revision: 7 },
          },
          ...(originalChars === null ? {} : { originalChars, storedChars: storedChars! }),
        });
      }
      await dispatch({
        type: "project.knowledge.usage.record",
        commandId: CommandId.make("use"),
        projectId,
        itemIds: [b],
        usedAt: stamp,
      });
      const metrics = await dashboard({ query: "identical", limit: 1 });
      expect(metrics).toMatchObject({
        total: 3,
        byKind: [{ kind: "rag-source", count: 3 }],
        byStatus: [{ status: "candidate", count: 3 }],
        growth: [{ day: "2026-01-01", count: 3 }],
        matching: { total: 2 },
        candidates: { total: 3 },
        mostUsed: { total: 1, items: [{ id: b }] },
        unused: { total: 2 },
        duplicates: { total: 1, items: [{ count: 2 }] },
        compaction: { measuredItems: 2, originalChars: 110, storedChars: 30 },
      });
      expect(metrics.compaction.reductionRatio).toBeCloseTo(1 - 30 / 110);
      const byHash = await dashboard({
        contentHash: metrics.duplicates.items[0]!.contentHash,
        offset: 1,
        limit: 1,
      });
      expect(byHash.matching.total).toBe(2);
      expect(byHash.matching.items).toHaveLength(1);
      expect(metrics.matching.items[0]).not.toHaveProperty("content");
      const selected = (await dashboard()).matching.items
        .filter((row) => row.id === a || row.id === b)
        .map(({ id, updatedAt, revisionSequence }) => ({ id, updatedAt, revisionSequence }));
      const merge = {
        type: "project.knowledge.bulk" as const,
        ...base,
        commandId: CommandId.make("merge"),
        items: selected,
        operation: { type: "merge" as const, targetId: a },
      };
      await expect(
        dispatch({
          ...merge,
          commandId: CommandId.make("invalid"),
          operation: { type: "archive" },
          items: selected.map((row) =>
            row.id === b ? { ...row, updatedAt: "2020-01-01T00:00:00.000Z" } : row,
          ),
        }),
      ).rejects.toThrow();
      expect((await dashboard()).byStatus).toEqual([{ status: "candidate", count: 3 }]);
      await expect(
        dispatch({ ...merge, projectId: other, commandId: CommandId.make("cross-project") }),
      ).rejects.toThrow();
      await expect(
        dispatch({
          ...merge,
          commandId: CommandId.make("stale-revision"),
          items: selected.map((row) => ({ ...row, revisionSequence: 0 })),
        }),
      ).rejects.toThrow();
      const aborted = CommandId.make("rollback-batch");
      await system.run(system.sql`CREATE TRIGGER refuse_second_revision
        BEFORE INSERT ON orchestration_events WHEN NEW.command_id='rollback-batch'
        AND json_extract(NEW.payload_json,'$.itemId')='different-label'
        BEGIN SELECT RAISE(ABORT,'injected partial failure'); END`);
      await expect(
        dispatch({ ...merge, commandId: aborted, operation: { type: "archive" } }),
      ).rejects.toThrow();
      expect((await dashboard()).byStatus).toEqual([{ status: "candidate", count: 3 }]);
      expect(
        await system.run(
          system.sql`SELECT sequence FROM orchestration_events WHERE command_id=${aborted}`,
        ),
      ).toHaveLength(0);
      await system.run(system.sql`DROP TRIGGER refuse_second_revision`);
      const accepted = await dispatch(merge);
      expect(await dispatch(merge)).toEqual({ ...accepted, replayed: true });
      await expect(dispatch({ ...merge, operation: { type: "archive" } })).rejects.toThrow();
      const after = await system.run(system.snapshotQuery.listWorkspaceKnowledge!({ projectId }));
      expect(after.items.find((row) => row.id === b)).toMatchObject({
        status: "superseded",
        supersededBy: a,
        content: "identical",
        promptUses: 1,
        research: { lineage: { canonicalId: b, revision: 7 } },
      });
      expect(after.items.find((row) => row.id === a)?.content).toBe("identical");
      const capture = {
        type: "project.knowledge.item.upsert" as const,
        ...base,
        commandId: CommandId.make("recapture"),
        itemId: b,
        kind: "rag-source" as const,
        status: "active" as const,
        origin: "agent" as const,
        title: "recaptured",
        content: "new capture",
        relativeFolder: null,
        tags: [],
      };
      await dispatch(capture);
      expect((await dashboard({ query: "recaptured" })).matching.items).toMatchObject([
        { id: b, status: "superseded", supersededBy: a },
      ]);
      expect(
        await system.run(system.sql`SELECT json_extract(payload_json,'$.supersededBy') AS target
        FROM orchestration_events WHERE command_id=${capture.commandId}`),
      ).toEqual([{ target: a }]);
      for (const operation of [
        { type: "promote" },
        { type: "reclassify", kind: "prompt" },
        { type: "archive" },
      ] as const) {
        const [item] = (await dashboard({ query: c })).matching.items;
        await dispatch({
          ...merge,
          commandId: CommandId.make(operation.type),
          items: [{ id: c, updatedAt: item!.updatedAt, revisionSequence: item!.revisionSequence }],
          operation,
        });
      }
      expect(
        (
          await dashboard({ status: "archived", kind: "prompt", usage: "unused" })
        ).matching.items.map((row) => row.id),
      ).toEqual([c]);
      expect(
        await system.run(system.sql`SELECT event_type AS type FROM orchestration_events
        WHERE command_id='archive'`),
      ).toEqual([{ type: "project.knowledge-item-archived" }]);
      const save = {
        type: "project.knowledge.search.save" as const,
        ...base,
        commandId: CommandId.make("save"),
        id: "daily",
        name: "Candidates",
        filters: { status: "candidate" as const },
        expectedUpdatedAt: null,
      };
      await dispatch(save);
      expect((await dashboard()).savedSearches).toEqual([
        { id: save.id, name: save.name, filters: save.filters, updatedAt: stamp },
      ]);
      expect((await dashboard({ projectId: other })).savedSearches).toEqual([]);
      await expect(
        dispatch({ ...save, commandId: CommandId.make("stale-save") }),
      ).rejects.toThrow();
      const edits = ["Renamed", "Concurrent rename"].map((name) => ({
        ...save,
        commandId: CommandId.make(name),
        expectedUpdatedAt: stamp,
        name,
      }));
      const attempts = await Promise.allSettled(edits.map(dispatch));
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const [edited] = (await dashboard()).savedSearches;
      expect(edited!.updatedAt).not.toBe(stamp);
      const remove = {
        type: "project.knowledge.search.remove" as const,
        ...base,
        commandId: CommandId.make("remove"),
        id: save.id,
        expectedUpdatedAt: edited!.updatedAt,
      };
      await expect(
        dispatch({
          ...remove,
          commandId: CommandId.make("stale-remove"),
          expectedUpdatedAt: stamp,
        }),
      ).rejects.toThrow();
      const removed = await dispatch(remove);
      expect(await dispatch(remove)).toEqual({ ...removed, replayed: true });
      expect((await dashboard()).savedSearches).toEqual([]);
    } finally {
      await system.dispose();
    }
  });

  it("rewrites bound wiki links atomically on captured originals and human forks and replays the same chosen IDs", async () => {
    const system = await createOrchestrationSystem();
    const replica = await createOrchestrationSystem();
    const projectId = ProjectId.make("wiki-renames");
    const content = "before [[Old|label]] and `[[Old]]`";
    let command = 0;
    const upsert = (id: string, title: string, body: string, tags: string[] = []) => ({
      type: "project.knowledge.item.upsert" as const,
      commandId: CommandId.make("wiki-" + ++command),
      projectId,
      itemId: WorkspaceKnowledgeItemId.make(id),
      title,
      content: body,
      kind: "rag-source" as const,
      status: "active" as const,
      origin: tags.length ? ("agent" as const) : ("user" as const),
      scope: "folder" as const,
      appliesToFolder: "notes",
      relativeFolder: "archive",
      tags,
      createdAt: now(),
    });
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("wiki-create"),
          projectId,
          title: "Wiki",
          workspaceRoot: "/wiki-renames",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      const dispatch = (input: ReturnType<typeof upsert>) =>
        system.run(system.engine.dispatch(input));
      await dispatch(upsert("target", "Old", "self [[Old]]"));
      await dispatch(upsert("ref", "Ref", content));
      const capture = await system.run(
        system.engine.dispatch({
          ...upsert("capture", "Capture", content, ["auto-agent-output"]),
          provenance: { threadId: ThreadId.make("source-thread") },
          originalChars: 400,
          storedChars: 200,
        }),
      );
      await dispatch(upsert("other", "Old", ""));
      await dispatch(upsert("collision", "Crowded", ""));
      await dispatch(upsert("ref", "Ref", content + " and new [[Old]]; [[id:other|choice]]"));
      const before = await system.wikiLinks(projectId, "ref");
      expect(before.outgoing.map((x) => x.targetItemId)).toEqual(["target", null, "other"]);
      const rename = upsert("target", "Crowded", "changed self [[Old]]");
      const result = await dispatch(rename);
      expect(await dispatch(rename)).toEqual({ ...result, replayed: true });
      const writes = await system.run(system.sql<{
        id: string;
        body: string;
        scope: string;
        seq: number;
        actor: string;
      }>`
        SELECT json_extract(payload_json,'$.itemId') AS id, json_extract(payload_json,'$.content') AS body,
          json_extract(payload_json,'$.appliesToFolder') AS scope, sequence AS seq, actor_kind AS actor FROM orchestration_events
        WHERE correlation_id=${rename.commandId} ORDER BY sequence`);
      expect(writes).toHaveLength(3);
      expect(writes.at(-1)).toMatchObject({
        id: "target",
        seq: result.sequence,
        body: "changed self [[Crowded]]",
      });
      expect(writes.find((x) => x.id === "ref")).toMatchObject({
        scope: "notes",
        body: "before [[Crowded|label]] and `[[Old]]` and new [[Old]]; [[id:other|choice]]",
      });
      expect(writes.find((x) => x.id === "capture")).toMatchObject({
        actor: "server",
        body: "before [[Crowded|label]] and `[[Old]]`",
      });
      const snapshot = await system.run(
        system.sql<{
          body: string;
        }>`SELECT json_extract(payload_json,'$.content') AS body FROM orchestration_events WHERE sequence=${capture.sequence}`,
      );
      expect(snapshot[0]?.body).toBe(content);
      expect(
        await system.run(
          system.sql`SELECT 1 FROM projection_workspace_knowledge_items WHERE source_item_id=\'capture\'`,
        ),
      ).toHaveLength(0);
      expect(
        (await system.wikiLinks(projectId, "ref")).outgoing.map((x) => x.targetItemId),
      ).toEqual(["target", null, "other"]);
      const human = upsert(
        "capture",
        "Manual",
        "my prefix [[Crowded|label]] suffix [[id:other|other]]",
      );
      const saved = await system.run(
        system.engine.dispatch({ ...human, documentWrite: { mode: "legacy" } }),
      );
      const fork = (await system.run(
        system.snapshotQuery.knowledgeWriteResult!(projectId, human.commandId, saved.sequence),
      ))!;
      expect(fork).not.toBe("capture");
      await dispatch(upsert("target", "Final", "changed self [[Crowded]]"));
      const docs = await system.run(system.sql<{ id: string; body: string; source: string | null }>`
        SELECT item_id AS id,content AS body,source_item_id AS source FROM projection_workspace_knowledge_items
        WHERE project_id=${projectId} AND (item_id='capture' OR source_item_id='capture')`);
      expect(docs).toHaveLength(2);
      expect(docs).toContainEqual({
        id: "capture",
        body: "before [[Final|label]] and `[[Old]]`",
        source: null,
      });
      expect(docs).toContainEqual({
        id: fork,
        body: "my prefix [[Final|label]] suffix [[id:other|other]]",
        source: "capture",
      });
      const capturedFields =
        await system.run(system.sql`SELECT origin, original_chars, stored_chars,
        json_extract(provenance_json,\'$.threadId\') AS thread FROM projection_workspace_knowledge_items
        WHERE project_id=${projectId} AND item_id=\'capture\'`);
      expect(capturedFields).toEqual([
        { origin: "agent", original_chars: 400, stored_chars: 200, thread: "source-thread" },
      ]);
      const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
      for (const event of events) await replica.replayEvent(event);
      for (const id of ["ref", "target", "capture", fork, "other"]) {
        expect(await replica.wikiLinks(projectId, id)).toEqual(
          await system.wikiLinks(projectId, id),
        );
      }
      const replayedDocs =
        await replica.run(replica.sql`SELECT item_id AS id,content AS body,source_item_id AS source
        FROM projection_workspace_knowledge_items WHERE project_id=${projectId} AND (item_id=\'capture\' OR source_item_id=\'capture\')`);
      expect(replayedDocs).toEqual(docs);
      const failing = upsert("target", "Rollback", "changed self [[Final]]");
      await system.run(system.sql`CREATE TRIGGER fail_wiki_rename BEFORE UPDATE OF title ON projection_workspace_knowledge_items
        WHEN NEW.title='Rollback' BEGIN SELECT RAISE(ABORT,'injected rollback'); END`);
      await expect(dispatch(failing)).rejects.toThrow();
      const count = await system.run(
        system.sql<{
          n: number;
        }>`SELECT count(*) AS n FROM orchestration_events WHERE correlation_id=${failing.commandId}`,
      );
      expect(count[0]?.n).toBe(0);
      expect(await system.wikiLinks(projectId, "target")).toEqual(
        await replica.wikiLinks(projectId, "target"),
      );
    } finally {
      await system.dispose();
      await replica.dispose();
    }
  });

  it("requires direct choice for a fresh same-title wiki link at the original editor offset", async () => {
    const system = await createOrchestrationSystem();
    const projectId = ProjectId.make("wiki-editor");
    const itemId = WorkspaceKnowledgeItemId.make("edited");
    const seed = (id: string, title: string, content: string) =>
      system.run(
        system.engine.dispatch({
          type: "project.knowledge.item.upsert",
          projectId,
          itemId: WorkspaceKnowledgeItemId.make(id),
          title,
          content,
          kind: "rag-source",
          status: "active",
          origin: "user",
          relativeFolder: null,
          tags: [],
          commandId: CommandId.make("seed-" + id),
          createdAt: now(),
        }),
      );
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("create"),
          projectId,
          title: "Editor",
          workspaceRoot: "/wiki-editor",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      await seed("first", "Same", "");
      const original = await seed(itemId, "Edited", "[[Same]]");
      await seed("second", "Same", "");
      const { knowledgeWriteCommand } = await import("../knowledgeDocuments.ts");
      const edit = {
        projectId,
        itemId,
        expectedSequence: original.sequence,
        commandId: CommandId.make("edit"),
        title: "Edited",
        content: "[[Same]] new; original [[id:first|Same]]",
        wikiLinksCanonicalized: true,
      };
      const write = (input: typeof edit) =>
        system.run(
          system.engine.dispatch(
            knowledgeWriteCommand(input, { mode: "edit", edit: input }, now()),
          ),
        );
      const saved = await write(edit);
      expect(
        (await system.wikiLinks(projectId, itemId)).outgoing.map((x) => x.targetItemId),
      ).toEqual([null, "first"]);
      await write({
        ...edit,
        expectedSequence: saved.sequence,
        commandId: CommandId.make("choose"),
        content: "[[id:second|Same]] new; original [[id:first|Same]]",
      });
      expect(
        (await system.wikiLinks(projectId, itemId)).outgoing.map((x) => x.targetItemId),
      ).toEqual(["second", "first"]);
    } finally {
      await system.dispose();
    }
  });

  it("replays migration-time ambiguous wiki links at the original project projection cursor", async () => {
    const system = await createOrchestrationSystem();
    const projectId = ProjectId.make("pre-wiki");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("pre-create"),
          projectId,
          title: "Pre-wiki",
          workspaceRoot: "/pre-wiki",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      const write = (id: string, title: string, content: string) =>
        system.run(
          system.engine.dispatch({
            type: "project.knowledge.item.upsert",
            commandId: CommandId.make("pre-" + id + "-" + title),
            projectId,
            itemId: WorkspaceKnowledgeItemId.make(id),
            title,
            content,
            kind: "rag-source",
            status: "active",
            origin: "user",
            tags: [],
            relativeFolder: null,
            createdAt: now(),
          }),
        );
      await write("first", "Same", "");
      await write("source", "Reference", "[[Same]]");
      const boundary = await write("second", "Same", "");
      const { rebuildWorkspaceWikiLinks } = await import("../../persistence/workspaceWikiLinks.ts");
      await system.run(
        system.sql`INSERT INTO workspace_wiki_backfill_cursor VALUES (${boundary.sequence})`,
      );
      await system.run(system.sql`DELETE FROM workspace_wiki_bindings`);
      await system.run(rebuildWorkspaceWikiLinks(system.sql));
      expect((await system.wikiLinks(projectId, "source")).outgoing[0]?.targetItemId).toBeNull();
      await write("first", "Renamed", "");
      await system.run(
        system.sql`DELETE FROM projection_workspace_knowledge_items WHERE project_id=${projectId}`,
      );
      await system.run(
        system.sql`DELETE FROM projection_state WHERE projector='projection.workspace-knowledge-v2'`,
      );
      await system.bootstrap();
      const links = await system.wikiLinks(projectId, "source");
      expect(links.unresolved).toHaveLength(1);
      expect(links.outgoing[0]).toMatchObject({ targetTitle: "Same", targetItemId: null });
      expect((await system.wikiLinks(projectId, "first")).backlinks).toEqual([]);
    } finally {
      await system.dispose();
    }
  });

  it("publishes one stop event when the caller replays a stop after losing its receipt", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("monitor-stop-replay");
    const stop = {
      type: "project.program.stop" as const,
      commandId: CommandId.make("same-stop-id"),
      projectId,
      programId: WorkspaceProgramId.make("monitor-program"),
      createdAt: now(),
    };
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("create-monitor-stop"),
          projectId,
          title: "Monitor stop",
          workspaceRoot: "/tmp/monitor-stop",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      const first = await system.run(system.engine.dispatch(stop));
      const replay = await system.run(system.engine.dispatch(stop));
      expect(replay).toEqual({ sequence: first.sequence, replayed: true });
      const events = await system.run(system.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
        WHERE event_type = 'project.program-stop-requested' AND command_id = ${stop.commandId}
      `);
      expect(events[0]?.count).toBe(1);
    } finally {
      await system.dispose();
    }
  });

  it("preserves an interrupt raised while the engine is publishing a stop", async () => {
    let stopAttempts = 0;
    const store = Layer.effect(
      OrchestrationEventStore,
      Effect.map(Effect.service(OrchestrationEventStore), (live) => ({
        ...live,
        append: (event: Parameters<OrchestrationEventStoreShape["append"]>[0]) => {
          if (event.type !== "project.program-stop-requested") return live.append(event);
          stopAttempts++;
          return Effect.interrupt;
        },
      })),
    ).pipe(Layer.provide(OrchestrationEventStoreLive));
    const system = await createOrchestrationSystem(store);
    try {
      const projectId = asProjectId("monitor-stop-interrupted");
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("create-interrupted-stop"),
          projectId,
          title: "Interrupted stop",
          workspaceRoot: "/tmp/interrupted-stop",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      const exit = await system.run(
        Effect.exit(
          system.engine.dispatch({
            type: "project.program.stop",
            commandId: CommandId.make("stop-interrupted"),
            projectId,
            programId: WorkspaceProgramId.make("monitor-program"),
            createdAt: now(),
          }),
        ),
      );
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(stopAttempts).toBe(1);
    } finally {
      await system.dispose();
    }
  });
  it("atomically rejects stale conversation input and replays accepted answers", async () => {
    const system = await createOrchestrationSystem();
    const { engine, sql } = system;
    const createdAt = now();
    const projectId = asProjectId("project-run-input");
    const runId = WorkspaceCollaborationRunId.make("run-input");
    const question = {
      askedByParticipantId: null,
      question: "어느 쪽인가요?",
      options: ["첫째", "둘째"],
      context: "",
      askedAt: createdAt,
      nodeId: null,
    };
    const meeting = {
      mode: "fixed-rounds",
      phase: "discussing",
      threadId: "run-input-thread",
      participants: [
        {
          id: "supervisor",
          displayName: "Supervisor",
          modelSelection: { instanceId: "codex", model: "test" },
        },
      ],
      chairParticipantId: "supervisor",
      maxRounds: 1,
      userInLoop: true,
      rounds: [],
      pendingQuestion: question,
      answers: [],
      interjections: [],
    };
    const answer = {
      type: "project.collaboration.run.answer" as const,
      commandId: CommandId.make("answer-run-input"),
      projectId,
      runId,
      question: question.question,
      questionRef: { nodeId: null, askedAt: createdAt },
      answer: "둘째",
      createdAt,
    };
    try {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project-run-input-create"),
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/run-input",
          defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          createdAt,
        }),
      );
      await system.run(sql`
        INSERT INTO projection_workspace_collaboration_runs
          (run_id, project_id, source, task, status, steps_json, created_at, updated_at, meeting_json)
        VALUES (${runId}, ${projectId}, 'user', 'task', 'running', '[]', ${createdAt}, ${createdAt}, ${JSON.stringify(meeting)})
      `);
      await expect(
        system.run(
          engine.dispatch({
            ...answer,
            commandId: CommandId.make("wrong-question"),
            question: "다른 질문",
          }),
        ),
      ).rejects.toThrow("질문이 변경됐습니다");
      const accepted = await system.run(engine.dispatch(answer));
      await system.run(
        sql`UPDATE projection_workspace_collaboration_runs SET status='completed' WHERE run_id=${runId}`,
      );
      expect(await system.run(engine.dispatch(answer))).toMatchObject({
        sequence: accepted.sequence,
        replayed: true,
      });
      await expect(
        system.run(
          engine.dispatch({
            type: "project.collaboration.run.interject",
            commandId: CommandId.make("after-run"),
            projectId,
            runId,
            text: "추가 지시",
            createdAt,
          }),
        ),
      ).rejects.toThrow("진행 중인 통합 작업이 없습니다");
      const [row] = await system.run(
        sql<{
          meeting: string;
        }>`SELECT meeting_json AS meeting FROM projection_workspace_collaboration_runs WHERE run_id=${runId}`,
      );
      expect(JSON.parse(row!.meeting).answers).toHaveLength(1);
    } finally {
      await system.dispose();
    }
  });
  it("preserves an accepted unseeded turn during failed bootstrap cleanup and admits ordinary follow-ups", async () => {
    const system = await createOrchestrationSystem();
    try {
      const room = await createBootstrapRoom(system);
      await room.dispatch(room.turn("other-first-send"));
      await expect(room.cleanup("failed-owner-cleanup")).rejects.toThrow("이미 첫 턴");
      await expect(room.dispatch(room.first)).rejects.toThrow("이미 첫 턴");
      await room.dispatch({ ...room.turn("ordinary-follow-up"), initialModelTeams: [] });
      expect(await room.turns()).toHaveLength(2);
      expect(await room.pending()).toEqual([]);
      await room.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("explicit-delete"),
        threadId: room.threadId,
      });
    } finally {
      await system.dispose();
    }
  });

  it("admits only the creation owner's initial team across concurrent first sends and removes the seed on deletion", async () => {
    const system = await createOrchestrationSystem();
    try {
      const room = await createBootstrapRoom(system);
      const other = {
        ...room.turn("foreign-first"),
        requestFingerprint: "b".repeat(64),
        initialModelTeams: [{ ...room.team, forModel: "foreign" }],
      };
      await expect(
        room.dispatch({ ...other, commandId: CommandId.make("missing-owner") }),
      ).rejects.toThrow("확인할 수 없습니다");
      await expect(
        room.dispatch({
          ...other,
          commandId: CommandId.make("borrowed-owner"),
          bootstrapCreateClaim: room.owner,
        }),
      ).rejects.toThrow("다른 요청");
      const [foreign, owner] = await Promise.allSettled([
        room.dispatch({ ...other, bootstrapCreateClaim: bootstrapCreateCommandId(other) }),
        room.dispatch(room.first),
      ]);
      expect(foreign.status).toBe("rejected");
      expect(owner.status).toBe("fulfilled");
      const events = await room.turns();
      expect(events).toHaveLength(1);
      expect(await room.pending()).toEqual([{ event_sequence: events[0]!.sequence }]);
      const replay = await room.dispatch(room.first);
      expect(replay.replayed).toBe(true);
      expect(await room.turns()).toEqual(events);
      await expect(room.cleanup("owner-cleanup-after-accept")).rejects.toThrow("이미 첫 턴");
      const explicitDelete = {
        type: "thread.delete" as const,
        commandId: CommandId.make("delete-seeded-room"),
        threadId: room.threadId,
      };
      await system.run(system.sql`CREATE TRIGGER fail_seed_delete BEFORE DELETE ON pending_thread_model_team_seeds
        BEGIN SELECT RAISE(ABORT,'fixture seed deletion failure'); END`);
      await expect(room.dispatch(explicitDelete)).rejects.toThrow(
        "OrchestrationEngine.discardThreadModelTeamSeed",
      );
      expect(await room.pending()).toEqual([{ event_sequence: events[0]!.sequence }]);
      await system.run(system.sql`DROP TRIGGER fail_seed_delete`);
      await room.dispatch(explicitDelete);
      expect(await room.pending()).toEqual([]);
      expect(await room.dispatch(room.first)).toEqual(replay);
      expect(await room.pending()).toEqual([]);
    } finally {
      await system.dispose();
    }
  });

  it("rolls back the seed and turn together when receipt persistence fails", async () => {
    const system = await createOrchestrationSystem();
    try {
      const room = await createBootstrapRoom(system);
      await system.run(system.sql`CREATE TRIGGER fail_seed_insert BEFORE INSERT ON pending_thread_model_team_seeds
        BEGIN SELECT RAISE(ABORT,'fixture seed insertion failure'); END`);
      await expect(room.dispatch(room.first)).rejects.toThrow(
        "OrchestrationEngine.enqueueThreadModelTeamSeed",
      );
      expect(await room.turns()).toEqual([]);
      await system.run(system.sql`DROP TRIGGER fail_seed_insert`);
      await system.run(system.sql`CREATE TRIGGER fail_seed_receipt BEFORE INSERT ON orchestration_command_receipts
        WHEN NEW.command_id = 'seed-first' AND NEW.status = 'accepted' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END`);
      await expect(room.dispatch(room.first)).rejects.toThrow();
      expect(await room.pending()).toEqual([]);
      expect(await room.turns()).toEqual([]);
      expect(
        await system.run(
          system.engine.checkTurnReceipt!({
            commandId: room.first.commandId,
            threadId: room.threadId,
            requestFingerprint: room.first.requestFingerprint,
          }),
        ),
      ).toEqual({ status: "unconfirmed" });
      await expect(
        room.dispatch({
          ...room.first,
          initialModelTeams: [{ ...room.team, threadId: ThreadId.make("foreign-room") }],
        }),
      ).rejects.toThrow("대화 ID");
      await room.cleanup("cleanup-before-accepted-turn");
    } finally {
      await system.dispose();
    }
  });

  it("does not resume or delete a conversation with an unrelated or deleted bootstrap claim", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const projectId = asProjectId("claim-project");
    const threadId = ThreadId.make("claim-thread");
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };
    const create = (commandId: string) =>
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(commandId),
        threadId,
        projectId,
        title: "Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("claim-project-create"),
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/claim",
          defaultModelSelection: modelSelection,
          createdAt,
        }),
      );
      await system.run(create("claim-new-create"));
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("claim-stale-cleanup"),
            threadId,
            expectedCreationCommandId: CommandId.make("claim-old-create"),
          }),
        ),
      ).rejects.toThrow("확인할 수 없습니다");
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("claim-stale-turn"),
            threadId,
            bootstrapCreateClaim: CommandId.make("claim-old-create"),
            message: {
              messageId: asMessageId("claim-stale-message"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          }),
        ),
      ).rejects.toThrow("확인할 수 없습니다");
      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("claim-bind"),
          threadId,
          bootstrapCreateClaim: CommandId.make("claim-new-create"),
          bootstrapExpectedBranch: null,
          bootstrapExpectedWorktreePath: null,
          branch: "t3/owned",
          worktreePath: "/tmp/owned",
        }),
      );
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("claim-stale-bind"),
            threadId,
            bootstrapCreateClaim: CommandId.make("claim-new-create"),
            bootstrapExpectedBranch: null,
            bootstrapExpectedWorktreePath: null,
            branch: "t3/other",
            worktreePath: "/tmp/other",
          }),
        ),
      ).rejects.toThrow("변경되어");
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("claim-stale-path-turn"),
            threadId,
            bootstrapCreateClaim: CommandId.make("claim-new-create"),
            bootstrapExpectedBranch: null,
            bootstrapExpectedWorktreePath: null,
            message: {
              messageId: asMessageId("claim-stale-path-message"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          }),
        ),
      ).rejects.toThrow("변경되어");
      const snapshot = await system.readModel();
      expect(snapshot.threads.find((thread) => thread.id === threadId)?.messages).toEqual([]);
      expect(snapshot.threads.find((thread) => thread.id === threadId)?.worktreePath).toBe(
        "/tmp/owned",
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("claim-original-delete"),
          threadId,
        }),
      );
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("claim-deleted-turn"),
            threadId,
            bootstrapCreateClaim: CommandId.make("claim-new-create"),
            message: {
              messageId: asMessageId("claim-deleted-message"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          }),
        ),
      ).rejects.toThrow("확인할 수 없습니다");
    } finally {
      await system.dispose();
    }
  });
  it("accepted-retry rejects changed content while allowing the exact retry", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const projectId = asProjectId("receipt-project");
    const threadId = ThreadId.make("receipt-thread");
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("receipt-project-create"),
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/receipt",
          defaultModelSelection: modelSelection,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("receipt-thread-create"),
          threadId,
          projectId,
          title: "Thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      const turn = {
        type: "thread.turn.start" as const,
        commandId: CommandId.make("receipt-turn"),
        threadId,
        message: {
          messageId: asMessageId("receipt-message"),
          role: "user" as const,
          text: "original",
          attachments: [],
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt,
      };
      const accepted = await system.run(system.engine.dispatch(turn));
      const receiptCheck = {
        commandId: turn.commandId,
        threadId,
        requestFingerprint: normalizedTurnRequestDigest(turn),
      };
      expect(await system.run(system.engine.checkTurnReceipt!(receiptCheck))).toEqual({
        status: "accepted",
      });
      expect(
        await system.run(
          system.engine.checkTurnReceipt!({ ...receiptCheck, requestFingerprint: "0".repeat(64) }),
        ),
      ).toEqual({ status: "mismatch" });
      expect(
        await system.run(
          system.engine.checkTurnReceipt!({
            ...receiptCheck,
            threadId: ThreadId.make("other-thread"),
          }),
        ),
      ).toEqual({ status: "mismatch" });
      expect(
        await system.run(
          system.engine.checkTurnReceipt!({
            ...receiptCheck,
            commandId: CommandId.make("unknown"),
          }),
        ),
      ).toEqual({ status: "unconfirmed" });
      expect(await system.run(system.engine.dispatch(turn))).toEqual({
        ...accepted,
        replayed: true,
      });
      await expect(
        system.run(
          system.engine.dispatch({ ...turn, message: { ...turn.message, text: "changed" } }),
        ),
      ).rejects.toThrow("다른 내용");
      await expect(
        system.run(system.engine.dispatch({ ...turn, threadId: ThreadId.make("other-thread") })),
      ).rejects.toThrow("다른 내용");
      await expect(
        system.run(system.engine.dispatch({ ...turn, runtimeMode: "approval-required" })),
      ).rejects.toThrow("다른 내용");
      await expect(
        system.run(
          system.engine.dispatch({ type: "thread.archive", commandId: turn.commandId, threadId }),
        ),
      ).rejects.toThrow("다른 내용");
      expect(await system.run(system.engine.dispatch(turn))).toEqual({
        ...accepted,
        replayed: true,
      });
      expect(
        (await system.readModel()).threads[0]?.messages.filter(
          (message) => message.id === turn.message.messageId,
        ),
      ).toHaveLength(1);
    } finally {
      await system.dispose();
    }
  });
  it("protects only the conversation with an active collaboration from ordinary turns", async () => {
    const system = await createOrchestrationSystem();
    const { engine, sql } = system;
    const createdAt = now();
    const projectId = asProjectId("project-collaboration-lock");
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };
    try {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("lock-project"),
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/collaboration-lock",
          defaultModelSelection: modelSelection,
          createdAt,
        }),
      );
      for (const id of ["locked-thread", "other-thread"]) {
        await system.run(
          engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create-${id}`),
            threadId: ThreadId.make(id),
            projectId,
            title: id,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
      }
      await system.run(sql`
        INSERT INTO projection_workspace_collaboration_runs
          (run_id, project_id, source, task, status, steps_json, created_at, updated_at, meeting_json)
        VALUES ('locked-run', ${projectId}, 'user', 'task', 'queued', '[]', ${createdAt}, ${createdAt},
          '{"threadId":"locked-thread"}')
      `);
      const send = (threadId: string, commandId: string, inputOrigin?: "automation") =>
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId: ThreadId.make(threadId),
          message: {
            messageId: asMessageId(`message-${commandId}`),
            role: "user",
            text: "hello",
            attachments: [],
          },
          ...(inputOrigin ? { inputOrigin } : {}),
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        });
      for (const status of ["queued", "running", "cancel-requested"]) {
        await system.run(
          sql`UPDATE projection_workspace_collaboration_runs SET status = ${status} WHERE run_id = 'locked-run'`,
        );
        await expect(system.run(send("locked-thread", `blocked-${status}`))).rejects.toThrow(
          "이 대화에서 통합 작업이 진행 중입니다",
        );
      }
      await system.run(send("locked-thread", "supervisor-turn", "automation"));
      await system.run(send("other-thread", "independent-turn"));
      await system.run(
        sql`UPDATE projection_workspace_collaboration_runs SET status = 'completed' WHERE run_id = 'locked-run'`,
      );
      await system.run(send("locked-thread", "after-completion"));
    } finally {
      await system.dispose();
    }
  });

  it("bootstraps command handling from persisted projections without reading the full snapshot", async () => {
    let nextSequence = 8;
    const eventStore: OrchestrationEventStoreShape = {
      append: (event) =>
        Effect.sync(() => {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as OrchestrationEvent;
          nextSequence += 1;
          return savedEvent;
        }),
      readFromSequence: () => Stream.empty,
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };
    const commandReadModel = {
      ...projectionSnapshot,
      threads: projectionSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      })),
    };
    let fullSnapshotReadCount = 0;

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(commandReadModel),
          getSnapshot: () =>
            Effect.sync(() => {
              fullSnapshotReadCount += 1;
              return projectionSnapshot;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: projectionSnapshot.snapshotSequence }),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadRuntimeContext: () => Effect.die("unused runtime context"),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    expect(await runtime.runPromise(engine.latestSequence)).toBe(7);
    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-bootstrap-thread-update"),
        threadId: ThreadId.make("thread-bootstrap"),
        title: "Updated Bootstrap Thread",
      }),
    );

    expect(result.sequence).toBe(8);
    expect(await runtime.runPromise(engine.latestSequence)).toBe(8);
    expect(fullSnapshotReadCount).toBe(0);

    await runtime.dispose();
  });

  it("persists deterministic read models for repeated snapshot reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-1-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.readModel();
    const readModelB = await system.readModel();
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("archives and unarchives threads through orchestration commands", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-create"),
        projectId: asProjectId("project-archive"),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-create"),
        threadId: ThreadId.make("thread-archive"),
        projectId: asProjectId("project-archive"),
        title: "Archive me",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-archive-title-regeneration"),
        threadId: ThreadId.make("thread-archive"),
        regenerateTitle: true,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).not.toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();
    await system.run(
      engine.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("cmd-thread-archive-stale-title-completion"),
        threadId: ThreadId.make("thread-archive"),
        requestId: CommandId.make("cmd-thread-archive-title-regeneration"),
        title: "Stale generated title",
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")?.title,
    ).toBe("Archive me");

    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-replay-create"),
        threadId: ThreadId.make("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-replay-delete"),
        threadId: ThreadId.make("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-stream-thread-create"),
          threadId: ThreadId.make("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stream-thread-update"),
          threadId: ThreadId.make("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("does not regress a generated branch to a stale temporary worktree branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-branch-race-project-create"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Project",
        workspaceRoot: "/tmp/project-branch-race",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-branch-race-thread-create"),
        threadId: ThreadId.make("thread-branch-race"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "t3code/generated-branch-name",
        worktreePath: "/tmp/project-branch-race-worktree",
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-stale-temporary-branch-sync"),
        threadId: ThreadId.make("thread-branch-race"),
        branch: "t3code/1234abcd",
        expectedBranch: "t3code/1234abcd",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/generated-branch-name");
    await system.dispose();
  });

  it("allows authoritative worktree bootstrap to assign a temporary branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-project-create"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Project",
        workspaceRoot: "/tmp/project-worktree-bootstrap",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-thread-create"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "main",
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-authoritative-worktree-bootstrap"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/project-worktree-bootstrap-worktree",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/1234abcd");
    expect(snapshot.threads[0]?.worktreePath).toBe("/tmp/project-worktree-bootstrap-worktree");
    await system.dispose();
  });

  it("records command ack duration using the first committed event type", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ack-create"),
        projectId: asProjectId("project-ack"),
        title: "Ack Project",
        workspaceRoot: "/tmp/project-ack",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ack-create"),
        threadId: ThreadId.make("thread-ack"),
        projectId: asProjectId("project-ack"),
        title: "Ack Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_command_ack_duration", {
        commandType: "thread.create",
        aggregateKind: "thread",
        ackEventType: "thread.created",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("records failed command dispatches as metric failures", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-missing-project"),
          threadId: ThreadId.make("thread-missing-project"),
          projectId: asProjectId("project-missing"),
          title: "Missing Project Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("does not exist");

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_commands_total", {
        commandType: "thread.create",
        aggregateKind: "thread",
        outcome: "failure",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-turn-diff-create"),
        threadId: ThreadId.make("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-complete"),
        threadId: ThreadId.make("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.readModel()).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-engine-test-",
    });

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-flaky-1"),
          threadId: ThreadId.make("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-flaky-2"),
        threadId: ThreadId.make("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.make("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-atomic-create"),
        threadId: ThreadId.make("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-start-atomic"),
      threadId: ThreadId.make("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failed",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("reconciles command state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make("cmd-thread-archive-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-sync-create"),
        threadId: ThreadId.make("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-fail"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("projection failed");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-retry"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("already archived");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-invariant-missing-thread"),
          threadId: ThreadId.make("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-duplicate-1"),
        threadId: ThreadId.make("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-duplicate-2"),
          threadId: ThreadId.make("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });
});
