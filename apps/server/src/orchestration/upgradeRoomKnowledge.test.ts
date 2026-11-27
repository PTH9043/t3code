// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkspaceKnowledgeItemId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, expect, it } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import {
  installUpgradeRoomKnowledge,
  upgradeRoomKnowledgeNotifyFile,
} from "./upgradeRoomKnowledge.ts";

const roomId = ProjectId.make("autousage-upgrade-project");
const threadId = ThreadId.make("autousage-upgrade-room");
const primaryId = ProjectId.make("canonical");
const nested = ProjectId.make("unrelated");
const createdAt = "2026-11-01T00:00:00.000Z";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

function layout() {
  const home = NodeFS.mkdtempSync(NodePath.join(import.meta.dirname, "upgradeRoomKnowledge-test-"));
  cleanup.push(() => NodeFS.rmSync(home, { recursive: true, force: true }));
  const root = NodePath.join(home, "__NewAutoUsage");
  NodeFS.mkdirSync(root);
  const env = { T3CODE_UPGRADE_PROJECT_ROOT: root, T3CODE_UPGRADE_PRIMARY_HOME: home };
  const mainPath = NodePath.join(home, "userdata", "state.sqlite");
  const roomPath = NodePath.join(home, "upgrade-room", "userdata", "state.sqlite");
  const room = () =>
    installUpgradeRoomKnowledge({
      role: "room",
      dbPath: roomPath,
      projectId: roomId,
      threadId,
      env,
    })!;
  return { home, root, env, mainPath, roomPath, room };
}

async function server(dbPath: string, root: string) {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This test stops and restarts two independent SQLite-backed engines mid-scenario.
  const runtime = ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(makeSqlitePersistenceLive(dbPath)),
      Layer.provide(ServerConfig.layerTest(root, NodePath.dirname(NodePath.dirname(dbPath)))),
      Layer.provide(NodeServices.layer),
    ),
  );
  cleanup.push(() => runtime.dispose());
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const dispatch = (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command));
  return {
    dispatch,
    stop: () => runtime.dispose(),
    async project(id: ProjectId, workspaceRoot: string) {
      await dispatch({
        type: "project.create",
        commandId: CommandId.make("create-" + id),
        projectId: id,
        title: "__NewAutoUsage",
        workspaceRoot,
        defaultModelSelection: null,
        createdAt,
      });
    },
    async note(
      projectId: ProjectId,
      key: string,
      content: string,
      status: "active" | "candidate" | "archived" = "active",
    ) {
      await dispatch({
        type: "project.knowledge.item.upsert",
        commandId: CommandId.make("add-" + key),
        itemId: WorkspaceKnowledgeItemId.make(key),
        projectId,
        title: "Upgrade test",
        content,
        origin: "user",
        status,
        scope: "project",
        kind: "rag-source",
        relativeFolder: null,
        tags: [],
        createdAt,
      });
    },
  };
}

async function createRoom(dbPath: string, root: string) {
  const room = await server(dbPath, root);
  await room.project(roomId, root);
  await room.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-room"),
    threadId,
    projectId: roomId,
    title: "Upgrade",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake" },
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  return room;
}

