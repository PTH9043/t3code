import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CanonicalWorkflowGraphFromPersistence,
  collectGraphReferentialIssues,
  extractForwardEdges,
  extractLoopBackEdges,
  upcastV1ToV2,
  WORKFLOW_SCHEMA_VERSION_V2,
  WorkflowDefinition,
  WorkflowEdgeId,
  WorkflowGraphV2,
  WorkflowGraphV2Draft,
  WorkflowLoopId,
  WorkflowNodeId,
} from "./workflowGraph.ts";

const decodePersistedJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(CanonicalWorkflowGraphFromPersistence),
);
const encodePersistedJson = Schema.encodeSync(
  Schema.fromJsonString(CanonicalWorkflowGraphFromPersistence),
);
const decodeV2 = Schema.decodeUnknownSync(WorkflowGraphV2);
const decodeV2Draft = Schema.decodeUnknownSync(WorkflowGraphV2Draft);

describe("workflowGraph v2 contract & deterministic v1 upcasting", () => {
  it("losslessly and deterministically upcasts real T3 v1 WorkflowDefinition JSON", () => {
    const t3V1 = Schema.decodeUnknownSync(WorkflowDefinition)({
      schemaVersion: 1,
      id: "feature",
      title: "기능 개발",
      description: "분석·실행·검증 근거를 남기는 재사용 작업 흐름",
      inputs: [
        { name: "goal", label: "작업 목표", type: "string", required: true, defaultValue: "" },
        {
          name: "targetPath",
          label: "대상 경로",
          type: "path",
          required: false,
          defaultValue: "apps/web",
        },
      ],
      nodes: [
        {
          id: "analyze",
          title: "요구와 근거 확인",
          kind: "orchestration",
          agent: "fable",
          participantId: null,
          task: "요구를 분석한다. 목표: {{goal}}",
          dependsOn: [],
          successCriteria: ["범위와 성공 기준이 명확하다."],
          skills: [],
        },
        {
          id: "execute",
          title: "작업 수행과 증거 확인",
          kind: "implementation",
          agent: "codex",
          participantId: "seat-worker",
          task: "구현한다. 경로: {{targetPath}}",
          dependsOn: ["analyze"],
          successCriteria: ["테스트가 통과한다."],
          skills: [],
        },
      ],
    });

    const first = decodePersistedJson(JSON.stringify(t3V1));
    const second = decodePersistedJson(JSON.stringify(t3V1));

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION_V2);
    expect(first.id).toBe("feature");
    expect(first.title).toBe("기능 개발");
    expect(first.inputs).toEqual([
      { key: "goal", label: "작업 목표", valueType: "string", required: true },
      {
        key: "targetPath",
        label: "대상 경로",
        valueType: "file_path",
        required: false,
        defaultValue: "apps/web",
      },
    ]);
    expect(first.nodes).toHaveLength(2);
    expect(first.nodes[0]).toMatchObject({
      id: "analyze",
      kind: "agent",
      capability: "deep-architect",
      isolation: "shared_write",
      cacheable: false,
      legacyKind: "orchestration",
      participantId: null,
      advisoryCriteria: ["범위와 성공 기준이 명확하다."],
    });
    expect(first.nodes[1]).toMatchObject({
      id: "execute",
      kind: "agent",
      capability: "code-surgeon",
      legacyKind: "implementation",
      participantId: "seat-worker",
    });
    expect(first.edges).toEqual([
      {
        id: "e_analyze__execute",
        from: "analyze",
        to: "execute",
        kind: "unconditional",
      },
    ]);
    expect(first.migrationProvenance).toEqual({
      migratedFromSchemaVersion: 1,
      unverifiedCriteriaNodeIds: ["analyze", "execute"],
    });

    // Re-encoding always persists canonical v2 JSON and round-trips identically.
    const reencoded = encodePersistedJson(first);
    expect(decodePersistedJson(reencoded)).toEqual(first);
  });

  it("upcasts lightweight external v1 WorkflowGraphV1 payloads including timeouts and retries", () => {
    const legacyV1 = {
      inputs: [
        "targetBranch",
        { key: "scope", label: "범위", required: false, defaultValue: "all" },
      ],
      nodes: [
        {
          id: "scan",
          label: "스캔",
          prompt: "Scan {{inputs.targetBranch}}",
          agent: "grok" as const,
          timeoutMs: 30_000,
          maxRetries: 2,
        },
        {
          id: "fix",
          title: "수정",
          prompt: "Fix issues",
          agent: "codex" as const,
          dependsOn: ["scan"],
          successCriteria: ["Zero errors"],
        },
      ],
    };

    const canonical = decodePersistedJson(JSON.stringify(legacyV1));
    expect(canonical.schemaVersion).toBe(2);
    expect(canonical.nodes[0]).toMatchObject({
      id: "scan",
      capability: "fast-scout",
      budget: { maxWallTimeMs: 30_000 },
      retryPolicy: { maxAttempts: 3, backoffStrategy: "exponential_jitter" },
    });
    expect(canonical.edges).toHaveLength(1);
    expect(canonical.migrationProvenance?.unverifiedCriteriaNodeIds).toEqual(["fix"]);
  });

  it("accepts all 7 v2 node kinds, bounded cyclic loops, and separates forward vs loop-back edges", () => {
    const v2Graph = decodeV2({
      schemaVersion: 2,
      inputs: [{ key: "goal", label: "목표", valueType: "string", required: true }],
      nodes: [
        {
          id: "plan",
          kind: "agent",
          title: "설계",
          joinPolicy: "all_succeeded",
          promptTemplate: "Plan {{inputs.goal}}",
          capability: "deep-architect",
          isolation: "shared_readonly",
          sideEffectPolicy: "pure_readonly",
          inputBindings: { goal: "{{inputs.goal}}" },
          advisoryCriteria: [],
          cleanContext: true,
          cacheable: true,
        },
        {
          id: "fanout",
          kind: "map_fanout",
          title: "병렬 수정",
          joinPolicy: "all_succeeded",
          itemsExpression: "{{nodes.plan.output.modules}}",
          itemVariableName: "module",
          maxFanOut: 8,
          concurrencyLimit: 4,
          isolationPerItem: "git_worktree",
          failurePolicy: "continue_and_collect",
          workerTemplate: {
            targetKind: "inline_agent",
            promptTemplate: "Implement {{module}}",
            capability: "code-surgeon",
          },
        },
        {
          id: "merge",
          kind: "reconcile_worktrees",
          title: "워크트리 병합",
          joinPolicy: "all_succeeded",
          sourceNodeIds: ["fanout"],
          strategy: "agent_assisted_conflict_resolve",
          conflictResolverCapability: "code-surgeon",
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
            timeoutMs: 120_000,
          },
        },
        {
          id: "route",
          kind: "router",
          title: "검증 분기",
          joinPolicy: "all_succeeded",
          mode: "deterministic_rules",
          routes: [
            { routeKey: "pass", conditionExpr: "$.nodes.verify.output.exitCode == 0" },
            { routeKey: "retry", conditionExpr: "$.nodes.verify.output.exitCode != 0" },
          ],
          defaultRouteKey: "retry",
        },
        {
          id: "approval",
          kind: "human_gate",
          title: "최종 승인",
          joinPolicy: "all_resolved_at_least_one_succeeded",
          instructions: "변경사항을 검토하고 승인하세요.",
          reviewTargets: ["{{nodes.merge.output.diffArtifact}}"],
          allowedActions: ["approve", "request_revision", "abort"],
          revisionTargetNodeId: "plan",
        },
        {
          id: "release",
          kind: "subworkflow",
          title: "배포 서브워크플로",
          joinPolicy: "all_succeeded",
          targetDefinitionId: "release-pipeline",
          pinnedRevision: 3,
          isolation: "shared_readonly",
          inputBindings: { goal: "{{inputs.goal}}" },
        },
      ],
      edges: [
        { id: "e1", from: "plan", to: "fanout", kind: "unconditional" },
        { id: "e2", from: "fanout", to: "merge", kind: "unconditional" },
        { id: "e3", from: "merge", to: "verify", kind: "unconditional" },
        { id: "e4", from: "verify", to: "route", kind: "unconditional" },
        { id: "e5", from: "route", to: "approval", kind: "route_match", routeKey: "pass" },
        { id: "e6", from: "approval", to: "release", kind: "unconditional" },
        { id: "e_loop", from: "route", to: "fanout", kind: "loop_back", loopId: "fix_loop" },
      ],
      loops: [
        {
          loopId: "fix_loop",
          entryNodeId: "fanout",
          exitNodeId: "route",
          maxIterations: 3,
          exitConditionExpr: "$.nodes.verify.output.exitCode == 0",
          stagnationDetection: { enabled: true, historyWindowSize: 2 },
          onExhausted: "interrupt_for_human",
        },
      ],
    });

    expect(extractForwardEdges(v2Graph)).toHaveLength(6);
    expect(extractLoopBackEdges(v2Graph).map((e) => e.id)).toEqual(["e_loop"]);
  });

  it("allows incomplete edits in WorkflowGraphV2Draft while rejecting broken references in WorkflowGraphV2", () => {
    const brokenDraft = decodeV2Draft({
      schemaVersion: 2,
      inputs: [],
      nodes: [
        {
          id: WorkflowNodeId.make("a"),
          kind: "agent",
          title: "Step A",
          joinPolicy: "all_succeeded",
          promptTemplate: "Do A",
          capability: "code-surgeon",
          isolation: "shared_write",
          sideEffectPolicy: "workspace_mutation",
          inputBindings: {},
          advisoryCriteria: [],
          cleanContext: true,
          cacheable: false,
        },
      ],
      edges: [
        {
          id: WorkflowEdgeId.make("bad_loop"),
          from: WorkflowNodeId.make("a"),
          to: WorkflowNodeId.make("missing"),
          kind: "loop_back",
          loopId: WorkflowLoopId.make("undeclared"),
        },
      ],
      loops: [],
    });

    const issues = collectGraphReferentialIssues(brokenDraft);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.join(" ")).toContain('missing target node "missing"');
    expect(issues.join(" ")).toContain('undeclared loopId "undeclared"');
    expect(() => decodeV2(brokenDraft)).toThrow();
  });

  it("preserves deterministic edge ids even when v1 upcast receives empty inputs", () => {
    const upcasted = upcastV1ToV2({
      nodes: [
        { id: "1-start", prompt: "Start", agent: "fable" },
        { id: "2-end", prompt: "End", agent: "codex", dependsOn: ["1-start"] },
      ],
    });
    expect(upcasted.edges[0]?.id).toBe("e_1-start__2-end");
  });
});
