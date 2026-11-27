// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics preferSchemaOverJson:off
import * as Http from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
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
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { startWatchdogMcpRelay } from "./WatchdogMcpRelay.ts";
import {
  WATCHDOG_OFFLINE_MEMORY_FILE,
  WATCHDOG_OFFLINE_TOOL_MESSAGE,
  makeWatchdogOfflineTools,
} from "./WatchdogOfflineTools.ts";

const projectId = ProjectId.make("offline-project");
const threadId = ThreadId.make("offline-thread");
const createdAt = "2026-11-01T00:00:00.000Z";
const auth = "Bearer relay-test";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function seedState(home: string) {
  const dbPath = NodePath.join(home, "userdata", "state.sqlite");
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The fixture database is built once and then closed before the relay opens it read-only.
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
      Layer.provide(ServerConfig.layerTest(home, home)),
      Layer.provide(NodeServices.layer),
    ),
  );
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const dispatch = (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command));
  await dispatch({
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId,
    title: "Offline",
    workspaceRoot: home,
    defaultModelSelection: null,
    createdAt,
  });
  await dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-thread"),
    threadId,
    projectId,
    title: "Offline",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-4-5",
    },
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  await dispatch({
    type: "project.knowledge.item.upsert",
    commandId: CommandId.make("add-note"),
    itemId: WorkspaceKnowledgeItemId.make("quasar-note"),
    projectId,
    title: "Relay test",
    content: "quasar offline memory",
    origin: "user",
    status: "active",
    scope: "project",
    kind: "rag-source",
    relativeFolder: null,
    tags: [],
    createdAt,
  });
  await runtime.dispose();
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.prepare(
    "INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES(?,?,?,?,0,?,?)",
  ).run("m-user", threadId, "user", "hello", createdAt, createdAt);
  db.prepare(
    "INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder) VALUES(?,?,?,'')",
  ).run("m-user", projectId, threadId);
  db.close();
  return dbPath;
}