it("retrieves offline model context, survives independent restarts and a lost dispatch receipt, and honors both archives", async () => {
  const f = layout();
  const first = await server(f.mainPath, f.root);
  await first.project(primaryId, NodePath.join(f.root, ".") + NodePath.sep);
  await first.project(nested, NodePath.join(f.root, "__XPeed"));
  await first.note(primaryId, "existing", "quasar canonical memory");
  await first.note(nested, "stranger", "quasar unrelated nested project");
  await first.note(primaryId, "draft", "quasar unapproved candidate", "candidate");
  await first.note(primaryId, "old", "quasar archived memory", "archived");
  await first.stop();
  const worker = await createRoom(f.roomPath, f.root);
  await worker.note(roomId, "finding", "quasar finding from the room");
  await worker.note(roomId, "later", "quasar room withdrawal");
  const bridge = f.room();
  expect(bridge.capture()).toBe(2);
  const fakeModel = (prompt: string) =>
    prompt.includes("quasar canonical memory") && prompt.includes("quasar finding from the room");
  const prompt = bridge.context("quasar");
  expect(fakeModel(prompt)).toBe(true);
  expect(prompt).not.toMatch(/nested project|unapproved candidate|archived memory/);
  expect(f.room().capture()).toBe(0);
  await worker.stop();
  const restored = await server(f.mainPath, f.root);
  const retry = installUpgradeRoomKnowledge({
    role: "primary",
    env: f.env,
    dbPath: f.mainPath,
    dispatchAuthorized: async (command) => {
      await restored.dispatch(command);
      throw new Error("lost reply");
    },
  })!;
  await expect(retry.reconcile()).rejects.toThrow("lost reply");
  const primary = installUpgradeRoomKnowledge({
    role: "primary",
    env: f.env,
    dbPath: f.mainPath,
    dispatchAuthorized: restored.dispatch,
  })!;
  await primary.reconcile();
  expect(await primary.reconcile()).toBe(0);
  const db = new NodeSqlite.DatabaseSync(f.mainPath, { readOnly: true });
  cleanup.push(() => db.close());
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM orchestration_events WHERE command_id LIKE 'capture-upgrade-room-%'",
      )
      .get()?.n,
  ).toBe(2);
  const doc = db
    .prepare(
      "SELECT project_id,item_id FROM projection_workspace_knowledge_items WHERE content='quasar finding from the room'",
    )
    .get()!;
  expect(doc.project_id).toBe(primaryId);
  const indexedLookup = (sql: string, ...args: string[]) =>
    db
      .prepare("EXPLAIN QUERY PLAN " + sql)
      .all(...args)
      .map((row) => row.detail)
      .join(" ");
  expect(
    indexedLookup(
      "SELECT status FROM projection_workspace_knowledge_items WHERE project_id=? AND item_id=?",
      primaryId,
      String(doc.item_id),
    ),
  ).toMatch(/SEARCH .*INDEX/i);
  expect(
    indexedLookup(
      "SELECT 1 FROM orchestration_events WHERE command_id=?",
      "capture-" + doc.item_id,
    ),
  ).toContain("idx_orch_events_command_id");
  await restored.dispatch({
    type: "project.knowledge.item.archive",
    commandId: CommandId.make("user-archive"),
    projectId: primaryId,
    itemId: WorkspaceKnowledgeItemId.make(String(doc.item_id)),
    createdAt,
  });
  expect(f.room().context("quasar")).not.toContain("quasar finding from the room");
  const original = db
    .prepare(
      "SELECT item_id FROM projection_workspace_knowledge_items WHERE content='quasar room withdrawal'",
    )
    .get()!;
  await restored.dispatch({
    type: "project.knowledge.item.upsert",
    projectId: primaryId,
    itemId: WorkspaceKnowledgeItemId.make("derived"),
    sourceItemId: WorkspaceKnowledgeItemId.make(String(original.item_id)),
    commandId: CommandId.make("derived"),
    title: "Derived note",
    content: "quasar derived alias",
    kind: "rag-source",
    status: "active",
    origin: "user",
    tags: [],
    relativeFolder: null,
    createdAt,
  });
  expect(f.room().context("quasar")).toContain("quasar derived alias");
  const restartedRoom = await server(f.roomPath, f.root);
  await restartedRoom.dispatch({
    type: "project.knowledge.item.upsert",
    commandId: CommandId.make("new-room-alias"),
    projectId: roomId,
    itemId: WorkspaceKnowledgeItemId.make("duplicate"),
    sourceItemId: WorkspaceKnowledgeItemId.make("finding"),
    title: "alias",
    content: "quasar hidden room alias",
    kind: "rag-source",
    status: "active",
    origin: "user",
    tags: [],
    relativeFolder: null,
    createdAt,
  });
  expect(f.room().context("quasar")).not.toContain("hidden room alias");
  await restartedRoom.dispatch({
    type: "project.knowledge.item.archive",
    commandId: CommandId.make("room-archive"),
    projectId: roomId,
    itemId: WorkspaceKnowledgeItemId.make("later"),
    createdAt,
  });
  expect(f.room().context("quasar")).not.toContain("quasar room withdrawal");
  expect(f.room().context("quasar")).not.toContain("quasar derived alias");
  f.room().capture();
  expect(await primary.reconcile()).toBe(1);
  expect(
    db
      .prepare(
        "SELECT 1 FROM projection_workspace_knowledge_items WHERE content='quasar hidden room alias'",
      )
      .get(),
  ).toBeUndefined();
  expect(
    db
      .prepare(
        "SELECT status FROM projection_workspace_knowledge_items WHERE content='quasar room withdrawal'",
      )
      .get()?.status,
  ).toBe("archived");
});

