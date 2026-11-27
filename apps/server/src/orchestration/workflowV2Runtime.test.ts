// @effect-diagnostics-next-line nodeBuiltinImport:off - Test fixture creates temporary local git repositories directly.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Test fixture manages temporary directories directly.
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Test fixture joins temporary paths directly.
import * as NodePath from "node:path";
import {
  ProjectId,
  ProviderInstanceId,
  WorkflowDefinition,
  WorkflowEdgeId,
  WorkflowGraphV2,
  WorkflowLoopId,
  WorkflowNodeId,
  WorkspaceCollaborationRunId,
  type WorkspaceCollaborationRun,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { lintWorkflowGraphV2, validateWorkflowGraphV2Topology } from "@t3tools/shared/workflow";
import {
  decodeCanonicalWorkflowGraph,
  encodeCanonicalWorkflowGraph,
} from "../persistence/WorkspaceWorkflowStore.ts";
import { compileWorkflowGraphV2, compileWorkflowRun } from "./workspaceWorkflow.ts";
import {
  buildGraphJobApplicationPreset,
  buildGraphPrReviewPreset,
  buildGraphSimplify3WayPreset,
  buildHumanGatePrompt,
  deduplicateReviewFindings,
  evaluateAdversarialVerifierOutcome,
  evaluateLoopTransition,
  evaluateRouterNode,
  evaluateWorkflowBudgetGuard,
  evaluateWorkflowCondition,
  expandMapFanOut,
  GRAPH_PR_REVIEW_DEFAULT_MAX_ROUNDS,
  interpolateWorkflowTemplate,
  parseStructuredReportFailures,
  planWorktreeReconcile,
  resolveCapabilitySelection,
  resolveHumanGateDecision,
  runDeterministicVerifier,
  runWorktreeReconcileStrict,
  tryExecuteWorkflowV2SpecialNode,
  type WorkflowEvaluationContext,
} from "./workflowV2Runtime.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      NodeFs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows handle release race
    }
  }
});

describe("WorkspaceWorkflowStore canonical v1/v2 persistence codec", () => {
  it("transparently decodes v1 WorkflowVersion JSON to validated WorkflowGraphV2 and round-trips", async () => {
    const v1Json = JSON.stringify({
      schemaVersion: 1,
      id: "bugfix-flow",
      title: "오류 수정",
      description: "재현 후 수정",
      inputs: [{ name: "goal", label: "목표", type: "string", required: true, defaultValue: "" }],
      nodes: [
        {
          id: "analyze",
          title: "분석",
          kind: "orchestration",
          agent: "fable",
          participantId: null,
          task: "원인 분석: {{goal}}",
          dependsOn: [],
          successCriteria: ["근본 원인 확인"],
          skills: [],
        },
        {
          id: "fix",
          title: "수정",
          kind: "implementation",
          agent: "codex",
          participantId: null,
          task: "수정 수행",
          dependsOn: ["analyze"],
          successCriteria: ["테스트 통과"],
          skills: [],
        },
      ],
      revision: 1,
      archived: false,
      digest: "abc123",
      createdAt: "2026-11-20T00:00:00.000Z",
    });

    const graph = await Effect.runPromise(decodeCanonicalWorkflowGraph(v1Json));
    expect(graph.schemaVersion).toBe(2);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.migrationProvenance?.migratedFromSchemaVersion).toBe(1);
    expect(graph.migrationProvenance?.unverifiedCriteriaNodeIds).toEqual(["analyze", "fix"]);

    const encoded = await Effect.runPromise(encodeCanonicalWorkflowGraph(graph));
    const redecoded = await Effect.runPromise(decodeCanonicalWorkflowGraph(encoded));
    expect(redecoded.schemaVersion).toBe(2);
    expect(redecoded.nodes.map((n) => n.id)).toEqual(["analyze", "fix"]);
  });
});

