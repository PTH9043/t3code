import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { connectDevelopmentEnvironment } from "./workspace-development-client.mjs";

const home = NodePath.resolve(process.argv[2] ?? ".t3/workspace-development-20260930");
const phase = process.argv[3] ?? "create";
const root = NodePath.join(home, "한글 프로젝트 repo");
const recordPath = NodePath.join(home, "demo.json");
const projectId = "persistent-development-demo";
const threadId = "persistent-development-main";
const git = (args) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
  }).trim();
const commit = (message) =>
  git(["-c", "user.name=T3 Demo", "-c", "user.email=demo@localhost", "commit", "-m", message]);
if (!NodeFS.existsSync(NodePath.join(root, ".git"))) {
  NodeFS.mkdirSync(root, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(root, "AGENTS.md"),
    "This is a disposable persistent workspace test. Each session has its role in the management input; do not assume all sessions are Main. Work only in your assigned checkout. Do not push, publish, deploy, install dependencies, access secrets, use browsers, or delegate. Preserve other people's changes. Use git -c user.name=Demo -c user.email=demo@localhost for commits. Keep output concise.\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "checks.test.mjs"),
    `import {test} from 'node:test'; import * as NodeAssert from 'node:assert/strict'; import * as NodeFS from 'node:fs';
test('inventory interface', {skip:!NodeFS.existsSync('inventory.mjs')}, async()=>{const x=await import('./inventory.mjs'); NodeAssert.ok(Number.isInteger(x.maxStack)); NodeAssert.ok(x.maxStack>0&&x.maxStack<=99);});
test('combat interface', {skip:!NodeFS.existsSync('combat.mjs')}, async()=>{const x=await import('./combat.mjs'); NodeAssert.equal(x.damage(10,3),7); NodeAssert.equal(x.damage(1,3),0);});\n`,
  );
  git(["init", "-b", "main"]);
  git(["add", "AGENTS.md", "checks.test.mjs"]);
  commit("Initialize persistent workspace demo");
}
const client = await connectDevelopmentEnvironment(home);
let current = null;
let watchers = [];
const unsubscribe = client.subscribe(
  "workspaceDevelopment.subscribe",
  { projectId },
  ({ state }) => {
    current = state;
    for (const watcher of watchers) if (watcher.predicate(state)) watcher.resolve(state);
    watchers = watchers.filter((watcher) => !watcher.predicate(state));
  },
);
const waitFor = (predicate) =>
  current && predicate(current)
    ? Promise.resolve(current)
    : new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(`Demo ${phase} timed out; inspect same conversation and durable state.`),
            ),
          15 * 60_000,
        );
        watchers.push({
          predicate,
          resolve: (state) => {
            clearTimeout(timer);
            resolve(state);
          },
        });
      });
const command = (value) =>
  client.rpc("orchestration.dispatchCommand", {
    commandId: NodeCrypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...value,
  });
const turn = (text, model) =>
  command({
    type: "thread.turn.start",
    threadId,
    message: { messageId: NodeCrypto.randomUUID(), role: "user", text, attachments: [] },
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
  });
