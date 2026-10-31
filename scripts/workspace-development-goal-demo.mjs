import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { connectDevelopmentEnvironment } from "./workspace-development-client.mjs";

const home = NodePath.resolve(process.argv[2]);
const phase = process.argv[3] ?? "start";
const projectId = "persistent-development-demo";
const client = await connectDevelopmentEnvironment(home);
const recordPath = NodePath.join(home, "goal-demo.json");
try {
  let current = (await client.rpc("workspaceDevelopment.get", { projectId })).state;
  NodeAssert.ok(current?.enabled);
  const main = current.bindings.find((b) => b.role === "main");
  const root = main.cwd;
  const git = (args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
    }).trim();
  if (phase === "start") {
    const baseline = {
      mainSessionId: main.nativeSessionId,
      owners: current.bindings
        .filter((b) => b.role === "owner")
        .map((b) => ({ id: b.id, nativeSessionId: b.nativeSessionId })),
      targetSha: git(["rev-parse", "HEAD"]),
      taskCount: current.tasks.length,
    };
    NodeAssert.equal(git(["status", "--porcelain"]), "");
    const revisions = current.workspaces
      .map((w) => `${w.name}: ${w.id} r${w.requirementRevision}`)
      .join("; ");
    const input = {
      projectId,
      conversationId: current.conversationId,
      commandId: NodeCrypto.randomUUID(),
      action: "start",
      ...(current.goal ? { expectedGoalRevision: current.goal.revision } : {}),
      objective: `이전 '별도 요청까지 통합 보류' 데모 지시는 이번 사용자 목표로 대체한다. ${revisions}. 기존 Inventory(Codex), Combat(Claude) Owner 두 세션에 각각 한 번 배정해 기능과 실제 테스트를 추가하고 로컬 통합한다. 각 Owner는 깨끗한 현재 브랜치에 git merge --ff-only ${baseline.targetSha}로 최신 통합을 반영한 뒤 작업한다. Inventory 목표: inventory.mjs의 maxStack=30을 유지하고 export const weightLimit = 60; 추가, inventory-goal.test.mjs에서 정확히 60을 검증하고 해당 두 파일만 커밋. Combat 목표: 기존 damage 동작을 유지하고 export const armorFactor = 2; 추가, combat-goal.test.mjs에서 정확히 2를 검증하고 해당 두 파일만 커밋. Main은 기능을 직접 구현하지 않고 기존 Owner에게 acceptanceCriteria와 최신 expectedRevision으로 배정한다. 첫 자동 Main 응답에서 두 작업을 배정하고 goal-progress outcome=wait를 기록한 뒤 응답을 끝낸다. Owner 완료 알림으로 다시 실행되면 최신 status를 읽고 필요한 reconcile, 각 정확한 candidateSha verify, 두 verificationIds integrate를 진행한다. 최종 검증 후 goal-progress outcome=complete에 정확한 integrationId와 각 완료조건을 충족한 요약을 기록한다. 테스트가 실패하거나 사용자 결정이 필요하면 blocked. 목표 밖 개선, 추가 세션, push, tag, release, deploy, 브라우저, 의존성 설치, subagent 사용은 하지 않는다.`,
      acceptanceCriteria: [
        "Inventory weightLimit=60과 maxStack=30",
        "Combat armorFactor=2와 기존 damage 동작",
        "두 Owner의 동일 native session ID 유지",
        "새 테스트를 포함한 node --test 통과와 정확한 후보의 로컬 통합",
      ],
      maxSteps: 8,
      maxMinutes: 20,
    };
    current = await client.rpc("workspaceDevelopment.goal", input);
    const again = await client.rpc("workspaceDevelopment.goal", input);
    NodeAssert.equal(again.goal.id, current.goal.id);
    NodeFS.writeFileSync(
      recordPath,
      JSON.stringify({ baseline, input, goalId: current.goal.id }, null, 2),
    );
    console.log(
      JSON.stringify({ goalId: current.goal.id, state: current.goal.status, singleUserGoal: true }),
    );
    await new Promise((resolve, reject) => {
      let unsubscribe;
      const timer = setTimeout(() => {
        unsubscribe?.();
        reject(new Error("Goal did not reach a terminal state; inspect persisted evidence."));
      }, 15 * 60_000);
      unsubscribe = client.subscribe(
        "workspaceDevelopment.subscribe",
        { projectId },
        ({ state }) => {
          if (!state?.goal) return;
          current = state;
          console.log(
            JSON.stringify({
              status: state.goal.status,
              phase: state.goal.phase,
              steps: state.goal.steps,
              tasks: state.tasks
                .slice(baseline.taskCount)
                .map((t) => ({ source: t.source, status: t.status, goalId: t.goalId })),
            }),
          );
          if (["complete", "blocked", "limited", "cancelled"].includes(state.goal.status)) {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        },
      );
    });
    const evidence = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
    evidence.state = current;
    evidence.resultSha = git(["rev-parse", "HEAD"]);
    evidence.actualTests = NodeChildProcess.spawnSync(process.execPath, ["--test"], {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
    });
    evidence.actualTests = {
      exitCode: evidence.actualTests.status,
      output: evidence.actualTests.stdout,
      error: evidence.actualTests.stderr,
    };
    NodeFS.writeFileSync(recordPath, JSON.stringify(evidence, null, 2));
    NodeAssert.equal(current.goal.status, "complete", current.goal.lastSummary);
    NodeAssert.ok(
      current.goal.steps >= 2,
      "Must continue automatically after the first native Main turn",
    );
    NodeAssert.equal(
      current.bindings.find((b) => b.role === "main").nativeSessionId,
      baseline.mainSessionId,
    );
    for (const owner of baseline.owners)
      NodeAssert.equal(
        current.bindings.find((b) => b.id === owner.id).nativeSessionId,
        owner.nativeSessionId,
      );
    NodeAssert.equal(evidence.actualTests.exitCode, 0);
    console.log(
      JSON.stringify({
        complete: true,
        goalId: current.goal.id,
        steps: current.goal.steps,
        resultSha: evidence.resultSha,
        evidencePath: recordPath,
      }),
    );
  } else {
    const previous = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
    NodeAssert.equal(current.goal.id, previous.goalId);
    console.log(
      JSON.stringify(
        {
          goal: current.goal,
          tasks: current.tasks.filter((t) => t.goalId === current.goal.id),
          integration: current.integrations.find((i) => i.id === current.goal.integrationId),
          bindings: current.bindings,
        },
        null,
        2,
      ),
    );
  }
} finally {
  client.close();
}
