import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceMeetingParticipantId,
  WorkspaceTaskNodeId,
  type WorkspaceTaskNode,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildInitialWorkspaceTaskGraph,
  buildMeetingSeededTaskGraph,
  chainKeyByNodeId,
  computeWriteChains,
  grantsFreeRetryAfterInterruption,
  INTERRUPTED_TURN_ERROR_SUFFIX,
  materializeWorkspaceTaskGraphPlan,
  parseWorkspaceSynthesisPayload,
  parseWorkspaceTaskGraphProposal,
  parseWorkspaceValidationDecision,
  readyWorkspaceTaskNodes,
  selectGraphWaveNodes,
} from "./workspaceTaskGraph.ts";

const taggedPlan = (nodes: ReadonlyArray<Record<string, unknown>>) =>
  `<t3_task_graph>${JSON.stringify({ summary: "계획", nextAction: "실행", nodes })}</t3_task_graph>`;
const node = (input: Partial<Record<string, unknown>> & { id: string }) => ({
  kind: "research",
  agent: "grok",
  title: input.id,
  task: input.id,
  goal: input.id,
  context: "문맥",
  input: "입력",
  constraints: [],
  expectedOutput: "결과",
  successCriteria: ["검증 가능"],
  dependsOn: [],
  priority: 0,
  ...input,
});
const binding = (role: "coordinator" | "researcher" | "implementer") => ({
  projectId: ProjectId.make("workspace-a"),
  role,
  displayName: role,
  modelSelection: {
    instanceId: ProviderInstanceId.make(
      role === "coordinator" ? "claude" : role === "researcher" ? "grok" : "codex",
    ),
    model: "model",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  instructions: "",
  enabled: true,
  updatedAt: "2026-08-09T00:00:00.000Z",
});

describe("Workspace task graph", () => {
  it("repairs only unambiguous JSON wrappers and never invents missing judgments", () => {
    const receipt = JSON.stringify({
      verdict: "pass",
      confidence: "high",
      summary: "Checks passed",
      evidence: ["test-receipt-1"],
      nextAction: "done",
    });
    const tagged = `<t3_validation>${receipt}</t3_validation>`;
    for (const output of [
      receipt,
      `\u0060\u0060\u0060json\n${receipt}\n\u0060\u0060\u0060`,
      `<t3_validation>\u0060\u0060\u0060json\n${receipt}\n\u0060\u0060\u0060</t3_validation>`,
    ]) {
      expect(parseWorkspaceValidationDecision(output)).toEqual(
        parseWorkspaceValidationDecision(tagged),
      );
    }
    expect(() =>
      parseWorkspaceValidationDecision(JSON.stringify({ summary: "no verdict evidence" })),
    ).toThrow(/verdict/);
    expect(() =>
      parseWorkspaceValidationDecision(`Two proposals: ${receipt}\n${receipt}`),
    ).toThrow();
    expect(() => parseWorkspaceValidationDecision(`<t3_validation>${receipt}`)).toThrow(/Missing/);
    expect(() => parseWorkspaceValidationDecision(receipt.replace('"high"', '"high",'))).toThrow(
      /JSON/,
    );
  });
  it("rejects duplicate, missing, cyclic, and incompatible routes", () => {
    expect(() =>
      parseWorkspaceTaskGraphProposal(taggedPlan([node({ id: "same" }), node({ id: "same" })])),
    ).toThrow(/Duplicate/);
    expect(() =>
      parseWorkspaceTaskGraphProposal(taggedPlan([node({ id: "a", dependsOn: ["missing"] })])),
    ).toThrow(/missing/);
    expect(() =>
      parseWorkspaceTaskGraphProposal(
        taggedPlan([node({ id: "a", dependsOn: ["b"] }), node({ id: "b", dependsOn: ["a"] })]),
      ),
    ).toThrow(/cycle/);
    expect(() =>
      parseWorkspaceTaskGraphProposal(
        taggedPlan([node({ id: "build", kind: "implementation", agent: "grok" })]),
      ),
    ).toThrow(/implementer/);
  });

  it("accepts neutral role names while retaining older saved agent values", () => {
    const proposal = parseWorkspaceTaskGraphProposal(
      taggedPlan([
        node({ id: "plan-more", kind: "orchestration", agent: "coordinator" }),
        node({ id: "build", kind: "implementation", agent: "implementer" }),
        node({ id: "research", kind: "research", agent: "researcher" }),
      ]),
    );
    expect(proposal.nodes.map((entry) => entry.agent)).toEqual(["fable", "codex", "grok"]);
    expect(parseWorkspaceTaskGraphProposal(taggedPlan([node({ id: "old" })])).nodes[0]?.agent).toBe(
      "grok",
    );
    const initial = buildInitialWorkspaceTaskGraph("선택한 모델로 작업");
    expect(initial.nextAction).not.toMatch(/Fable|페이블/iu);
    expect(JSON.stringify(initial.nodes[0]?.handoff)).not.toMatch(/Fable|페이블/iu);
  });

  it("inserts coordinator validation gates and keeps independent work in one ready wave", () => {
    const initial = buildInitialWorkspaceTaskGraph("기능 구현");
    const planned = {
      ...initial,
      nodes: initial.nodes.map((item) => ({
        ...item,
        status: "completed" as const,
        output: "계획",
      })),
    };
    const proposal = parseWorkspaceTaskGraphProposal(
      taggedPlan([
        node({ id: "research" }),
        node({ id: "build", kind: "implementation", agent: "codex" }),
      ]),
    );
    const graph = materializeWorkspaceTaskGraphPlan({
      graph: planned,
      proposal,
      bindings: [binding("coordinator"), binding("researcher"), binding("implementer")],
      occurredAt: "2026-08-09T00:00:00.000Z",
    });
    expect(readyWorkspaceTaskNodes(graph).map((item) => item.id)).toEqual(["research", "build"]);
    expect(graph.nodes.filter((item) => item.kind === "validation")).toHaveLength(2);
    expect(graph.nodes.find((item) => item.kind === "synthesis")?.dependsOn).toEqual([
      "validate-research",
      "validate-build",
    ]);
  });

  it("opens validation only after its producer awaits validation", () => {
    const initial = buildInitialWorkspaceTaskGraph("조사");
    const planned = {
      ...initial,
      nodes: initial.nodes.map((item) => ({
        ...item,
        status: "completed" as const,
        output: "계획",
      })),
    };
    const graph = materializeWorkspaceTaskGraphPlan({
      graph: planned,
      proposal: parseWorkspaceTaskGraphProposal(taggedPlan([node({ id: "research" })])),
      bindings: [binding("coordinator"), binding("researcher")],
      occurredAt: "2026-08-09T00:00:00.000Z",
    });
    const afterResearch = {
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === "research" ? { ...item, status: "awaiting-validation" as const } : item,
      ),
    };
    expect(readyWorkspaceTaskNodes(afterResearch).map((item) => item.id)).toEqual([
      "validate-research",
    ]);
  });

  it("parses low-confidence validation and bounded synthesis memory", () => {
    const validation = parseWorkspaceValidationDecision(
      `<t3_validation>${JSON.stringify({ verdict: "inconclusive", confidence: "low", summary: "근거 부족", evidence: [], failureClassification: "information", nextAction: "추가 조사", followUpNodes: [] })}</t3_validation>`,
    );
    expect(validation).toMatchObject({ confidence: "low", failureClassification: "information" });
    expect(() =>
      parseWorkspaceValidationDecision(
        `<t3_validation>${JSON.stringify({ verdict: "fail", confidence: "high", summary: "순환", evidence: [], failureClassification: "implementation", nextAction: "수정", followUpNodes: [node({ id: "debug-a", kind: "debug", agent: "codex", dependsOn: ["debug-b"] }), node({ id: "debug-b", kind: "debug", agent: "codex", dependsOn: ["debug-a"] })] })}</t3_validation>`,
      ),
    ).toThrow(/cycle/);
    const synthesis = parseWorkspaceSynthesisPayload(
      `<t3_synthesis>${JSON.stringify({ finalOutput: "완료", confidence: "high", conflictDetected: false, nextAction: "완료", repairApproved: null, memoryCandidates: [{ category: "architecture", title: "구조", content: "검증된 구조", tags: ["verified"], confidence: "high", sourceNodeIds: ["research"] }] })}</t3_synthesis>`,
    );
    expect(synthesis.memoryCandidates).toHaveLength(1);
    expect(synthesis.confidence).toBe("high");
    expect(synthesis).toMatchObject({ conflictDetected: false, nextAction: "완료" });
  });

  it("routes a salvaged follow-up by its kind and infers a missing kind from the failure", () => {
    const decision = parseWorkspaceValidationDecision(
      `<t3_validation>${JSON.stringify({
        verdict: "fail",
        confidence: "medium",
        summary: "회귀",
        evidence: [],
        failureClassification: "implementation",
        nextAction: "수정",
        followUpNodes: [
          // An alias kind and the wrong agent for it: the kind wins the route.
          { title: "회귀 수정", agent: "grok", task: "실패 원인을 고친다.", kind: "fix" },
          // No kind: the named agent says what it is.
          { task: "원인 조사", agent: "grok" },
          // Neither: an implementation failure wants a debug node.
          { id: "Bad Id!", task: "다시 빌드" },
        ],
      })}</t3_validation>`,
    );
    expect(decision.followUpNodes.map((item) => [item.id, item.kind, item.agent])).toEqual([
      ["follow-up-1", "debug", "codex"],
      ["follow-up-2", "research", "grok"],
      ["bad-id", "debug", "codex"],
    ]);
    expect(decision.followUpNodes[1]?.title).toBe("원인 조사");
  });
});