function fakeCli(home: string) {
  const script = NodePath.join(home, "fake-claude.mjs");
  const argsFile = NodePath.join(home, "fake-claude-args.json");
  NodeFS.writeFileSync(
    script,
    `import * as fs from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "scout says: " + (input.includes("find quasar") ? "found" : "missing") }));
`,
  );
  if (process.platform === "win32") {
    const shim = NodePath.join(home, "fake-claude.cmd");
    // %~dp0 keeps a non-ASCII temp path out of the batch file's code page.
    NodeFS.writeFileSync(shim, `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);
    return { binary: shim, argsFile };
  }
  const shim = NodePath.join(home, "fake-claude");
  NodeFS.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
    mode: 0o755,
  });
  return { binary: shim, argsFile };
}

const toolsList = {
  tools: ["workspace_memory", "workspace_delegate", "workspace_research"].map((name) => ({
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
  })),
};

/** A minimal MCP backend that can be stopped and restarted on the same port. */
function fakeUpstream() {
  const sessions = new Set<string>();
  const calls: string[] = [];
  let dropCalls = false;
  let server: Http.Server | undefined;
  let port = 0;
  let counter = 0;
  const handler: Http.RequestListener = (request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const message = JSON.parse(raw || "{}");
      const session = request.headers["mcp-session-id"];
      if (message.method === "initialize") {
        const id = `upstream-${++counter}`;
        sessions.add(id);
        response
          .writeHead(200, {
            "content-type": "text/event-stream",
            "mcp-session-id": id,
            "mcp-protocol-version": "2025-06-18",
          })
          .end(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "T3 Code", version: "test" } } })}\n\n`,
          );
        return;
      }
      if (typeof session !== "string" || !sessions.has(session)) {
        response.writeHead(404).end();
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "tools/call") {
        calls.push(message.params.name);
        if (dropCalls) {
          request.socket.destroy();
          return;
        }
      }
      const result =
        message.method === "tools/list"
          ? toolsList
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: `online ${message.params.name}` }] }
            : {};
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  };
  return {
    calls,
    setDropCalls: (value: boolean) => (dropCalls = value),
    get endpoint() {
      return `http://127.0.0.1:${port}/mcp`;
    },
    start: () =>
      new Promise<void>((resolve) => {
        sessions.clear();
        server = Http.createServer(handler);
        server.listen(port, "127.0.0.1", () => {
          port = (server!.address() as { port: number }).port;
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server!.closeAllConnections();
        server!.close(() => resolve());
      }),
  };
}

function client(endpoint: string) {
  let session: string | undefined;
  let next = 0;
  const post = async (message: Record<string, unknown>) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: auth,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    });
    return response;
  };
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await post({ id: ++next, method, params });
    const text = await response.text();
    const json = text.startsWith("event:")
      ? JSON.parse(
          text
            .split("\n")
            .find((line) => line.startsWith("data:"))!
            .slice(5),
        )
      : JSON.parse(text);
    return { status: response.status, json };
  };
  return {
    async initialize() {
      const response = await post({
        id: ++next,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
      expect(response.status).toBe(200);
      session = response.headers.get("mcp-session-id")!;
      await response.text();
      await post({ method: "notifications/initialized" });
    },
    rpc,
    call: async (name: string, args: unknown) =>
      (await rpc("tools/call", { name, arguments: args })).json.result,
    post,
  };
}

it(
  "serves memory and delegation while T3 is off, and returns to the backend when it is back",
  { timeout: 60_000 },
  async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "watchdog-relay-test-"));
    cleanup.push(() => NodeFS.rmSync(home, { recursive: true, force: true }));
    const dbPath = await seedState(home);
    const cli = fakeCli(home);
    const settingsPath = NodePath.join(home, "settings.json");
    NodeFS.writeFileSync(
      settingsPath,
      JSON.stringify({
        providerInstances: {
          claudeAgent: { driver: "claudeAgent", config: { binaryPath: cli.binary } },
        },
        globalSubordinateTeam: [
          { instanceId: "claudeAgent", model: "claude-haiku-4-5", role: "scout" },
        ],
      }),
    );
    const stateDir = NodePath.join(home, "userdata");
    const upstream = fakeUpstream();
    await upstream.start();
    let fallbackCalls = 0;
    const offline = makeWatchdogOfflineTools({
      dbPath,
      settingsPath,
      stateDir,
      ownerThreadId: threadId,
      cwd: home,
      providerInstanceId: "claudeAgent",
      model: "claude-opus-4-5",
      runtimeMode: "full-access",
      interactionMode: "default",
      nested: false,
      delegateTimeoutMs: 30_000,
    });
    const relay = await startWatchdogMcpRelay({
      endpoint: upstream.endpoint,
      authorizationHeader: auth,
      fallback: {
        tools: offline.tools,
        call: (name, args, signal) => {
          fallbackCalls++;
          return offline.call(name, args, signal);
        },
      },
      reconnectWindowMs: 600,
      fallbackGraceMs: 200,
    });
    cleanup.push(() => relay.close());
    const model = client(relay.endpoint);
    await model.initialize();
    expect((await model.rpc("tools/list")).json.result).toEqual(toolsList);
    await expect(relay.ready).resolves.toBe(true);
    expect(await model.call("workspace_research", {})).toEqual({
      content: [{ type: "text", text: "online workspace_research" }],
    });

    await upstream.stop();
    expect((await model.rpc("tools/list")).json.result).toEqual(toolsList);
    const search = await model.call("workspace_memory", { action: "search", query: "quasar" });
    expect(search.isError).toBeUndefined();
    const found = JSON.parse(JSON.parse(search.content[0].text));
    expect(found.matches.map((match: { id: string }) => match.id)).toContain("quasar-note");
    const remember = await model.call("workspace_memory", {
      action: "remember",
      requestId: "r1",
      topic: "t",
      text: "remember me",
    });
    expect(JSON.parse(JSON.parse(remember.content[0].text)).queued).toBe(true);
    await model.call("workspace_memory", {
      action: "remember",
      requestId: "r1",
      topic: "t",
      text: "remember me",
    });
    const queued = NodeFS.readFileSync(
      NodePath.join(stateDir, WATCHDOG_OFFLINE_MEMORY_FILE),
      "utf8",
    )
      .trim()
      .split("\n");
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0]!)).toMatchObject({
      kind: "workspace_memory.remember",
      projectId,
      threadId,
      requestId: "r1",
      text: "remember me",
      folder: "",
    });
    const forget = await model.call("workspace_memory", { action: "forget", id: "x" });
    expect(forget).toEqual({
      isError: true,
      content: [{ type: "text", text: WATCHDOG_OFFLINE_TOOL_MESSAGE }],
    });
    const research = await model.call("workspace_research", {});
    expect(research).toEqual({
      isError: true,
      content: [{ type: "text", text: WATCHDOG_OFFLINE_TOOL_MESSAGE }],
    });
    const status = await model.call("workspace_delegate", { action: "status" });
    expect(status.structuredContent.subordinates).toEqual([
      {
        role: "scout",
        account: "claudeAgent",
        instanceId: "claudeAgent",
        model: "claude-haiku-4-5",
      },
    ]);
    const run = await model.call("workspace_delegate", {
      action: "run",
      to: "scout",
      task: "find quasar",
    });
    expect(run.isError, run.content?.[0]?.text).toBeUndefined();
    expect(run.structuredContent).toMatchObject({ status: "completed", text: "scout says: found" });
    const recorded = JSON.parse(NodeFS.readFileSync(cli.argsFile, "utf8"));
    expect(recorded.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "claude-haiku-4-5",
      "--dangerously-skip-permissions",
    ]);
    expect(NodeFS.realpathSync(recorded.cwd)).toBe(NodeFS.realpathSync(home));

    const late = client(relay.endpoint);
    await late.initialize();
    expect((await late.rpc("tools/list")).json.result).toEqual(toolsList);
    expect(upstream.calls).toEqual(["workspace_research"]);

    await upstream.start();
    expect(await late.call("workspace_research", {})).toEqual({
      content: [{ type: "text", text: "online workspace_research" }],
    });
    expect(await model.call("workspace_memory", { action: "status" })).toEqual({
      content: [{ type: "text", text: "online workspace_memory" }],
    });
    const before = fallbackCalls;
    upstream.setDropCalls(true);
    const ambiguous = await model.post({
      id: 99,
      method: "tools/call",
      params: { name: "workspace_memory", arguments: { action: "search", query: "quasar" } },
    });
    expect(ambiguous.status).toBe(502);
    expect(fallbackCalls).toBe(before);
    expect(upstream.calls.filter((name) => name === "workspace_memory")).toHaveLength(2);
    await upstream.stop();
  },
);