it("withdraws delivered room captures on thread deletion and never retargets old captures to a replacement project", async () => {
  const f = layout();
  const main = await server(f.mainPath, f.root);
  await main.project(primaryId, f.root);
  const worker = await createRoom(f.roomPath, f.root);
  await worker.note(roomId, "old", "quasar original");
  f.room().capture();
  const primary = installUpgradeRoomKnowledge({
    role: "primary",
    env: f.env,
    dbPath: f.mainPath,
    dispatchAuthorized: main.dispatch,
  })!;
  expect(await primary.reconcile()).toBe(1);
  await worker.dispatch({
    type: "thread.delete",
    commandId: CommandId.make("remove-room"),
    threadId,
  });
  expect(f.room().capture()).toBe(0);
  expect(await primary.reconcile()).toBe(1);
  await main.dispatch({
    type: "project.delete",
    commandId: CommandId.make("remove-project"),
    projectId: primaryId,
    force: true,
  });
  await main.project(ProjectId.make("replacement"), f.root);
  expect(await primary.reconcile()).toBe(0);
  const db = new NodeSqlite.DatabaseSync(f.mainPath, { readOnly: true });
  try {
    expect(
      db
        .prepare("SELECT status FROM projection_workspace_knowledge_items WHERE project_id=?")
        .get(primaryId)?.status,
    ).toBe("archived");
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM projection_workspace_knowledge_items WHERE project_id='replacement'",
        )
        .get()?.n,
    ).toBe(0);
  } finally {
    db.close();
  }
});

it("fails closed on ambiguous roots, wrong server path, wrong room or partially configured launchers", async () => {
  const f = layout();
  const first = await server(f.mainPath, f.root);
  await first.project(primaryId, f.root);
  await createRoom(f.roomPath, f.root);
  const room = {
    role: "room" as const,
    dbPath: f.roomPath,
    projectId: roomId,
    threadId,
    env: f.env,
  };
  expect(installUpgradeRoomKnowledge({ ...room, env: {} })).toBeUndefined();
  expect(() =>
    installUpgradeRoomKnowledge({ ...room, env: { T3CODE_UPGRADE_PRIMARY_HOME: f.home } }),
  ).toThrow();
  expect(() => installUpgradeRoomKnowledge({ ...room, dbPath: f.mainPath })).toThrow();
  expect(() => installUpgradeRoomKnowledge({ ...room, threadId: "ordinary" })).toThrow();
  await first.project(nested, NodePath.join(f.root, "nested"));
  await first.stop();
  // Legacy/corrupt state predating the engine's active-root uniqueness invariant.
  const legacy = new NodeSqlite.DatabaseSync(f.mainPath);
  try {
    legacy
      .prepare("UPDATE projection_projects SET workspace_root=? WHERE project_id=?")
      .run(f.root + NodePath.sep, nested);
  } finally {
    legacy.close();
  }
  expect(() => f.room().context("quasar")).toThrow("exactly one");
  expect(() => f.room().capture()).toThrow("exactly one");
});