describe("Workspace meeting task graph", () => {
  const seats = {
    participantIds: [
      WorkspaceMeetingParticipantId.make("p1"),
      WorkspaceMeetingParticipantId.make("p2"),
    ],
    chairParticipantId: WorkspaceMeetingParticipantId.make("p1"),
  };

  it("validates plan assignments against the roster instead of the agent whitelist", () => {
    const proposal = parseWorkspaceTaskGraphProposal(
      taggedPlan([node({ id: "build", kind: "implementation", participantId: "p2" })]),
      seats,
    );
    // The chair names a seat; the agent is derived from the kind so the
    // kind-based recovery rules keep their meaning.
    expect(proposal.nodes[0]).toMatchObject({ participantId: "p2", agent: "codex" });

    expect(() =>
      parseWorkspaceTaskGraphProposal(
        taggedPlan([node({ id: "build", kind: "implementation", participantId: "ghost" })]),
        seats,
      ),
    ).toThrow(/not a meeting seat/);
    expect(() =>
      parseWorkspaceTaskGraphProposal(
        taggedPlan([node({ id: "build", kind: "implementation" })]),
        seats,
      ),
    ).toThrow(/participantId/);
  });

  it("salvages loosely shaped follow-up nodes and keeps the verdict", () => {
    // The three shapes seats produced live, one per attempt, each of which
    // used to reject the whole receipt.
    const decision = parseWorkspaceValidationDecision(
      `<t3_validation>${JSON.stringify({
        verdict: "fail",
        confidence: "high",
        summary: "산출물 부재",
        evidence: ["귀속표 없음"],
        failureClassification: "validation",
        nextAction: "감사 완성",
        followUpNodes: [
          {
            id: "complete-audit",
            participantId: "p2",
            task: "미커밋 변경 전수 감사 산출물을 완성한다: (1) 귀속표, (2) 스위트 수치.",
            goal: "커밋 계획",
            context: "산출물이 저장소에 없음",
            constraints: ["읽기 전용"],
            successCriteria: ["전부 등장"],
            expectedOutput: "영수증",
          },
          {
            id: "recheck",
            kind: "validation",
            title: "재검증",
            participantId: "p2",
            description: "보완 증거를 다시 확인한다.",
            dependencies: ["complete-audit"],
            deliverable: "검증 영수증",
          },
          { id: "empty", participantId: "p2" },
          { id: "ghost", participantId: "nobody", task: "좌석 없는 작업" },
        ],
      })}</t3_validation>`,
      seats,
    );
    expect(decision.verdict).toBe("fail");
    expect(decision.followUpNodes.map((item) => item.id)).toEqual(["complete-audit", "recheck"]);
    expect(decision.followUpNodes[0]).toMatchObject({
      kind: "research",
      agent: "grok",
      participantId: "p2",
      title: "미커밋 변경 전수 감사 산출물을 완성한다",
      goal: "커밋 계획",
      constraints: ["읽기 전용"],
    });
    expect(decision.followUpNodes[1]).toMatchObject({
      kind: "research",
      task: "보완 증거를 다시 확인한다.",
      goal: "보완 증거를 다시 확인한다.",
      expectedOutput: "검증 영수증",
      dependsOn: ["complete-audit"],
    });
  });

  it("materializes a meeting plan without role bindings and seats the chair on the gates", () => {
    const seeded = buildMeetingSeededTaskGraph({
      task: "기능 구현",
      agreement: "## 회의 합의\n서버에 구현한다.",
      chairParticipantId: seats.chairParticipantId,
      occurredAt: "2026-08-17T00:00:00.000Z",
    });
    expect(seeded.nodes).toHaveLength(1);
    expect(seeded.nodes[0]).toMatchObject({
      id: "plan",
      status: "completed",
      participantId: "p1",
      output: "## 회의 합의\n서버에 구현한다.",
    });

    const graph = materializeWorkspaceTaskGraphPlan({
      graph: seeded,
      proposal: parseWorkspaceTaskGraphProposal(
        taggedPlan([
          node({ id: "research", kind: "research", participantId: "p1" }),
          node({ id: "build", kind: "implementation", participantId: "p2" }),
        ]),
        seats,
      ),
      bindings: [],
      meeting: seats,
      occurredAt: "2026-08-17T00:00:00.000Z",
    });
    expect(readyWorkspaceTaskNodes(graph).map((item) => item.id)).toEqual(["research", "build"]);
    expect(graph.nodes.find((item) => item.id === "build")?.participantId).toBe("p2");
    const gates = graph.nodes.filter((item) => item.kind === "validation");
    expect(gates).toHaveLength(2);
    expect(gates.every((item) => item.participantId === "p1")).toBe(true);
    expect(graph.nodes.find((item) => item.kind === "synthesis")?.participantId).toBe("p1");
  });

  it("keeps requiring role bindings when no meeting is attached", () => {
    const planned = {
      ...buildInitialWorkspaceTaskGraph("기능 구현"),
      nodes: buildInitialWorkspaceTaskGraph("기능 구현").nodes.map((item) => ({
        ...item,
        status: "completed" as const,
        output: "계획",
      })),
    };
    expect(() =>
      materializeWorkspaceTaskGraphPlan({
        graph: planned,
        proposal: parseWorkspaceTaskGraphProposal(taggedPlan([node({ id: "research" })])),
        bindings: [],
        occurredAt: "2026-08-17T00:00:00.000Z",
      }),
    ).toThrow(/binding/);
  });
});