describe("workflowV2Runtime expressions, verifiers, router, loops, fanout, reconcile", () => {
  it("evaluates sandboxed expressions and interpolates templates", () => {
    const ctx: WorkflowEvaluationContext = {
      inputs: { targetBranch: "main", retries: 2 },
      nodes: {
        verify: {
          status: "completed",
          output: { passed: true, exitCode: 0, files: ["a.ts", "b.ts"] },
        },
      },
    };
    expect(
      evaluateWorkflowCondition(
        "$.nodes.verify.output.passed == true && $.nodes.verify.output.exitCode == 0",
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateWorkflowCondition(
        "$.nodes.verify.output.exitCode != 0 || $.inputs.retries >= 2",
        ctx,
      ),
    ).toBe(true);
    expect(evaluateWorkflowCondition("!$.nodes.verify.output.passed", ctx)).toBe(false);
    expect(evaluateWorkflowCondition("$.nodes.verify.output.files contains 'a.ts'", ctx)).toBe(
      true,
    );
    expect(
      interpolateWorkflowTemplate(
        "Branch={{inputs.targetBranch}} count={{nodes.verify.output.files.length}}",
        ctx,
      ),
    ).toBe("Branch=main count=2");
  });

  it("runs command_exit verifier and blocks cwdRelative path traversal", async () => {
    const dir = createTempDir("t3-wfv2-cmd-");
    const passResult = await Effect.runPromise(
      runDeterministicVerifier(
        {
          type: "command_exit",
          command: process.execPath,
          args: ["-e", "process.stdout.write('ok')"],
          timeoutMs: 5_000,
        },
        { cwd: dir, context: { inputs: {}, nodes: {} } },
      ),
    );
    expect(passResult.passed).toBe(true);
    expect(passResult.exitCode).toBe(0);
    expect(passResult.stdout).toBe("ok");

    const traversal = await Effect.runPromise(
      runDeterministicVerifier(
        {
          type: "command_exit",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwdRelative: "../../outside",
          timeoutMs: 5_000,
        },
        { cwd: dir, context: { inputs: {}, nodes: {} } },
      ),
    );
    expect(traversal.passed).toBe(false);
    expect(traversal.stderr).toContain("Path traversal blocked");
  });

  it("parses structured report formats (vitest_json, tsc_diagnostics, eslint_json, junit_xml, sarif)", () => {
    const vitestFailures = parseStructuredReportFailures(
      "vitest_json",
      JSON.stringify({
        testResults: [
          {
            name: "a.test.ts",
            assertionResults: [
              { status: "failed", fullName: "adds", failureMessages: ["expected 2"] },
            ],
          },
        ],
      }),
      10,
    );
    expect(vitestFailures).toHaveLength(1);
    expect(vitestFailures[0]?.file).toBe("a.test.ts");

    const tscFailures = parseStructuredReportFailures(
      "tsc_diagnostics",
      "src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      10,
    );
    expect(tscFailures).toHaveLength(1);
    expect(tscFailures[0]?.rule).toBe("TS2322");
    expect(tscFailures[0]?.line).toBe(12);

    const junitFailures = parseStructuredReportFailures(
      "junit_xml",
      `<testsuite><testcase name="x"><failure message="boom">trace</failure></testcase></testsuite>`,
      10,
    );
    expect(junitFailures).toHaveLength(1);
    expect(junitFailures[0]?.message).toBe("boom");
  });

  it("runs schema_assert verifier including disk path validation", async () => {
    const dir = createTempDir("t3-wfv2-schema-");
    NodeFs.writeFileSync(NodePath.join(dir, "exists.ts"), "export const x = 1;\n");
    const ctx: WorkflowEvaluationContext = {
      inputs: {},
      nodes: {
        scout: {
          output: { files: ["exists.ts"], count: 1 },
        },
      },
    };
    const ok = await Effect.runPromise(
      runDeterministicVerifier(
        {
          type: "schema_assert",
          targetExpression: "$.nodes.scout.output",
          jsonSchema: {
            type: "object",
            required: ["files", "count"],
            properties: {
              files: { type: "array", items: { type: "string" } },
              count: { type: "integer", minimum: 1 },
            },
          },
          verifyDiskPathsAtPointer: "/files",
        },
        { cwd: dir, context: ctx },
      ),
    );
    expect(ok.passed).toBe(true);

    const missing = await Effect.runPromise(
      runDeterministicVerifier(
        {
          type: "schema_assert",
          targetExpression: "$.nodes.scout.output",
          jsonSchema: { type: "object" },
          verifyDiskPathsAtPointer: "/files",
        },
        {
          cwd: dir,
          context: { inputs: {}, nodes: { scout: { output: { files: ["nope.ts"] } } } },
        },
      ),
    );
    expect(missing.passed).toBe(false);
    expect(missing.failures[0]?.rule).toBe("missing-disk-path");
  });

  it("runs git_diff_guard and detects forbidden paths and potential secrets", async () => {
    const repo = createTempDir("t3-wfv2-git-");
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "Tester"]);
    NodeFs.writeFileSync(NodePath.join(repo, "app.ts"), "export const a = 1;\n");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "init"]);

    // Modify file with fake AWS key prefix + forbidden .env file
    NodeFs.writeFileSync(
      NodePath.join(repo, "app.ts"),
      "export const k = 'AKIA1234567890ABCDEF';\n",
    );
    NodeFs.writeFileSync(NodePath.join(repo, ".env"), "SECRET=1\n");

    const guarded = await Effect.runPromise(
      runDeterministicVerifier(
        {
          type: "git_diff_guard",
          forbiddenPathGlobs: [".env", "**/.env"],
          blockPotentialSecrets: true,
        },
        { cwd: repo, context: { inputs: {}, nodes: {} } },
      ),
    );
    expect(guarded.passed).toBe(false);
    expect(guarded.failures.some((f) => f.rule === "forbidden-path")).toBe(true);
    expect(guarded.failures.some((f) => f.rule === "secret:aws-access-key")).toBe(true);
  });

  it("evaluates router rules, loop stagnation/exhaustion, human gate, fanout, and capability routing", () => {
    const routerDecision = evaluateRouterNode(
      {
        id: WorkflowNodeId.make("route"),
        kind: "router",
        title: "분기",
        joinPolicy: "all_succeeded",
        mode: "deterministic_rules",
        routes: [
          { routeKey: "pass", conditionExpr: "$.nodes.verify.output.passed == true" },
          { routeKey: "retry", conditionExpr: "$.nodes.verify.output.passed == false" },
        ],
        defaultRouteKey: "retry",
      },
      {
        edges: [
          {
            id: WorkflowEdgeId.make("e1"),
            from: WorkflowNodeId.make("route"),
            to: WorkflowNodeId.make("done"),
            kind: "route_match",
            routeKey: "pass",
          },
          {
            id: WorkflowEdgeId.make("e2"),
            from: WorkflowNodeId.make("route"),
            to: WorkflowNodeId.make("fix"),
            kind: "route_match",
            routeKey: "retry",
          },
        ],
      },
      { inputs: {}, nodes: { verify: { output: { passed: true } } } },
    );
    expect(routerDecision.selectedRouteKey).toBe("pass");
    expect(routerDecision.activeTargetNodeIds).toEqual(["done"]);
    expect(routerDecision.skippedTargetNodeIds).toEqual(["fix"]);

    const loopSpec = {
      loopId: WorkflowLoopId.make("fix-loop"),
      entryNodeId: WorkflowNodeId.make("fix"),
      exitNodeId: WorkflowNodeId.make("verify"),
      maxIterations: 3,
      exitConditionExpr: "$.nodes.verify.output.passed == true",
      stagnationDetection: { enabled: true, historyWindowSize: 3 },
      onExhausted: "interrupt_for_human" as const,
    };

    expect(
      evaluateLoopTransition({
        loop: loopSpec,
        currentIteration: 1,
        context: { inputs: {}, nodes: { verify: { output: { passed: false } } } },
        history: [
          { gitDiffHash: "h1", errorSignature: "errA" },
          { gitDiffHash: "h1", errorSignature: "errA" },
        ],
      }),
    ).toMatchObject({ action: "interrupt_for_human", reason: "stagnation_detected" });

    expect(
      evaluateLoopTransition({
        loop: loopSpec,
        currentIteration: 2,
        context: { inputs: {}, nodes: { verify: { output: { passed: true } } } },
        history: [{ gitDiffHash: "h1", errorSignature: "errA" }],
      }),
    ).toMatchObject({ action: "exit", reason: "exit_condition_met" });

    const gateNode = {
      id: WorkflowNodeId.make("approve"),
      kind: "human_gate" as const,
      title: "배포 승인",
      joinPolicy: "all_succeeded" as const,
      instructions: "{{inputs.env}} 배포 승인",
      reviewTargets: ["$.nodes.verify.output"],
      allowedActions: ["approve", "request_revision", "abort"] as const,
      revisionTargetNodeId: WorkflowNodeId.make("fix"),
    };
    const prompt = buildHumanGatePrompt(gateNode, {
      inputs: { env: "prod" },
      nodes: { verify: { output: { passed: true } } },
    });
    expect(prompt.instructions).toBe("prod 배포 승인");
    expect(resolveHumanGateDecision(gateNode, { action: "request_revision" })).toMatchObject({
      directive: "revise",
      targetNodeId: "fix",
    });

    const fanout = expandMapFanOut(
      {
        id: WorkflowNodeId.make("fanout"),
        kind: "map_fanout",
        title: "파일별 처리",
        joinPolicy: "all_succeeded",
        itemsExpression: "$.nodes.scout.output.files",
        itemVariableName: "file",
        maxFanOut: 2,
        concurrencyLimit: 2,
        isolationPerItem: "git_worktree",
        failurePolicy: "continue_and_collect",
        workerTemplate: {
          targetKind: "inline_agent",
          promptTemplate: "Refactor {{file}}",
          capability: "code-surgeon",
        },
      },
      { inputs: {}, nodes: { scout: { output: { files: ["a.ts", "b.ts", "c.ts"] } } } },
    );
    expect(fanout.totalItems).toBe(3);
    expect(fanout.truncated).toBe(true);
    expect(fanout.tasks.map((t) => t.prompt)).toEqual(["Refactor a.ts", "Refactor b.ts"]);

    const localRoute = resolveCapabilitySelection("adversarial-reviewer", {
      privacy: "local_only",
      excludeProviderFamilies: ["local-ollama"],
    });
    expect(localRoute.preferredProviders).toEqual(["local-exaone"]);
  });

  it("runs git merge-tree strict check and compiles + dispatches v2 verifier/router nodes", async () => {
    const repo = createTempDir("t3-wfv2-merge-");
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "Tester"]);
    NodeFs.writeFileSync(NodePath.join(repo, "base.txt"), "hello\n");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "base"]);
    const baseBranch = runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

    runGit(repo, ["checkout", "-b", "branch-a"]);
    NodeFs.writeFileSync(NodePath.join(repo, "a.txt"), "from a\n");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "a"]);

    runGit(repo, ["checkout", baseBranch]);
    runGit(repo, ["checkout", "-b", "branch-b"]);
    NodeFs.writeFileSync(NodePath.join(repo, "b.txt"), "from b\n");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "b"]);

    const cleanMerge = await Effect.runPromise(
      runWorktreeReconcileStrict({ cwd: repo, baseRef: "branch-a", headRef: "branch-b" }),
    );
    expect(cleanMerge.clean).toBe(true);
    expect(cleanMerge.treeOid).toMatch(/^[0-9a-f]{40}$/i);

    const reconcilePlan = planWorktreeReconcile(
      {
        id: WorkflowNodeId.make("merge"),
        kind: "reconcile_worktrees",
        title: "병합",
        joinPolicy: "all_succeeded",
        sourceNodeIds: [WorkflowNodeId.make("a"), WorkflowNodeId.make("b")],
        strategy: "git_merge_tree_strict",
      },
      { edges: [] },
      { a: "branch-a", b: "branch-b" },
    );
    expect(reconcilePlan.commits).toHaveLength(2);

    const graphV2 = Schema.decodeUnknownSync(WorkflowGraphV2)({
      schemaVersion: 2,
      id: "verify-and-route",
      title: "검증-분기 파이프라인",
      inputs: [{ key: "goal", label: "목표", valueType: "string", required: true }],
      nodes: [
        {
          id: "check",
          kind: "verifier",
          title: "노드 명령 검증",
          joinPolicy: "all_succeeded",
          isolation: "shared_readonly",
          verifier: {
            type: "command_exit",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            timeoutMs: 5_000,
          },
        },
        {
          id: "decide",
          kind: "router",
          title: "결과 분기",
          joinPolicy: "all_succeeded",
          mode: "deterministic_rules",
          routes: [
            { routeKey: "ok", conditionExpr: "$.nodes.check.output.passed == true" },
            { routeKey: "fail", conditionExpr: "$.nodes.check.output.passed == false" },
          ],
          defaultRouteKey: "fail",
        },
        {
          id: "finish",
          kind: "agent",
          title: "완료 정리",
          joinPolicy: "all_succeeded",
          promptTemplate: "완료 정리: {{inputs.goal}}",
          capability: "deep-architect",
          isolation: "shared_readonly",
          sideEffectPolicy: "pure_readonly",
          inputBindings: { goal: "{{inputs.goal}}" },
          advisoryCriteria: [],
          cleanContext: true,
          cacheable: true,
        },
      ],
      edges: [
        { id: "e1", from: "check", to: "decide", kind: "unconditional" },
        { id: "e2", from: "decide", to: "finish", kind: "route_match", routeKey: "ok" },
      ],
      loops: [],
    });

    const def = Schema.decodeUnknownSync(WorkflowDefinition)({
      schemaVersion: 1,
      id: "verify-and-route",
      title: "검증-분기 파이프라인",
      description: "v2 테스트",
      inputs: [{ name: "goal", label: "목표", type: "string", required: true, defaultValue: "" }],
      nodes: [
        {
          id: "check",
          title: "노드 명령 검증",
          kind: "debug",
          agent: "codex",
          participantId: null,
          task: "check",
          dependsOn: [],
          successCriteria: [],
          skills: [],
        },
      ],
      graphV2,
    });

    const run = {
      id: WorkspaceCollaborationRunId.make("run-v2-1"),
      projectId: ProjectId.make("proj-1"),
      task: "검증 파이프라인 실행",
      status: "running",
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
      error: null,
      meeting: null,
      graph: null,
      workflow: {
        definitionId: def.id,
        definitionRevision: 1,
        definitionDigest: "digest",
        title: def.title,
        values: { goal: "출시 준비" },
        nodeSkills: [],
        control: "active",
        controlRevision: 0,
        updatedAt: "2026-11-20T00:00:00.000Z",
        requestDigest: "req",
        definition: {
          ...def,
          revision: 1,
          archived: false,
          digest: "digest",
          createdAt: "2026-11-20T00:00:00.000Z",
        },
        roleBindings: [
          {
            role: "coordinator",
            enabled: true,
            modelSelection: {
              provider: "claudeAgent",
              instanceId: ProviderInstanceId.make("claude"),
              model: "claude-sonnet-4-6",
            },
          },
          {
            role: "implementer",
            enabled: true,
            modelSelection: {
              provider: "codex",
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
            },
          },
          {
            role: "researcher",
            enabled: true,
            modelSelection: {
              provider: "grok",
              instanceId: ProviderInstanceId.make("grok"),
              model: "grok-4",
            },
          },
        ],
      },
    } as unknown as WorkspaceCollaborationRun;

    const compiled = compileWorkflowRun(run);
    expect(compiled.nodes.map((n) => n.id)).toContain("check");
    expect(compiled.nodes.map((n) => n.id)).toContain("decide");
    expect(compiled.nodes.map((n) => n.id)).toContain("finish");

    const compiledDirect = compileWorkflowGraphV2(graphV2, run);
    expect(compiledDirect.nodes.find((n) => n.id === "finish")?.handoff.task).toBe(
      "완료 정리: 출시 준비",
    );

    const checkExec = await Effect.runPromise(
      tryExecuteWorkflowV2SpecialNode({
        graphV2,
        nodeId: "check",
        cwd: repo,
        workflowValues: { goal: "출시 준비" },
        nodeOutputs: [],
      }),
    );
    expect(checkExec.handled).toBe(true);
    if (checkExec.handled) {
      expect(checkExec.passed).toBe(true);
      const routerExec = await Effect.runPromise(
        tryExecuteWorkflowV2SpecialNode({
          graphV2,
          nodeId: "decide",
          cwd: repo,
          workflowValues: { goal: "출시 준비" },
          nodeOutputs: [{ id: "check", status: "completed", output: checkExec.output }],
        }),
      );
      expect(routerExec.handled).toBe(true);
      if (routerExec.handled) {
        expect(JSON.parse(routerExec.output)).toMatchObject({
          selectedRouteKey: "ok",
          activeTargetNodeIds: ["finish"],
        });
      }
    }
  });

  it("evaluates WorkflowBudgetGuard soft 80% downgrade and hard 100% pause", () => {
    const policy = {
      maxTotalTokens: 100_000,
      softThresholdRatio: 0.8,
      onHardExceeded: "pause_run" as const,
    };

    const ok = evaluateWorkflowBudgetGuard({
      policy,
      currentCapability: "deep-architect",
      spentTokens: 50_000,
    });
    expect(ok.state).toBe("ok");
    expect(ok.recommendedActions).toEqual([]);

    const soft = evaluateWorkflowBudgetGuard({
      policy,
      currentCapability: "deep-architect",
      spentTokens: 82_000,
    });
    expect(soft.state).toBe("soft_limit");
    expect(soft.downgradedCapability).toBe("code-surgeon");
    expect(soft.recommendedActions).toEqual(["compact_context", "downgrade_capability"]);

    const hard = evaluateWorkflowBudgetGuard({
      policy,
      currentCapability: "code-surgeon",
      spentTokens: 105_000,
    });
    expect(hard.state).toBe("hard_limit");
    expect(hard.recommendedActions).toEqual(["pause_run"]);
  });

  it("deduplicates overlapping review findings within ±3 lines and preserves distinct lines", () => {
    const merged = deduplicateReviewFindings([
      {
        file: "./apps\\server\\src\\ws.ts",
        line: 42,
        severity: "medium",
        category: "static_code",
        title: "Missing workspace boundary check",
        detail: "Path check skips secondary roots.",
        reviewer: "review_logic",
      },
      {
        file: "apps/server/src/ws.ts",
        line: 45,
        severity: "high",
        category: "runtime_behavior",
        title: "Path traversal on asset URL",
        detail: "Outside path can escape root.",
        reviewer: "review_security",
        suggestedFix: "Validate against resolveRegisteredWorkspaceRootForAssetPath.",
      },
      {
        file: "apps/server/src/ws.ts",
        line: 80,
        severity: "low",
        title: "Redundant allocation",
        detail: "Unused temporary array.",
        reviewer: "review_logic",
      },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      file: "apps/server/src/ws.ts",
      line: 42,
      mergedLines: [42, 45],
      severity: "high",
      category: "runtime_behavior",
      title: "Path traversal on asset URL",
      reviewers: ["review_logic", "review_security"],
    });
    expect(merged[0]?.details).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      file: "apps/server/src/ws.ts",
      line: 80,
      severity: "low",
    });
  });

  it("never downgrades null, timed-out, or malformed verifier outputs to REJECT", () => {
    const firstNull = evaluateAdversarialVerifierOutcome({
      rawVerdict: null,
      checkCategory: "static_code",
      attempt: 1,
    });
    expect(firstNull.verdict).toBe("UNVERIFIED_ERROR");
    expect(firstNull.action).toBe("retry");

    const exhaustedTimeout = evaluateAdversarialVerifierOutcome({
      rawVerdict: "REJECT",
      timedOut: true,
      checkCategory: "runtime_behavior",
      attempt: 2,
      maxRetries: 1,
    });
    expect(exhaustedTimeout.verdict).toBe("UNVERIFIED_ERROR");
    expect(exhaustedTimeout.action).toBe("keep_unverified");
    expect(exhaustedTimeout.requiresRuntimeVerification).toBe(true);

    const runtimeWithoutEvidence = evaluateAdversarialVerifierOutcome({
      rawVerdict: "CONFIRM",
      checkCategory: "runtime_behavior",
      attempt: 1,
      hasRuntimeEvidence: false,
    });
    expect(runtimeWithoutEvidence.verdict).toBe("CONFIRM");
    expect(runtimeWithoutEvidence.requiresRuntimeVerification).toBe(true);

    const staticRejected = evaluateAdversarialVerifierOutcome({
      rawVerdict: "reject",
      checkCategory: "static_code",
      attempt: 1,
    });
    expect(staticRejected.verdict).toBe("REJECT");
    expect(staticRejected.action).toBe("reject");
  });

  it("builds valid, zero-warning PR Review and Simplify 3-Way WorkflowGraphV2 presets", () => {
    const prPreset = buildGraphPrReviewPreset();
    expect(validateWorkflowGraphV2Topology(prPreset).valid).toBe(true);
    const prLint = lintWorkflowGraphV2(prPreset);
    expect(prLint.valid).toBe(true);
    expect(prLint.errorCount).toBe(0);
    expect(prLint.warningCount).toBe(0);
    expect(prPreset.loops[0]).toMatchObject({
      maxIterations: GRAPH_PR_REVIEW_DEFAULT_MAX_ROUNDS,
      stagnationDetection: { enabled: true, historyWindowSize: 3 },
      onExhausted: "interrupt_for_human",
    });

    const simplifyPreset = buildGraphSimplify3WayPreset();
    expect(validateWorkflowGraphV2Topology(simplifyPreset).valid).toBe(true);
    const simplifyLint = lintWorkflowGraphV2(simplifyPreset);
    expect(simplifyLint.valid).toBe(true);
    expect(simplifyLint.errorCount).toBe(0);
    expect(simplifyLint.warningCount).toBe(0);
    expect(simplifyPreset.nodes.filter((n) => n.id.startsWith("review_"))).toHaveLength(3);

    const jobPreset = buildGraphJobApplicationPreset();
    expect(validateWorkflowGraphV2Topology(jobPreset).valid).toBe(true);
    const jobLint = lintWorkflowGraphV2(jobPreset);
    expect(jobLint.valid).toBe(true);
    expect(jobLint.errorCount).toBe(0);
    expect(jobLint.warningCount).toBe(0);
    expect(jobPreset.loops[0]).toMatchObject({
      loopId: "job_draft_review_loop",
      maxIterations: 3,
      stagnationDetection: { enabled: true, historyWindowSize: 3 },
      onExhausted: "interrupt_for_human",
    });
  });
});