try {
  const config = await client.rpc("server.getConfig", {});
  const codex = config.providers.find(
    (provider) => provider.driver === "codex" && provider.status === "ready",
  );
  const claude = config.providers.find(
    (provider) => provider.driver === "claudeAgent" && provider.status === "ready",
  );
  NodeAssert.ok(
    codex && claude,
    "Both installed providers must be ready; do not substitute a mocked harness.",
  );
  const codexSlug =
    codex.models.find((model) => model.slug === "gpt-6.1-sol")?.slug ?? codex.models[0]?.slug;
  const claudeSlug =
    claude.models.find((model) => model.slug === "claude-sonnet-4-6")?.slug ??
    claude.models[0]?.slug;
  NodeAssert.ok(codexSlug && claudeSlug);
  const mainModel = {
    instanceId: codex.instanceId,
    model: codexSlug,
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  const ownerModels = [
    mainModel,
    { instanceId: claude.instanceId, model: claudeSlug, options: [{ id: "effort", value: "low" }] },
  ];
  const existing = await client.rpc("workspaceDevelopment.get", { projectId });
  current = existing.state;
  if (!current) {
    await command({
      type: "project.create",
      projectId,
      title: "Persistent Codex + Claude demo",
      workspaceRoot: root,
      defaultModelSelection: mainModel,
    });
    await command({
      type: "thread.create",
      projectId,
      threadId,
      title: "One conversation · persistent Owners",
      modelSelection: mainModel,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    current = await client.rpc("workspaceDevelopment.configure", {
      projectId,
      conversationId: threadId,
      commandId: NodeCrypto.randomUUID(),
      enabled: true,
      mainModel,
      ownerModels,
      runtimeMode: "full-access",
      maxParallelOwners: 2,
      verificationCommands: [{ command: process.execPath, args: ["--test"] }],
    });
    git(["add", ".workspace"]);
    commit("Approve demo workspace policy");
  }
  if (phase === "create") {
    await turn(
      "이 데모에서는 통합을 별도 요청할 때까지 하지 마세요. workspace_manage를 사용해 이름 Inventory(scope inventory.mjs, modelIndex 0), Combat(scope combat.mjs, modelIndex 1) 두 지속 작업실을 생성하세요. 분리 근거는 독립 모듈 변경과 장기 맥락입니다. Architect 검토는 이 명확한 데모에서 생략합니다. 각 작업실 생성 후 status를 읽고 최신 stateRevision으로 dispatch하세요. Inventory Owner 목표: inventory.mjs에 export const maxStack = 99; 를 작성하고 그 파일만 커밋하세요. Combat Owner 목표: combat.mjs에 export const damage = (attack, armor) => Math.max(0, attack - armor); 를 작성하고 그 파일만 커밋하세요. 완료조건은 정확한 export와 node --test 통과, 해당 파일의 커밋입니다. Main은 기능 파일을 직접 구현하지 마세요. 역할 파일과 정의 등 .workspace 변경은 Main의 네이티브 셸 도구로 해당 파일만 커밋해 통합 위치를 깨끗하게 유지하세요. 두 배정 이후 대기하며 Owner 완료 알림은 status로 읽고 간단히 보고만 하세요. push/tag/release/deploy는 금지입니다.",
      mainModel,
    );
    current = await waitFor(
      (state) =>
        state?.workspaces.filter((workspace) => workspace.status === "ready").length === 2 &&
        state.tasks.filter((task) => task.source === "main-dispatch" && task.status === "completed")
          .length >= 2,
    );
    NodeAssert.equal(
      new Set(
        current.bindings
          .filter((binding) => binding.role === "owner")
          .map((binding) => binding.nativeSessionId),
      ).size,
      2,
    );
  } else if (phase === "direct") {
    const inventory = current.workspaces.find((workspace) => workspace.name === "Inventory");
    NodeAssert.ok(inventory);
    const originalBinding = current.bindings.find((binding) => binding.id === inventory.bindingId);
    const commandId = NodeCrypto.randomUUID();
    const input = {
      projectId,
      conversationId: threadId,
      workspaceId: inventory.id,
      commandId,
      expectedRevision: inventory.stateRevision,
      text: "확정 요구 변경: maxStack을 99에서 30으로 바꾸세요. inventory.mjs만 수정하고 node --test 확인 후 해당 파일만 새 커밋하세요. 앞선 Main의 99 지시는 폐기되었습니다.",
      mode: "takeover",
      requirementChange: true,
    };
    await client.rpc("workspaceDevelopment.directInput", input);
    await client.rpc("workspaceDevelopment.directInput", input);
    current = await waitFor((state) =>
      state?.tasks.some((task) => task.commandId === commandId && task.status === "completed"),
    );
    NodeAssert.equal(current.tasks.filter((task) => task.commandId === commandId).length, 1);
    NodeAssert.equal(
      current.bindings.find((binding) => binding.id === inventory.bindingId).nativeSessionId,
      originalBinding.nativeSessionId,
    );
    const changed = current.workspaces.find((workspace) => workspace.id === inventory.id);
    NodeAssert.equal(changed.requirementRevision, inventory.requirementRevision + 1);
    NodeAssert.equal(changed.takeover, true);
    const filename = NodePath.join(changed.worktreePath, "inventory.mjs");
    NodeAssert.match(NodeFS.readFileSync(filename, "utf8"), /30/u);
  } else if (phase === "integrate") {
    const previousIntegrationCount = current.integrations.length;
    const inventory = current.workspaces.find((workspace) => workspace.name === "Inventory");
    if (inventory.takeover)
      await client.rpc("workspaceDevelopment.returnControl", {
        projectId,
        workspaceId: inventory.id,
        commandId: NodeCrypto.randomUUID(),
        expectedRevision: inventory.stateRevision,
      });
    await turn(
      "이제 사용자 직접 변경 maxStack=30을 확정하고 관련 영향을 처리한 것으로 기록하세요. status를 읽고 실행이 끝난 Inventory와 Combat을 필요시 reconcile(objective에 변경 영향과 이전 99 폐기를 기록)하세요. status를 다시 읽어 Main 관찰 cursor를 최신으로 맞추세요. 사용자 미커밋 변경을 지우지 마세요. .workspace 정의 파일만 커밋해 통합 위치를 깨끗하게 유지하세요. 각 Owner의 현재 정확한 candidateSha와 최신 stateRevision으로 verify를 실행한 뒤 동일 현재 target 기준의 passed verificationIds를 함께 integrate 하세요. 요구 개정이 다른 이전 후보는 사용하지 마세요. 로컬 통합과 node --test까지 수행하고 release-ready SHA를 보고하세요. push/tag/release/deploy 금지입니다.",
      mainModel,
    );
    current = await waitFor(
      (state) =>
        state?.integrations.length > previousIntegrationCount &&
        state.integrations.at(-1)?.status === "release-ready",
    );
    NodeAssert.equal(git(["rev-parse", "HEAD"]), current.integrations.at(-1).resultSha);
    NodeAssert.match(NodeFS.readFileSync(NodePath.join(root, "inventory.mjs"), "utf8"), /30/u);
    console.log(
      NodeChildProcess.execFileSync(process.execPath, ["--test"], {
        cwd: root,
        windowsHide: true,
        encoding: "utf8",
      }),
    );
  } else if (phase === "followup") {
    const combat = current.workspaces.find((workspace) => workspace.name === "Combat");
    const original = current.bindings.find((binding) => binding.id === combat.bindingId);
    const commandId = NodeCrypto.randomUUID();
    await client.rpc("workspaceDevelopment.directInput", {
      projectId,
      conversationId: threadId,
      workspaceId: combat.id,
      commandId,
      expectedRevision: combat.stateRevision,
      text: "서비스 재시작 후 같은 세션 재개 확인입니다. 이전에 작성한 damage(10,3) 결과와 담당 범위를 간단히 확인하세요. 파일, Git, 외부 공개를 변경하지 마세요.",
      mode: "followup",
      requirementChange: false,
    });
    current = await waitFor((state) =>
      state?.tasks.some((task) => task.commandId === commandId && task.status === "completed"),
    );
    NodeAssert.equal(
      current.bindings.find((binding) => binding.id === combat.bindingId).nativeSessionId,
      original.nativeSessionId,
    );
    NodeAssert.equal(
      current.workspaces.find((workspace) => workspace.id === combat.id).requirementRevision,
      combat.requirementRevision,
    );
  } else if (phase !== "inspect") throw new Error(`Unknown phase: ${phase}`);
  NodeFS.writeFileSync(
    recordPath,
    JSON.stringify(
      {
        phase,
        projectId,
        threadId,
        root,
        providers: [codex, claude].map((provider) => ({
          driver: provider.driver,
          version: provider.version,
        })),
        bindings: current.bindings,
        workspaces: current.workspaces,
        tasks: current.tasks,
        verifications: current.verifications,
        integrations: current.integrations,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        phase,
        projectId,
        threadId,
        workspaces: current.workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          control: workspace.control,
          requirementRevision: workspace.requirementRevision,
        })),
        bindings: current.bindings.map((binding) => ({
          role: binding.role,
          nativeSessionId: binding.nativeSessionId,
        })),
        tasks: current.tasks.map((task) => ({
          id: task.id,
          source: task.source,
          status: task.status,
          nativeTurnId: task.nativeTurnId,
        })),
        integrations: current.integrations,
      },
      null,
      2,
    ),
  );
} finally {
  unsubscribe();
  client.close();
}