describe("Workspace orchestra wave selection", () => {
  const taskNode = (id: string, kind: WorkspaceTaskNode["kind"]): WorkspaceTaskNode => ({
    id: WorkspaceTaskNodeId.make(id),
    order: 0,
    kind,
    agent: kind === "implementation" ? "codex" : "grok",
    role: kind === "implementation" ? "implementer" : "researcher",
    participantId: null,
    threadId: null,
    parkedQuestion: null,
    worktreePath: null,
    branch: null,
    title: id,
    handoff: {
      task: id,
      goal: id,
      context: "",
      input: "",
      constraints: [],
      expectedOutput: "결과",
      successCriteria: [],
    },
    dependsOn: [],
    validationTargetId: null,
    priority: 0,
    status: "queued",
    maxAttempts: 2,
    attempts: [],
    output: null,
    error: null,
    failureClassification: null,
    confidence: null,
    validation: null,
    startedAt: null,
    completedAt: null,
  });
  // Already in frontier order, the way readyWorkspaceTaskNodes hands it over.
  const ready = [
    taskNode("read-a", "research"),
    taskNode("write-b", "implementation"),
    taskNode("read-c", "research"),
    taskNode("write-d", "implementation"),
  ];

  it("fills the width in frontier order when writes may share a wave", () => {
    expect(selectGraphWaveNodes(ready, { width: 3, soloWrites: false }).map((n) => n.id)).toEqual([
      "read-a",
      "write-b",
      "read-c",
    ]);
  });

  it("keeps write nodes out of a shared wave until one leads the frontier", () => {
    expect(selectGraphWaveNodes(ready, { width: 3, soloWrites: true }).map((n) => n.id)).toEqual([
      "read-a",
      "read-c",
    ]);
    expect(
      selectGraphWaveNodes(ready.slice(1), { width: 3, soloWrites: true }).map((n) => n.id),
    ).toEqual(["write-b"]);
  });

  it("never returns an empty wave while the frontier has a write node", () => {
    const onlyWrites = ready.filter((n) => n.kind === "implementation");
    expect(
      selectGraphWaveNodes(onlyWrites, { width: 2, soloWrites: true }).map((n) => n.id),
    ).toEqual(["write-b"]);
    expect(selectGraphWaveNodes([], { width: 2, soloWrites: true })).toEqual([]);
  });
});

