import {
  DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  type IsoDateTime,
  type WorkspaceCollaborationRun,
  type WorkspaceTaskGraph,
  type WorkspaceTaskNode,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentKnowledgeItemId,
  isAutomaticAgentKnowledgeItem,
  toAgentKnowledgeCaptures,
} from "./workspaceAgentKnowledge.ts";

const at = "2026-08-15T00:00:00.000Z" as IsoDateTime;
const projectId = ProjectId.make("workspace-a");
const runId = WorkspaceCollaborationRunId.make("run-a");

function node(input: {
  readonly id: string;
  readonly output: string | null;
  readonly agent?: WorkspaceTaskNode["agent"];
  readonly kind?: WorkspaceTaskNode["kind"];
}): WorkspaceTaskNode {
  return {
    id: WorkspaceTaskNodeId.make(input.id),
    order: 0,
    kind: input.kind ?? "research",
    agent: input.agent ?? "grok",
    role: "researcher",
    participantId: null,
    threadId: null,
    parkedQuestion: null,
    worktreePath: null,
    branch: null,
    title: `${input.id} 제목`,
    handoff: {
      task: `${input.id} 작업`,
      goal: `${input.id} 목표`,
      context: "문맥",
      input: "입력",
      constraints: [],
      expectedOutput: "결과",
      successCriteria: ["출처가 명확하다"],
    },
    dependsOn: [],
    validationTargetId: null,
    priority: 0,
    status: "completed",
    maxAttempts: 3,
    attempts: [],
    output: input.output,
    error: null,
    failureClassification: null,
    confidence: "high",
    validation: null,
    startedAt: at,
    completedAt: at,
  };
}

function runWith(nodes: ReadonlyArray<WorkspaceTaskNode>): WorkspaceCollaborationRun {
  const graph: WorkspaceTaskGraph = {
    revision: 1,
    status: "completed",
    nodes,
    changes: [],
    nextAction: "종합",
    overallConfidence: "high",
    repairApproved: null,
    memoryCandidates: [],
  };
  return {
    id: runId,
    projectId,
    source: "user",
    scheduleId: null,
    incidentId: null,
    task: "제어 센터를 만든다",
    status: "completed",
    steps: [],
    meeting: null,
    orchestra: null,
    graph,
    finalOutput: "완료",
    error: null,
    createdAt: at,
    updatedAt: at,
  };
}

describe("Workspace agent knowledge capture", () => {
  it("captures every node that produced output, not a hand-picked subset", () => {
    const captures = toAgentKnowledgeCaptures({
      run: runWith([
        node({ id: "research", output: "현재 자료를 조사한 결과다." }),
        node({
          id: "build",
          output: "구현과 테스트를 마쳤다.",
          agent: "codex",
          kind: "implementation",
        }),
        node({ id: "empty", output: null }),
        node({ id: "blank", output: "   \n  " }),
      ]),
      settings: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
      capturedAt: at,
    });

    expect(captures.map((capture) => capture.nodeId)).toEqual(["research", "build"]);
    expect(captures.map((capture) => capture.item.provenance)).toEqual([
      { runId, nodeId: "research", actor: "grok", confidence: "high" },
      { runId, nodeId: "build", actor: "codex", confidence: "high" },
    ]);
    expect(captures.every((capture) => isAutomaticAgentKnowledgeItem(capture.item))).toBe(true);
    // rag-source is the only kind the isolated RAG index searches.
    expect(captures.every((capture) => capture.item.kind === "rag-source")).toBe(true);
    expect(captures.every((capture) => capture.item.origin === "agent")).toBe(true);
    expect(
      captures.every((capture) => capture.item.relativeFolder === "collaboration-outputs"),
    ).toBe(true);
    expect(captures[0]!.item.content).toContain("TASK: research 작업");
    expect(captures[0]!.item.content).toContain("OUTPUT:\n현재 자료를 조사한 결과다.");
    expect(captures[1]!.item.tags).toContain("agent-codex");
    expect(captures[1]!.item.tags).toContain("node-kind-implementation");
  });

  it("records the producing model independently of the legacy slot and leaves unknowns absent", () => {
    const threadId = ThreadId.make("producing-thread");
    const modelSelection = {
      instanceId: ProviderInstanceId.make("team-account"),
      model: "model-42",
    };
    const task = { ...node({ id: "slot", output: "recorded output" }), threadId, confidence: null };
    const attempt = {
      number: 1,
      agent: task.agent,
      role: task.role,
      modelSelection,
      threadId,
      runtimeMode: "full-access",
      interactionMode: "default",
      strategy: "primary",
      status: "completed",
      output: task.output,
      error: null,
      failureClassification: null,
      confidence: null,
      startedAt: at,
      completedAt: at,
    } satisfies WorkspaceTaskNode["attempts"][number];
    const provenance = (attempts: WorkspaceTaskNode["attempts"]) =>
      toAgentKnowledgeCaptures({
        run: runWith([{ ...task, attempts }]),
        settings: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
        capturedAt: at,
      })[0]!.item.provenance;
    const slot = { runId, nodeId: task.id, threadId, actor: "grok" };
    expect(provenance([attempt])).toEqual({ ...slot, modelSelection });
    expect(provenance([{ ...attempt, status: "failed" }])).toEqual(slot);
    expect(provenance([{ ...attempt, threadId: ThreadId.make("other-thread") }])).toEqual(slot);
    expect(provenance([])).toEqual(slot);
  });

  it("keeps one stable item per node so a re-run updates instead of duplicating", () => {
    const first = toAgentKnowledgeCaptures({
      run: runWith([node({ id: "research", output: "첫 번째 결과" })]),
      settings: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
      capturedAt: at,
    });
    const second = toAgentKnowledgeCaptures({
      run: runWith([node({ id: "research", output: "수정된 결과" })]),
      settings: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
      capturedAt: at,
    });

    expect(first[0]!.item.id).toBe(agentKnowledgeItemId({ runId, nodeId: "research" }));
    expect(second[0]!.item.id).toBe(first[0]!.item.id);
    expect(second[0]!.item.content).toContain("수정된 결과");
  });

  it("masks secrets and bounds long output to the configured budget", () => {
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    const captures = toAgentKnowledgeCaptures({
      run: runWith([node({ id: "research", output: `${secret}\n\n${"결과 ".repeat(4_000)}` })]),
      settings: { enabled: true, redactSensitiveData: true, maxOutputChars: 2_000 },
      capturedAt: at,
    });

    const item = captures[0]!.item;
    expect(item.content).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(item.content).toContain("[민감정보 제거: 토큰]");
    expect(item.content.length).toBeLessThanOrEqual(2_000);
    expect(item.tags).toContain("bounded");
    expect(captures[0]!.originalChars).toBeGreaterThan(captures[0]!.storedChars);
  });

  it("captures nothing when the project turned the feature off", () => {
    expect(
      toAgentKnowledgeCaptures({
        run: runWith([node({ id: "research", output: "결과" })]),
        settings: { ...DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS, enabled: false },
        capturedAt: at,
      }),
    ).toEqual([]);
  });

  it("captures nothing for a legacy run without a task graph", () => {
    const run = { ...runWith([]), graph: null } satisfies WorkspaceCollaborationRun;
    expect(
      toAgentKnowledgeCaptures({
        run,
        settings: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
        capturedAt: at,
      }),
    ).toEqual([]);
  });
});
