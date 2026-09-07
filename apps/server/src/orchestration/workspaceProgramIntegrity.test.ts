import {
  DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceProgramId,
  WorkspaceTaskNodeId,
  type WorkspaceAgentRoleBinding,
  type WorkspaceProgram,
  type WorkspaceTaskGraph,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  buildWorkspaceProgramIntegrityTask,
  evaluateWorkspaceProgramIntegrityRun,
  WORKSPACE_INTEGRITY_CONVERGED_MARKER,
} from "./workspaceProgramIntegrity.ts";

const at = "2026-08-10T00:00:00.000Z";
const projectId = ProjectId.make("integrity-project");
const implementationId = WorkspaceTaskNodeId.make("implementation");
const validationId = WorkspaceTaskNodeId.make("validation");

function completedGraph(verifierInstanceId = "claude-review"): WorkspaceTaskGraph {
  return {
    revision: 1,
    status: "completed",
    changes: [],
    nextAction: "수렴",
    overallConfidence: "high",
    repairApproved: null,
    memoryCandidates: [],
    nodes: [
      {
        id: implementationId,
        order: 0,
        kind: "implementation",
        agent: "codex",
        role: "implementer",
        participantId: null,
        threadId: null,
        parkedQuestion: null,
        worktreePath: null,
        branch: null,
        title: "오류 수정",
        handoff: {
          task: "오류 수정",
          goal: "검증 통과",
          context: "프로그램",
          input: "점검 결과",
          constraints: [],
          expectedOutput: "수정",
          successCriteria: ["테스트 통과"],
        },
        dependsOn: [],
        validationTargetId: null,
        priority: 1,
        status: "completed",
        maxAttempts: 2,
        attempts: [
          {
            number: 1,
            agent: "codex",
            role: "implementer",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-fix"),
              model: "codex-model",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            strategy: "수정",
            threadId: ThreadId.make("integrity-fix-thread"),
            status: "completed",
            output: "수정 완료",
            error: null,
            failureClassification: null,
            confidence: "high",
            startedAt: at,
            completedAt: at,
          },
        ],
        output: "수정 완료",
        error: null,
        failureClassification: null,
        confidence: "high",
        validation: null,
        startedAt: at,
        completedAt: at,
      },
      {
        id: validationId,
        order: 1,
        kind: "validation",
        agent: "fable",
        role: "verifier",
        participantId: null,
        threadId: null,
        parkedQuestion: null,
        worktreePath: null,
        branch: null,
        title: "독립 검증",
        handoff: {
          task: "독립 검증",
          goal: "자기 승인 방지",
          context: "변경분",
          input: "수정 결과",
          constraints: [],
          expectedOutput: "검증 영수증",
          successCriteria: ["테스트 통과"],
        },
        dependsOn: [implementationId],
        validationTargetId: implementationId,
        priority: 1,
        status: "completed",
        maxAttempts: 2,
        attempts: [
          {
            number: 1,
            agent: "fable",
            role: "verifier",
            modelSelection: {
              instanceId: ProviderInstanceId.make(verifierInstanceId),
              model: "review-model",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            strategy: "적대적 재검증",
            threadId: ThreadId.make("integrity-review-thread"),
            status: "completed",
            output: "검증 통과",
            error: null,
            failureClassification: null,
            confidence: "high",
            startedAt: at,
            completedAt: at,
          },
        ],
        output: "검증 통과",
        error: null,
        failureClassification: null,
        confidence: "high",
        validation: {
          targetNodeId: implementationId,
          verdict: "pass",
          confidence: "high",
          summary: "독립 검증 통과",
          evidence: ["focused test 통과"],
          failureClassification: null,
          nextAction: "수렴 가능",
          recordedAt: at,
        },
        startedAt: at,
        completedAt: at,
      },
    ],
  };
}

it("requires a different CLI account to approve a converged integrity run", () => {
  const approved = evaluateWorkspaceProgramIntegrityRun({
    status: "completed",
    graph: completedGraph(),
    finalOutput: `개선 사항 없음\n${WORKSPACE_INTEGRITY_CONVERGED_MARKER}`,
    error: null,
  });
  expect(approved.converged).toBe(true);
  expect(approved.distinctInstanceIds).toEqual(["codex-fix", "claude-review"]);

  const selfApproved = evaluateWorkspaceProgramIntegrityRun({
    status: "completed",
    graph: completedGraph("codex-fix"),
    finalOutput: WORKSPACE_INTEGRITY_CONVERGED_MARKER,
    error: null,
  });
  expect(selfApproved.converged).toBe(false);
  expect(selfApproved.reasons.join(" ")).toContain("자신의 작업을 승인");
});

it("keeps iterating without an explicit no-actionable-findings marker", () => {
  const evaluation = evaluateWorkspaceProgramIntegrityRun({
    status: "completed",
    graph: completedGraph(),
    finalOutput: "집중 검사는 통과했지만 성능 개선을 더 확인해야 합니다.",
    error: null,
  });
  expect(evaluation.converged).toBe(false);
  expect(evaluation.reasons.join(" ")).toContain("명시적 수렴 판정");
});

it("builds a project-scoped ping-pong task with commands and prior evidence", () => {
  const program: WorkspaceProgram = {
    id: WorkspaceProgramId.make("web"),
    projectId,
    name: "웹 앱",
    command: "vp run dev",
    relativeDirectory: "apps/web",
    environmentVariableNames: [],
    startPolicy: "manual",
    healthCheck: null,
    errorPatterns: [],
    enabled: true,
    integrity: {
      ...DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
      enabled: true,
      validationCommands: ["vp test run apps/web/src/example.test.ts"],
      status: "queued",
    },
    createdAt: at,
    updatedAt: at,
  };
  const bindings: WorkspaceAgentRoleBinding[] = [
    {
      projectId,
      role: "implementer",
      displayName: "Codex 수정",
      modelSelection: { instanceId: ProviderInstanceId.make("codex-fix"), model: "codex-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      instructions: "",
      enabled: true,
      updatedAt: at,
    },
    {
      projectId,
      role: "verifier",
      displayName: "Claude 검증",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude-review"),
        model: "claude-model",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      instructions: "",
      enabled: true,
      updatedAt: at,
    },
  ];
  const task = buildWorkspaceProgramIntegrityTask({
    program,
    cycle: 3,
    bindings,
    priorSummary: "2주기에서 경계 조건 테스트를 추가했습니다.",
  });
  expect(task).toContain("현재 수렴 주기: 3");
  expect(task).toContain("codex-fix");
  expect(task).toContain("claude-review");
  expect(task).toContain("vp test run apps/web/src/example.test.ts");
  expect(task).toContain(WORKSPACE_INTEGRITY_CONVERGED_MARKER);
  expect(task).toContain("2주기에서 경계 조건 테스트");
});