describe("Workspace orchestra write chains", () => {
  const chainNode = (input: {
    readonly id: string;
    readonly order: number;
    readonly kind: WorkspaceTaskNode["kind"];
    readonly dependsOn?: ReadonlyArray<string>;
    readonly validationTargetId?: string;
    readonly worktreePath?: string;
  }): WorkspaceTaskNode => ({
    id: WorkspaceTaskNodeId.make(input.id),
    order: input.order,
    kind: input.kind,
    agent: "codex",
    role: input.kind === "validation" ? "verifier" : "implementer",
    participantId: null,
    threadId: null,
    parkedQuestion: null,
    worktreePath: input.worktreePath ?? null,
    branch: null,
    title: input.id,
    handoff: {
      task: input.id,
      goal: input.id,
      context: "",
      input: "",
      constraints: [],
      expectedOutput: "결과",
      successCriteria: [],
    },
    dependsOn: (input.dependsOn ?? []).map((id) => WorkspaceTaskNodeId.make(id)),
    validationTargetId:
      input.validationTargetId === undefined
        ? null
        : WorkspaceTaskNodeId.make(input.validationTargetId),
    priority: 0,
    status: "queued",
    maxAttempts: 2,
    attempts: [],
    output: null,
    error: null,
    failureClassification: null,
    confidence: null,
    validation: null,
    startedAt: null,
    completedAt: null,
  });

  it("chains a write, its validation gate, and the dependent follow-up write", () => {
    const nodes = [
      chainNode({ id: "research", order: 0, kind: "research" }),
      chainNode({ id: "write-a", order: 1, kind: "implementation", dependsOn: ["research"] }),
      chainNode({
        id: "check-a",
        order: 2,
        kind: "validation",
        dependsOn: ["write-a"],
        validationTargetId: "write-a",
      }),
      chainNode({ id: "write-b", order: 3, kind: "debug", dependsOn: ["check-a"] }),
      chainNode({ id: "synthesize", order: 4, kind: "synthesis", dependsOn: ["write-b"] }),
    ];
    const chains = computeWriteChains(nodes);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.key).toBe("1");
    expect([...(chains[0]?.nodeIds ?? [])].toSorted()).toEqual(["check-a", "write-a", "write-b"]);
  });

  it("keeps independent writes in separate chains", () => {
    const nodes = [
      chainNode({ id: "write-a", order: 0, kind: "implementation" }),
      chainNode({ id: "write-b", order: 1, kind: "implementation" }),
      chainNode({
        id: "check-b",
        order: 2,
        kind: "validation",
        dependsOn: ["write-b"],
        validationTargetId: "write-b",
      }),
    ];
    const chains = computeWriteChains(nodes);
    expect(chains.map((chain) => chain.key)).toEqual(["0", "1"]);
    expect(chainKeyByNodeId(chains).get("check-b")).toBe("1");
  });

  it("leaves a validation of a read node out of every chain", () => {
    const nodes = [
      chainNode({ id: "research", order: 0, kind: "research" }),
      chainNode({
        id: "check-research",
        order: 1,
        kind: "validation",
        dependsOn: ["research"],
        validationTargetId: "research",
      }),
      chainNode({ id: "write-a", order: 2, kind: "implementation" }),
    ];
    const chains = computeWriteChains(nodes);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.nodeIds).toEqual(["write-a"]);
  });

  it("keeps the chain key stable while the graph grows", () => {
    const base = [
      chainNode({ id: "write-a", order: 1, kind: "implementation" }),
      chainNode({
        id: "check-a",
        order: 2,
        kind: "validation",
        dependsOn: ["write-a"],
        validationTargetId: "write-a",
      }),
    ];
    const before = computeWriteChains(base);
    const grown = [
      ...base,
      chainNode({ id: "write-fix", order: 7, kind: "debug", dependsOn: ["check-a"] }),
    ];
    const after = computeWriteChains(grown);
    expect(before[0]?.key).toBe("1");
    expect(after[0]?.key).toBe("1");
    expect(after[0]?.nodeIds).toContain("write-fix");
  });

  it("admits at most one node per chain into a shared wave", () => {
    // A planner diamond: two parallel writes in one chain must not edit the
    // same worktree at once, so the second waits for the next wave.
    const nodes = [
      chainNode({ id: "write-a", order: 0, kind: "implementation" }),
      chainNode({ id: "write-b", order: 1, kind: "implementation", dependsOn: ["write-a"] }),
      chainNode({ id: "write-c", order: 2, kind: "implementation", dependsOn: ["write-a"] }),
      chainNode({ id: "read-d", order: 3, kind: "research" }),
    ];
    const chains = computeWriteChains(nodes);
    expect(chains).toHaveLength(1);
    const wave = selectGraphWaveNodes([nodes[1]!, nodes[2]!, nodes[3]!], {
      width: 3,
      soloWrites: false,
      chainByNodeId: chainKeyByNodeId(chains),
    });
    expect(wave.map((node) => node.id)).toEqual(["write-b", "read-d"]);
  });
});

