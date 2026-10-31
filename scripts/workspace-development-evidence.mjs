import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";

const home = NodePath.resolve(process.argv[2]);
const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata/state.sqlite"), {
  readOnly: true,
});
const state = JSON.parse(
  db
    .prepare("SELECT state_json FROM workspace_development_state WHERE project_id=?")
    .get("persistent-development-demo").state_json,
);
const inventory = state.workspaces.find((workspace) => workspace.name === "Inventory");
const combat = state.workspaces.find((workspace) => workspace.name === "Combat");
const codex = state.bindings.find((binding) => binding.id === inventory.bindingId);
const claude = state.bindings.find((binding) => binding.id === combat.bindingId);
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    NodePath.join(process.env.APPDATA, "npm/node_modules/@openai/codex/bin/codex.js"),
    "app-server",
    "--listen",
    "stdio://",
  ],
  { cwd: inventory.worktreePath, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
const requests = new Map();
let nextId = 0;
child.once("exit", (code) => {
  for (const pending of requests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`Read-only app-server exited ${code}`));
  }
  requests.clear();
});
child.stderr.on("data", () => {});
const reader = NodeReadline.createInterface({ input: child.stdout });
reader.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const pending = requests.get(message.id);
  if (!pending) return;
  requests.delete(message.id);
  clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
  else pending.resolve(message.result);
});
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    requests.set(id, {
      resolve,
      reject,
      timer: setTimeout(() => reject(new Error(`${method} timed out`)), 30_000),
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
try {
  await rpc("initialize", {
    clientInfo: {
      name: "t3_workspace_readonly_evidence",
      title: "Read-only workspace verification",
      version: "1",
    },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  // thread/read does not resume or load the thread, and never starts an independent writer.
  const { thread } = await rpc("thread/read", {
    threadId: codex.nativeSessionId,
    includeTurns: true,
  });
  NodeAssert.equal(thread.id, codex.nativeSessionId);
  NodeAssert.equal(NodePath.resolve(thread.cwd), NodePath.resolve(inventory.worktreePath));
  const items = thread.turns.flatMap((turn) =>
    turn.items.map((item) => ({ turnId: turn.id, ...item })),
  );
  const codexInputs = items.filter((item) => item.type === "userMessage");
  const codexEvidence = state.tasks
    .filter((task) => task.workspaceId === inventory.id)
    .map((task) => {
      const input = codexInputs.find((item) =>
        JSON.stringify(item.content).includes(task.commandId),
      );
      NodeAssert.ok(input, `Original native input for ${task.id} must exist`);
      NodeAssert.equal(input.turnId, task.nativeTurnId);
      return {
        taskId: task.id,
        source: task.source,
        commandId: task.commandId,
        nativeMessageId: input.id,
        nativeTurnId: input.turnId,
      };
    });
  const require = NodeModule.createRequire(new URL("../apps/server/package.json", import.meta.url));
  const sdk = await import(
    NodeURL.pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href
  );
  const messages = await sdk.getSessionMessages(claude.nativeSessionId, {
    dir: combat.worktreePath,
  });
  const claudeEvidence = state.tasks
    .filter((task) => task.workspaceId === combat.id)
    .map((task) => {
      const input = messages.find(
        (message) =>
          message.type === "user" && JSON.stringify(message.message).includes(task.commandId),
      );
      NodeAssert.ok(input, `Original Claude message for ${task.id} must exist`);
      NodeAssert.equal(input.session_id, claude.nativeSessionId);
      return {
        taskId: task.id,
        source: task.source,
        commandId: task.commandId,
        nativeMessageId: input.uuid,
        sessionId: input.session_id,
      };
    });
  const latestClaude = state.tasks.findLast((task) => task.workspaceId === combat.id);
  NodeAssert.ok(
    latestClaude.nativeMessageIds.includes(claudeEvidence.at(-1).nativeMessageId),
    "The accepted Claude input UUID must point to its native transcript message",
  );
  const main = state.bindings.find((binding) => binding.role === "main");
  const mainHistory = state.goal
    ? await rpc("thread/read", { threadId: main.nativeSessionId, includeTurns: true })
    : null;
  const automaticMainTurns =
    mainHistory?.thread.turns
      .filter((turn) =>
        turn.items.some(
          (item) =>
            item.type === "userMessage" &&
            JSON.stringify(item.content).includes("승인된 개발 목표의 다음 단계입니다."),
        ),
      )
      .map((turn) => turn.id) ?? [];
  if (state.goal) {
    NodeAssert.equal(mainHistory.thread.id, main.nativeSessionId);
    NodeAssert.equal(NodePath.resolve(mainHistory.thread.cwd), NodePath.resolve(main.cwd));
    NodeAssert.ok(automaticMainTurns.length >= state.goal.steps);
  }
  const mirrored = db
    .prepare("SELECT message_id,text FROM projection_thread_messages WHERE thread_id=?")
    .all(state.conversationId);
  for (const task of state.tasks)
    NodeAssert.ok(
      mirrored.some(
        (message) =>
          message.message_id ===
          `orchestra-message:${state.bindings.find((binding) => binding.id === task.bindingId).sessionKey}:${task.fencingGeneration}`,
      ),
    );
  const evidence = {
    conversationId: state.conversationId,
    nativeSessions: { codex: thread.id, claude: claude.nativeSessionId },
    originalInputs: [...codexEvidence, ...claudeEvidence],
    sameConversationResponses: state.tasks.length,
    privateReasoningIncluded: false,
    goal: state.goal
      ? {
          id: state.goal.id,
          status: state.goal.status,
          steps: state.goal.steps,
          mainNativeSessionId: main.nativeSessionId,
          automaticMainTurns,
        }
      : null,
    integration: state.integrations.findLast((entry) => entry.status === "release-ready"),
    policyFilesTracked: NodeFS.readFileSync(NodePath.join(home, "demo.json"), "utf8").length > 0,
  };
  NodeFS.writeFileSync(
    NodePath.join(home, "native-evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  db.close();
  reader.close();
  child.stdin.end();
  for (const pending of requests.values()) clearTimeout(pending.timer);
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise((resolve) => child.once("exit", resolve));
    const timer = setTimeout(() => child.kill(), 5_000);
    await stopped;
    clearTimeout(timer);
  }
}
