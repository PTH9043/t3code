import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import { connectDevelopmentEnvironment } from "./workspace-development-client.mjs";

// Only the model's HTTP response is a fixture. T3, the installed OpenCode,
// persistent native sessions, MCP tools, file writes, Git and verification are real.
const home = NodePath.resolve(process.argv[2]);
const binary = process.argv[3] ?? "opencode";
const fixture = NodeFS.mkdtempSync(NodePath.join(home, "api-demo-"));
const root = NodePath.join(fixture, "한글 API 프로젝트");
NodeFS.mkdirSync(root);
const git = (args, cwd = root) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
  }).trim();
git(["init", "-b", "main"]);
git(["config", "user.name", "API Demo"]);
git(["config", "user.email", "demo@localhost"]);
NodeFS.writeFileSync(
  NodePath.join(root, "AGENTS.md"),
  "Disposable test. Use assigned cwd. No push, deployment, dependency installation, browser, or delegation.\n",
);
NodeFS.writeFileSync(
  NodePath.join(root, "checks.test.mjs"),
  "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {maxStack} from './inventory.mjs'; test('approved stack',()=>assert.ok([99,30].includes(maxStack)));\n",
);
git(["add", "."]);
git(["commit", "-m", "Initialize API fixture"]);
const instanceId = `opencode_api_${NodeCrypto.randomUUID().slice(0, 8)}`;
const projectId = `api-project-${NodeCrypto.randomUUID()}`;
const threadId = `api-main-${NodeCrypto.randomUUID()}`;
const steps = new Map();
const requests = [];
let providers = [];
let current = null;
let mainRunning = false;
let watchers = [];
const changed = () => {
  const ready = watchers.filter((watcher) => watcher.predicate());
  watchers = watchers.filter((watcher) => !ready.includes(watcher));
  for (const watcher of ready) {
    clearTimeout(watcher.timer);
    watcher.resolve();
  }
};
const waitFor = (predicate) =>
  predicate()
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        const watcher = {
          predicate,
          resolve,
          timer: setTimeout(
            () => reject(new Error(`API demo timed out; inspect ${fixture}`)),
            180_000,
          ),
        };
        watchers.push(watcher);
      });