describe("Workspace node interruption budget", () => {
  const interrupted = `Collaboration turn 'turn-1' ${INTERRUPTED_TURN_ERROR_SUFFIX}`;
  /** Attempt history; the last entry is the attempt whose result is being applied. */
  const nodeWithAttempts = (errors: ReadonlyArray<string | null>): WorkspaceTaskNode => ({
    id: WorkspaceTaskNodeId.make("research"),
    order: 0,
    kind: "research",
    agent: "grok",
    role: "researcher",
    participantId: null,
    threadId: null,
    parkedQuestion: null,
    worktreePath: null,
    branch: null,
    title: "조사",
    handoff: {
      task: "조사",
      goal: "조사",
      context: "",
      input: "",
      constraints: [],
      expectedOutput: "결과",
      successCriteria: [],
    },
    dependsOn: [],
    validationTargetId: null,
    priority: 0,
    status: "running",
    maxAttempts: 2,
    attempts: errors.map((error, index) => ({
      number: index + 1,
      agent: "grok",
      role: "researcher",
      modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      strategy: "",
      threadId: ThreadId.make(`thread-${index}`),
      status: index === errors.length - 1 ? "running" : error === null ? "completed" : "failed",
      output: null,
      error,
      failureClassification: error === null ? null : "tool",
      confidence: null,
      startedAt: "2026-09-07T00:00:00.000Z",
      completedAt: null,
    })),
    output: null,
    error: null,
    failureClassification: null,
    confidence: null,
    validation: null,
    startedAt: "2026-09-07T00:00:00.000Z",
    completedAt: null,
  });

  it("grants one free retry after an interruption, then charges the next in a row", () => {
    expect(grantsFreeRetryAfterInterruption(nodeWithAttempts([null]))).toBe(true);
    expect(grantsFreeRetryAfterInterruption(nodeWithAttempts(["형식 오류", null]))).toBe(true);
    expect(grantsFreeRetryAfterInterruption(nodeWithAttempts([interrupted, null]))).toBe(false);
    expect(
      grantsFreeRetryAfterInterruption(nodeWithAttempts([interrupted, "형식 오류", null])),
    ).toBe(true);
  });
});
