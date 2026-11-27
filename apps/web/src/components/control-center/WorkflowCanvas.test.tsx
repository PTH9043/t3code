import { WorkflowDefinition, WorkflowGraphV2 } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import WorkflowCanvas from "./WorkflowCanvas";

const sampleV1 = Schema.decodeUnknownSync(WorkflowDefinition)({
  schemaVersion: 1,
  id: "sample-v1",
  title: "기본 흐름",
  description: "분석 후 구현",
  inputs: [{ name: "goal", label: "목표", type: "string", required: true, defaultValue: "" }],
  nodes: [
    {
      id: "analyze",
      title: "분석 단계",
      kind: "orchestration",
      agent: "fable",
      participantId: null,
      task: "분석 {{goal}}",
      dependsOn: [],
      successCriteria: ["원인 확인"],
      skills: [],
    },
    {
      id: "implement",
      title: "구현 단계",
      kind: "implementation",
      agent: "codex",
      participantId: null,
      task: "구현 {{goal}}",
      dependsOn: ["analyze"],
      successCriteria: ["테스트 통과"],
      skills: [],
    },
  ],
});

describe("WorkflowCanvas v2 rendering & static linter", () => {
  it("auto-upcasts v1 definitions to v2 canvas and surfaces advisory criteria lint info", () => {
    const html = renderToStaticMarkup(
      <WorkflowCanvas definition={sampleV1} selectedId="analyze" onSelect={() => {}} />,
    );
    expect(html).toContain("그래프 v2");
    expect(html).toContain("분석 단계");
    expect(html).toContain("구현 단계");
    expect(html).toContain("에이전트");
    expect(html).toContain("정적 린터 진단");
    expect(html).toContain("결정론적 Verifier 노드를 연결");
  });

  it("renders native v2 nodes (verifier, router, human_gate, loop_back) and loop badge cleanly", () => {
    const graphV2 = Schema.decodeUnknownSync(WorkflowGraphV2)({
      schemaVersion: 2,
      id: "v2-loop",
      title: "자율 수리 루프",
      inputs: [],
      nodes: [
        {
          id: "fix",
          kind: "agent",
          title: "코드 수정",
          joinPolicy: "all_succeeded",
          promptTemplate: "수정",
          capability: "code-surgeon",
          isolation: "git_worktree",
          sideEffectPolicy: "workspace_mutation",
          inputBindings: {},
          advisoryCriteria: [],
          cleanContext: true,
          cacheable: false,
        },
        {
          id: "verify",
          kind: "verifier",
          title: "테스트 검증",
          joinPolicy: "all_succeeded",
          isolation: "shared_readonly",
          verifier: {
            type: "command_exit",
            command: "vp",
            args: ["test", "run"],
            timeoutMs: 60_000,
          },
        },
        {
          id: "gate",
          kind: "human_gate",
          title: "최종 승인",
          joinPolicy: "all_succeeded",
          instructions: "변경 검토",
          reviewTargets: ["$.nodes.verify.output"],
          allowedActions: ["approve", "abort"],
        },
      ],
      edges: [
        { id: "e1", from: "fix", to: "verify", kind: "unconditional" },
        {
          id: "e2",
          from: "verify",
          to: "gate",
          kind: "conditional",
          conditionExpr: "$.nodes.verify.output.passed == true",
        },
        { id: "e3", from: "verify", to: "fix", kind: "loop_back", loopId: "repair-loop" },
      ],
      loops: [
        {
          loopId: "repair-loop",
          entryNodeId: "fix",
          exitNodeId: "verify",
          maxIterations: 4,
          exitConditionExpr: "$.nodes.verify.output.passed == true",
          stagnationDetection: { enabled: true, historyWindowSize: 3 },
          onExhausted: "interrupt_for_human",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <WorkflowCanvas
        definition={sampleV1}
        graph={graphV2}
        selectedId="verify"
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("검증기");
    expect(html).toContain("승인 게이트");
    expect(html).toContain("루프 ≤4");
    expect(html).toContain("reconcile_worktrees");
  });
});