it("reads a versioned long-memory passage offline and retains research topic restrictions across delivery", async () => {
  const f = layout();
  const main = await server(f.mainPath, f.root);
  await main.project(primaryId, f.root);
  const history = ThreadId.make("history");
  await main.dispatch({
    type: "thread.create",
    commandId: CommandId.make("history"),
    projectId: primaryId,
    threadId: history,
    title: "history",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  const message = MessageId.make("long");
  const body = "first ".repeat(1500) + "zirconium excerpt";
  await main.dispatch({
    type: "thread.message.user.append",
    commandId: CommandId.make("append-long"),
    threadId: history,
    messageId: message,
    text: body,
    createdAt,
  });
  await main.stop();
  const db = new NodeSqlite.DatabaseSync(f.mainPath);
  try {
    db.prepare("INSERT INTO workspace_memory_v2 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "m",
      primaryId,
      "project",
      "history",
      "first",
      JSON.stringify({ kind: "message", id: message, threadId: history }),
      "h",
      "user",
      "user-statement",
      "consolidated",
      createdAt,
      createdAt,
    );
    db.prepare("INSERT INTO workspace_memory_v2_message_folders VALUES(?,?,?,?)").run(
      message,
      primaryId,
      history,
      "",
    );
    db.prepare("INSERT INTO workspace_memory_v2_chunk_state VALUES(?,?,?,?,?)").run(
      "m",
      primaryId,
      "message",
      message,
      createdAt + ":" + body.length,
    );
    db.prepare(
      "INSERT INTO workspace_memory_v2_chunks(memory_id,project_id,chunk_text,content) VALUES(?,?,?,?)",
    ).run("m", primaryId, "zirconium excerpt", "zirconium excerpt");
  } finally {
    db.close();
  }
  const worker = await createRoom(f.roomPath, f.root);
  expect(
    f
      .room()
      .search("zirconium")
      .find((hit) => hit.source === "message")?.excerpt,
  ).toBe("zirconium excerpt");
  await worker.dispatch({
    type: "project.knowledge.item.upsert",
    commandId: CommandId.make("scoped"),
    projectId: roomId,
    itemId: WorkspaceKnowledgeItemId.make("research"),
    title: "deployment",
    content: "molybdenum",
    kind: "rag-source",
    origin: "imported",
    status: "active",
    relativeFolder: null,
    tags: [],
    createdAt,
    research: {
      query: "deployment",
      sources: [],
      capturedAt: createdAt,
      verification: "verified",
      contextTopics: ["deployment"],
    },
  });
  f.room().capture();
  expect(f.room().context("molybdenum")).toBe("");
  expect(f.room().search("molybdenum")).toHaveLength(1);
  const restored = await server(f.mainPath, f.root);
  await installUpgradeRoomKnowledge({
    role: "primary",
    env: f.env,
    dbPath: f.mainPath,
    dispatchAuthorized: restored.dispatch,
  })!.reconcile();
  expect(f.room().context("molybdenum")).toBe("");
  expect(f.room().context("deployment molybdenum")).toContain("molybdenum");
});

it("captures normal user projection and final model output, rechecks forgotten sources before dispatch and retries authorization", async () => {
  const f = layout();
  const serverMain = await server(f.mainPath, f.root);
  await serverMain.project(primaryId, f.root);
  const worker = await createRoom(f.roomPath, f.root);
  const user = MessageId.make("room-user");
  const common = { threadId, createdAt };
  await worker.dispatch({
    ...common,
    type: "thread.message.user.append",
    commandId: CommandId.make("append"),
    messageId: user,
    text: "cobalt withdrawn user input",
  });
  const turn = { ...common, messageId: MessageId.make("answer"), turnId: TurnId.make("turn") };
  await worker.dispatch({
    ...turn,
    type: "thread.message.assistant.delta",
    commandId: CommandId.make("write"),
    delta: "cobalt completed output token: safe",
  });
  expect(f.room().capture()).toBe(1);
  expect(f.room().context("cobalt")).not.toContain("completed output");
  await worker.dispatch({
    ...turn,
    type: "thread.message.assistant.complete",
    commandId: CommandId.make("done"),
  });
  expect(f.room().capture()).toBe(1);
  await worker.stop();
  const seed = new NodeSqlite.DatabaseSync(f.roomPath);
  try {
    const put = seed.prepare(`INSERT INTO workspace_memory_v2
      (id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    put.run(
      "forgotten",
      roomId,
      "project",
      "forgotten",
      "cobalt withdrawn user input",
      JSON.stringify({ kind: "message", id: user }),
      "h",
      "user",
      "user-statement",
      "forgotten",
      createdAt,
      createdAt,
    );
    put.run(
      "remember",
      roomId,
      "project",
      "cobalt explicit note",
      "cobalt keep this",
      JSON.stringify({ kind: "manual", id: "saved", projectId: roomId, folder: "" }),
      "h",
      "assistant",
      "unverified-report",
      "observed",
      createdAt,
      createdAt,
    );
    put.run(
      "other-folder",
      roomId,
      "project",
      "cobalt other folder",
      "private",
      JSON.stringify({ kind: "manual", id: "private", projectId: roomId, folder: "__XPeed" }),
      "h",
      "user",
      "user-requested-note",
      "consolidated",
      createdAt,
      createdAt,
    );
  } finally {
    seed.close();
  }
  const context = f.room().context("cobalt");
  f.room().capture();
  expect(context).toMatch(/cobalt keep this/);
  expect(context).toMatch(/cobalt completed output/);
  expect(context).not.toMatch(/withdrawn user input|other folder/);
  const opts = { role: "primary" as const, env: f.env, dbPath: f.mainPath };
  await expect(
    installUpgradeRoomKnowledge({
      ...opts,
      dispatchAuthorized: async () => {
        throw new Error("access denied");
      },
    })!.reconcile(),
  ).rejects.toThrow("access denied");
  const primary = installUpgradeRoomKnowledge({
    ...opts,
    dispatchAuthorized: serverMain.dispatch,
  })!;
  const [first, concurrent] = await Promise.all([primary.reconcile(), primary.reconcile()]);
  expect([first, concurrent]).toEqual([2, 2]);
  expect(await primary.reconcile()).toBe(0);
  const db = new NodeSqlite.DatabaseSync(f.mainPath, { readOnly: true });
  try {
    expect(
      db
        .prepare(
          "SELECT content FROM projection_workspace_knowledge_items WHERE project_id=? ORDER BY content",
        )
        .all(primaryId)
        .map((row) => row.content),
    ).toEqual(["cobalt completed output token: safe", "cobalt keep this"]);
  } finally {
    db.close();
  }
});

it("wakes on a committed capture, drains missed notifications on restart and bounds each primary batch", async () => {
  const f = layout();
  const main = await server(f.mainPath, f.root);
  await main.project(primaryId, f.root);
  const worker = await createRoom(f.roomPath, f.root);
  const received = Promise.withResolvers<void>();
  const primary = installUpgradeRoomKnowledge({
    role: "primary",
    env: f.env,
    dbPath: f.mainPath,
    dispatchAuthorized: async (command) => {
      const result = await main.dispatch(command);
      received.resolve();
      return result;
    },
  })!;
  const dispose = primary.watch(received.reject);
  cleanup.push(dispose);
  await worker.note(roomId, "first", "marker delivery");
  expect(f.room().capture()).toBe(1);
  expect(
    NodeFS.existsSync(NodePath.join(f.home, "upgrade-room", upgradeRoomKnowledgeNotifyFile)),
  ).toBe(true);
  await received.promise;
  await dispose();
  for (let i = 0; i < 17; i++) await worker.note(roomId, "batch-" + i, "queued " + i);
  expect(f.room().capture()).toBe(17);
  const marker = NodePath.join(f.home, "upgrade-room", upgradeRoomKnowledgeNotifyFile);
  NodeFS.rmSync(marker);
  expect(await primary.reconcile()).toBe(16);
  expect(await primary.reconcile()).toBe(1);
  const db = new NodeSqlite.DatabaseSync(
    NodePath.join(f.home, "upgrade-room", "knowledge-outbox.sqlite"),
  );
  try {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM captures INDEXED BY captures_queue
      WHERE target=? AND (state='pending' OR (state='delivered' AND visible=0)) ORDER BY rowid LIMIT 16`)
      .all(primaryId);
    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "SEARCH captures USING INDEX captures_queue",
    );
    expect(plan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE");
    // A held writer never blocks the primary for SQLite's usual busy timeout.
    db.exec("BEGIN EXCLUSIVE");
    await expect(primary.reconcile()).rejects.toThrow(/locked|busy/);
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
  await worker.note(roomId, "alias", "another note");
  NodeFS.linkSync(f.mainPath, marker);
  expect(() => f.room().capture()).toThrow(/link/);
});