const contentText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : "";
const latestText = (body) => {
  const message = body.messages.findLast((entry) => entry.role === "user");
  return contentText(message?.content);
};
const tool = (body, ending, args) => {
  const name = (
    body.tools.find((entry) => entry.function.name === ending) ??
    body.tools.find((entry) => entry.function.name.endsWith(`_${ending}`))
  )?.function.name;
  NodeAssert.ok(name, `Native tool ${ending} must exist`);
  return {
    id: `call_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
};
const manage = (body, action) =>
  tool(body, "workspace_manage", { commandId: NodeCrypto.randomUUID(), ...action });
const respond = (body) => {
  const original = latestText(body);
  const delimiter = "사용자 입력:\n\n";
  const text = original.includes(delimiter)
    ? original.slice(original.lastIndexOf(delimiter) + delimiter.length)
    : original;
  let marker = [
    "SMOKE_MAIN_CREATE",
    "SMOKE_MAIN_INTEGRATE",
    "SMOKE_OWNER_99",
    "SMOKE_OWNER_30",
  ].find((value) => text.includes(value));
  // Keep Main's task when native steering appends a coalesced notification.
  if (!marker && original.includes(delimiter)) {
    for (const message of body.messages.filter((entry) => entry.role === "user")) {
      const content = contentText(message.content);
      const input = content.slice(content.lastIndexOf(delimiter) + delimiter.length);
      const prior = input.match(/SMOKE_MAIN_(?:CREATE|INTEGRATE)\b/u)?.[0];
      if (prior) marker = prior;
    }
  }
  if (!marker || !body.tools?.length) return { content: "API fixture acknowledgment." };
  const step = steps.get(marker) ?? 0;
  steps.set(marker, step + 1);
  const workspace = current?.workspaces[0];
  if (marker === "SMOKE_MAIN_CREATE") {
    if (step === 0)
      return {
        tool_calls: [
          manage(body, {
            action: "create",
            name: "API Inventory",
            scope: ["inventory.mjs"],
            modelIndex: 0,
            objective:
              "Independent inventory module responsibility and persistent development context.",
          }),
        ],
      };
    if (step === 1)
      return {
        tool_calls: [
          tool(body, "bash", {
            command: `node -e "const cp=require('node:child_process'); cp.execFileSync('git',['add','.workspace'],{stdio:'inherit',windowsHide:true}); cp.execFileSync('git',['commit','-m','Approve API workspace'],{stdio:'inherit',windowsHide:true});"`,
            description: "Commit approved policy",
          }),
        ],
      };
    if (step === 2) return { tool_calls: [manage(body, { action: "status" })] };
    if (step === 3)
      return {
        tool_calls: [
          manage(body, {
            action: "dispatch",
            workspaceId: workspace.id,
            expectedRevision: workspace.stateRevision,
            objective:
              "SMOKE_OWNER_99: implement inventory.mjs maxStack=99; commit and run node --test",
            acceptanceCriteria: ["maxStack=99", "node --test passes"],
          }),
        ],
      };
  } else if (marker.startsWith("SMOKE_OWNER")) {
    const value = marker.endsWith("30") ? 30 : 99;
    if (value === 30 && step === 0)
      return {
        tool_calls: [
          tool(body, "read", { filePath: NodePath.join(workspace.worktreePath, "inventory.mjs") }),
        ],
      };
    const writeStep = value === 30 ? 1 : 0;
    if (step === writeStep)
      return {
        tool_calls: [
          tool(body, "write", {
            filePath: NodePath.join(workspace.worktreePath, "inventory.mjs"),
            content: `export const maxStack = ${value};\n`,
          }),
        ],
      };
    if (step === writeStep + 1)
      return {
        tool_calls: [
          tool(body, "bash", {
            command: `node -e "const cp=require('node:child_process'); cp.execFileSync(process.execPath,['--test'],{stdio:'inherit',windowsHide:true}); cp.execFileSync('git',['add','inventory.mjs'],{stdio:'inherit',windowsHide:true}); cp.execFileSync('git',['commit','-m','Set maxStack ${value}'],{stdio:'inherit',windowsHide:true});"`,
            description: "Verify and commit exact candidate",
          }),
        ],
      };
  } else if (marker === "SMOKE_MAIN_INTEGRATE") {
    if (step === 0) return { tool_calls: [manage(body, { action: "status" })] };
    if (step === 1)
      return {
        tool_calls: [
          manage(body, {
            action: "reconcile",
            workspaceId: workspace.id,
            expectedRevision: workspace.stateRevision,
            objective:
              "User requirement=30 replaces Main=99; no additional domain impact in fixture.",
          }),
        ],
      };
    if (step === 2) return { tool_calls: [manage(body, { action: "status" })] };
    if (step === 3)
      return {
        tool_calls: [
          manage(body, {
            action: "verify",
            workspaceId: workspace.id,
            expectedRevision: workspace.stateRevision,
            candidateSha: current.tasks.findLast((task) => task.status === "completed")
              .candidateSha,
          }),
        ],
      };
    if (step === 4)
      return {
        tool_calls: [
          manage(body, {
            action: "integrate",
            verificationIds: [
              current.verifications.findLast((verification) => verification.status === "passed").id,
            ],
          }),
        ],
      };
  }
  return { content: `${marker} completed; native tools and evidence recorded.` };
};
const api = NodeHttp.createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    NodeAssert.equal(request.headers.authorization, "Bearer local-fixture-key");
    for (const message of body.messages.filter((entry) => entry.role === "assistant")) {
      NodeAssert.equal(
        typeof message.reasoning_content,
        "string",
        "DeepSeek-compatible reasoning field survives tool calls and session resume",
      );
    }
    const message = respond(body);
    requests.push({
      model: body.model,
      tools: message.tool_calls?.map((entry) => entry.function.name) ?? [],
      marker: latestText(body).match(/SMOKE_[A-Z_0-9]+/)?.[0] ?? "notification",
    });
    NodeFS.writeFileSync(
      NodePath.join(fixture, "requests.json"),
      JSON.stringify(requests, null, 2),
    );
    const finish_reason = message.tool_calls ? "tool_calls" : "stop";
    const common = {
      id: `chatcmpl_${NodeCrypto.randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: body.model,
    };
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = {
        role: "assistant",
        reasoning_content: "fixture metadata",
        ...(message.content ? { content: message.content } : {}),
        ...(message.tool_calls
          ? { tool_calls: message.tool_calls.map((entry, index) => ({ index, ...entry })) }
          : {}),
      };
      response.write(
        `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ...common,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", reasoning_content: "fixture metadata", ...message },
              finish_reason,
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
    }
  } catch (error) {
    response.writeHead(500);
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${api.address().port}/v1`;
const environment = [
  { name: "T3_OPENCODE_API_KEY", value: "local-fixture-key", sensitive: true },
  ...["DATA", "CONFIG", "STATE", "CACHE"].map((kind) => ({
    name: `XDG_${kind}_HOME`,
    value: NodePath.join(fixture, kind.toLowerCase()),
    sensitive: false,
  })),
];
const nativeEnvironment = {
  ...process.env,
  ...Object.fromEntries(environment.map(({ name, value }) => [name, value])),
};
const client = await connectDevelopmentEnvironment(home);
const unsubscribers = [];
const command = (value) =>
  client.rpc("orchestration.dispatchCommand", {
    commandId: NodeCrypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...value,
  });
const model = { instanceId, model: "fixture_api/deepseek-fixture" };
const turn = (text) =>
  command({
    type: "thread.turn.start",
    threadId,
    message: { messageId: NodeCrypto.randomUUID(), role: "user", text, attachments: [] },
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
  });
let originalSettings;
try {
  unsubscribers.push(
    client.subscribe("subscribeServerConfig", {}, (event) => {
      if (event.type === "snapshot") providers = event.config.providers;
      if (event.type === "providerStatuses") providers = event.payload.providers;
      changed();
    }),
  );
  originalSettings = await client.rpc("server.getSettings", {});
  const saved = await client.rpc("server.updateSettings", {
    patch: {
      providerInstances: {
        ...originalSettings.providerInstances,
        [instanceId]: {
          driver: "opencode",
          enabled: true,
          displayName: "Disposable compatible API",
          environment,
          config: {
            binaryPath: binary,
            apiConnection: {
              providerId: "fixture_api",
              baseUrl: endpoint,
              protocol: "chat-completions",
              models: ["deepseek-fixture"],
              contextTokens: 128000,
              outputTokens: 8192,
            },
          },
        },
      },
    },
  });
  NodeAssert.equal(saved.providerInstances[instanceId].environment[0].valueRedacted, true);
  NodeAssert.equal(saved.providerInstances[instanceId].environment[0].value, "");
  await client.rpc("server.refreshProviders", {});
  await waitFor(() =>
    providers
      .find((provider) => provider.instanceId === instanceId)
      ?.models.some((entry) => entry.slug === model.model),
  );
  const config = await client.rpc("server.getConfig", {});
  const discovered = config.providers.find((provider) => provider.instanceId === instanceId);
  console.log(
    JSON.stringify({
      discovered: discovered
        ? {
            status: discovered.status,
            message: discovered.message,
            models: discovered.models.map((entry) => entry.slug),
          }
        : null,
    }),
  );
  NodeAssert.ok(
    config.providers
      .find((provider) => provider.instanceId === instanceId)
      ?.models.some((entry) => entry.slug === model.model),
  );
  await command({
    type: "project.create",
    projectId,
    title: "API native workspace demo",
    workspaceRoot: root,
    defaultModelSelection: model,
  });
  await command({
    type: "thread.create",
    projectId,
    threadId,
    title: "API Main and Owner",
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  unsubscribers.push(
    client.subscribe("workspaceDevelopment.subscribe", { projectId }, ({ state }) => {
      current = state;
      changed();
    }),
  );
  unsubscribers.push(
    client.subscribe("orchestration.subscribeThread", { threadId }, (item) => {
      if (item.kind === "snapshot")
        mainRunning = item.snapshot.thread?.session?.status === "running";
      if (item.kind === "event" && item.event.type === "thread.session-set")
        mainRunning = item.event.payload.session.status === "running";
      changed();
    }),
  );
  current = await client.rpc("workspaceDevelopment.configure", {
    projectId,
    conversationId: threadId,
    commandId: NodeCrypto.randomUUID(),
    enabled: true,
    mainModel: model,
    ownerModels: [model],
    runtimeMode: "full-access",
    maxParallelOwners: 1,
    verificationCommands: [{ command: process.execPath, args: ["--test"] }],
  });
  git(["add", ".workspace"]);
  git(["commit", "-m", "Approve API policy"]);
  await turn("SMOKE_MAIN_CREATE: create and dispatch; preserve stable Owner; no external release.");
  await waitFor(() =>
    current?.tasks.some((task) => task.source === "main-dispatch" && task.status === "completed"),
  );
  const first = structuredClone(current);
  NodeAssert.ok(first.tasks[0].candidateSha, "Native Owner committed a clean candidate");
  const workspace = current.workspaces[0];
  const ownerId = current.bindings.find((binding) => binding.role === "owner").nativeSessionId;
  NodeAssert.ok(ownerId?.startsWith("ses_"));
  const direct = {
    projectId,
    conversationId: threadId,
    workspaceId: workspace.id,
    commandId: NodeCrypto.randomUUID(),
    expectedRevision: workspace.stateRevision,
    text: "SMOKE_OWNER_30: confirmed requirement replaces 99 with 30; test and commit.",
    mode: "takeover",
    requirementChange: true,
  };
  await client.rpc("workspaceDevelopment.directInput", direct);
  await client.rpc("workspaceDevelopment.directInput", direct);
  await waitFor(() =>
    current?.tasks.some(
      (task) => task.commandId === direct.commandId && task.status === "completed",
    ),
  );
  NodeAssert.equal(current.tasks.filter((task) => task.commandId === direct.commandId).length, 1);
  NodeAssert.equal(
    current.bindings.find((binding) => binding.role === "owner").nativeSessionId,
    ownerId,
  );
  NodeAssert.equal(current.workspaces[0].requirementRevision, 2);
  NodeAssert.equal(current.workspaces[0].control, "human");
  NodeAssert.ok(
    current.tasks.find((task) => task.commandId === direct.commandId).candidateSha,
    "Direct input committed a clean candidate",
  );
  const exported = JSON.parse(
    NodeChildProcess.execFileSync(binary, ["export", ownerId], {
      cwd: workspace.worktreePath,
      env: nativeEnvironment,
      windowsHide: true,
      encoding: "utf8",
      timeout: 30_000,
    }),
  );
  const userMessages = exported.messages.filter((message) => message.info.role === "user");
  for (const task of current.tasks) {
    const original = userMessages.find((message) =>
      message.parts.some((part) => part.type === "text" && part.text.includes(task.commandId)),
    );
    NodeAssert.ok(original, "Task is present in the same native history");
    NodeAssert.ok(
      task.nativeMessageIds.includes(original.info.id),
      "Original message ID was retained in the management record",
    );
  }
  await client.rpc("workspaceDevelopment.returnControl", {
    projectId,
    workspaceId: workspace.id,
    commandId: NodeCrypto.randomUUID(),
    expectedRevision: current.workspaces[0].stateRevision,
  });
  await waitFor(() => !mainRunning);
  await turn(
    "SMOKE_MAIN_INTEGRATE: understand direct requirement=30, verify exact candidate, integrate locally.",
  );
  await waitFor(() =>
    current?.integrations.some((integration) => integration.status === "release-ready"),
  );
  const integration = current.integrations.findLast((entry) => entry.status === "release-ready");
  NodeAssert.equal(git(["rev-parse", "HEAD"]), integration.resultSha);
  NodeAssert.match(NodeFS.readFileSync(NodePath.join(root, "inventory.mjs"), "utf8"), /30/);
  const tests = NodeChildProcess.spawnSync(process.execPath, ["--test"], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
  });
  NodeAssert.equal(tests.status, 0);
  NodeFS.writeFileSync(
    NodePath.join(fixture, "evidence.json"),
    JSON.stringify(
      {
        fixtureType: "local-compatible-api-with-real-harness",
        liveDeepSeek: false,
        binaryVersion: NodeChildProcess.execFileSync(binary, ["--version"], {
          windowsHide: true,
          encoding: "utf8",
        }).trim(),
        projectId,
        threadId,
        firstOwnerSessionId: ownerId,
        afterDirectOwnerSessionId: current.bindings.find((binding) => binding.role === "owner")
          .nativeSessionId,
        inputIds: userMessages.map((message) => message.info.id),
        requirementRevision: current.workspaces[0].requirementRevision,
        taskCount: current.tasks.length,
        mainDispatchCommandId: first.tasks[0].commandId,
        directCommandId: direct.commandId,
        integration,
        tests: {
          command: [process.execPath, "--test"],
          exitCode: tests.status,
          output: tests.stdout,
        },
        requests,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      fixture,
      ownerId,
      candidate: integration.candidates,
      target: integration.expectedTargetSha,
      result: integration.resultSha,
      nativeInputIds: userMessages.map((message) => message.info.id),
    }),
  );
} finally {
  for (const watcher of watchers) clearTimeout(watcher.timer);
  for (const unsubscribe of unsubscribers) unsubscribe();
  if (originalSettings)
    await client
      .rpc("server.updateSettings", {
        patch: { providerInstances: originalSettings.providerInstances },
      })
      .catch(() => {});
  client.close();
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
}
