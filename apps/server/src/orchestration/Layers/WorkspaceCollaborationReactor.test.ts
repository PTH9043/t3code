import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkspaceCollaborationRunId,
  WorkspaceScheduleId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type WorkspaceCollaborationRun,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { expect, it } from "vite-plus/test";

import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { WorkspaceCollaborationReactor } from "../Services/WorkspaceCollaborationReactor.ts";
import { OrchestrationTurnWaitLive } from "./OrchestrationTurnWait.ts";
import { WorkspaceCollaborationReactorLive } from "./WorkspaceCollaborationReactor.ts";

function responseForGraphPrompt(prompt: string): string {
  if (prompt.includes("Return one strict receipt between <t3_validation>")) {
    if (prompt.includes("Node: validate-build\n")) {
      return `<t3_validation>${JSON.stringify({
        verdict: "fail",
        confidence: "high",
        summary: "구현 검증에서 회귀가 발견되었다.",
        evidence: ["집중 테스트 실패"],
        failureClassification: "implementation",
        nextAction: "Codex 디버그 경로 추가",
        followUpNodes: [
          {
            id: "fix-build",
            kind: "debug",
            agent: "codex",
            title: "회귀 원인 수정",
            task: "실패한 테스트의 원인을 찾아 수정한다.",
            goal: "검증 가능한 제어 센터 구현",
            context: "구현 검증 실패",
            input: "집중 테스트 실패",
            constraints: ["이전 접근법을 그대로 반복하지 않음"],
            expectedOutput: "수정 및 재검증 결과",
            successCriteria: ["집중 테스트 통과"],
            dependsOn: [],
            priority: 3,
          },
        ],
      })}</t3_validation>`;
    }
    return `<t3_validation>${JSON.stringify({
      verdict: "pass",
      confidence: "high",
      summary: "성공 기준과 근거를 독립적으로 확인했다.",
      evidence: ["집중 검증 통과"],
      failureClassification: null,
      nextAction: "최종 종합",
      followUpNodes: [],
    })}</t3_validation>`;
  }
  if (prompt.includes("Return one strict payload between <t3_synthesis>")) {
    if (prompt.includes("Node: synthesize-2\n")) {
      return `<t3_synthesis>${JSON.stringify({
        finalOutput: "검증 결과 사이에 해결되지 않은 충돌이 있다.",
        confidence: "low",
        conflictDetected: true,
        nextAction: "Grok 독립 조사로 충돌 교차 검증",
        repairApproved: null,
        memoryCandidates: [],
      })}</t3_synthesis>`;
    }
    return `<t3_synthesis>${JSON.stringify({
      finalOutput: "검증된 제어 센터 구현 완료",
      confidence: "high",
      conflictDetected: false,
      nextAction: "사용자에게 검증된 결과 전달",
      repairApproved: null,
      memoryCandidates: [
        {
          category: "user-workflow",
          title: "제어 센터 검증 절차",
          content: "병렬 조사와 구현 결과를 각각 검증한 후 종합한다.",
          tags: ["verified"],
          confidence: "high",
          sourceNodeIds: ["research", "fix-build"],
        },
      ],
    })}</t3_synthesis>`;
  }
  if (prompt.includes("Return one strict machine-readable proposal between <t3_task_graph>")) {
    if (prompt.includes("검증된 결과 사이의 충돌")) {
      return `<t3_task_graph>${JSON.stringify({
        summary: "충돌한 결과를 독립적인 현재 자료로 교차 검증한다.",
        nextAction: "Grok 교차 조사",
        nodes: [
          {
            id: "conflict-check",
            kind: "research",
            agent: "grok",
            title: "결과 충돌 교차 조사",
            task: "충돌한 결과의 원출처를 독립적으로 확인한다.",
            goal: "최종 결론의 신뢰도 회복",
            context: "검증된 결과 간 충돌",
            input: "충돌 요약",
            constraints: ["원출처 우선"],
            expectedOutput: "충돌 해소 근거",
            successCriteria: ["충돌 원인이 설명된다"],
            dependsOn: [],
            priority: 4,
          },
        ],
      })}</t3_task_graph>`;
    }
    if (prompt.includes("Node: replan-")) {
      return `<t3_task_graph>${JSON.stringify({
        summary: "실패한 구현을 반복하지 않고 디버그 경로로 교체한다.",
        nextAction: "Codex 디버그 실행",
        nodes: [
          {
            id: "fix-build",
            kind: "debug",
            agent: "codex",
            title: "회귀 원인 수정",
            task: "실패한 테스트의 원인을 찾아 수정한다.",
            goal: "검증 가능한 제어 센터 구현",
            context: "구현 검증 실패",
            input: "집중 테스트 실패",
            constraints: ["이전 접근법을 그대로 반복하지 않음"],
            expectedOutput: "수정 및 재검증 결과",
            successCriteria: ["집중 테스트 통과"],
            dependsOn: [],
            priority: 3,
          },
        ],
      })}</t3_task_graph>`;
    }
    return `<t3_task_graph>${JSON.stringify({
      summary: "조사와 구현을 병렬로 수행한 뒤 각각 검증한다.",
      nextAction: "조사와 구현 병렬 실행",
      nodes: [
        {
          id: "research",
          kind: "research",
          agent: "grok",
          title: "현재 자료 조사",
          task: "현재 자료를 조사한다.",
          goal: "구현 근거 확보",
          context: "사용자 요청",
          input: "제어 센터 요구사항",
          constraints: ["현재 자료만 사용"],
          expectedOutput: "근거 요약",
          successCriteria: ["출처가 명확하다"],
          dependsOn: [],
          priority: 2,
        },
        {
          id: "build",
          kind: "implementation",
          agent: "codex",
          title: "제어 센터 구현",
          task: "제어 센터를 구현한다.",
          goal: "사용자 요청 충족",
          context: "Workspace 코드",
          input: "제어 센터 요구사항",
          constraints: ["집중 테스트 추가"],
          expectedOutput: "구현 및 테스트 결과",
          successCriteria: ["타입 검사 통과"],
          dependsOn: [],
          priority: 1,
        },
      ],
    })}</t3_task_graph>`;
  }
  return prompt.includes("Agent: GROK")
    ? "현재 자료와 근거를 조사했다."
    : "구현과 집중 테스트를 완료했다.";
}

it("preempts work, reroutes tools, revises failures and conflicts, and completes", async () => {
  const projectId = ProjectId.make("workspace-a");
  const runId = WorkspaceCollaborationRunId.make("run-a");
  const initialRun: WorkspaceCollaborationRun = {
    id: runId,
    projectId,
    source: "user",
    scheduleId: null,
    incidentId: null,
    task: "Build the requested control center",
    status: "queued",
    steps: [],
    graph: null,
    finalOutput: null,
    error: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
  const scheduledRun: WorkspaceCollaborationRun = {
    id: WorkspaceCollaborationRunId.make("scheduled-run-a"),
    projectId,
    source: "schedule",
    scheduleId: WorkspaceScheduleId.make("schedule-a"),
    incidentId: null,
    task: "Lower-priority scheduled task",
    status: "queued",
    steps: [],
    graph: null,
    finalOutput: null,
    error: null,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
  const runRef = await Effect.runPromise(Ref.make(initialRun));
  const scheduledRunRef = await Effect.runPromise(Ref.make(scheduledRun));
  const threadsRef = await Effect.runPromise(Ref.make(new Map<string, OrchestrationThread>()));
  const promptsRef = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]));
  const capturedMemoryRef = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]));
  const dispatchedTypesRef = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]));
  let sequence = 0;

  const dispatch: OrchestrationEngineShape["dispatch"] = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      sequence += 1;
      yield* Ref.update(dispatchedTypesRef, (types) => [...types, command.type]);
      switch (command.type) {
        case "project.collaboration.run.update":
          if (command.run.id === scheduledRun.id) {
            yield* Ref.set(scheduledRunRef, command.run);
          } else {
            yield* Ref.set(runRef, command.run);
          }
          break;
        case "project.collaboration.run.cancel":
          if (command.runId === scheduledRun.id) {
            yield* Ref.update(
              scheduledRunRef,
              (run): WorkspaceCollaborationRun => ({
                ...run,
                status: run.status === "queued" ? "cancelled" : "cancel-requested",
                updatedAt: command.createdAt,
              }),
            );
          }
          break;
        case "thread.create":
          yield* Ref.update(threadsRef, (current) => {
            const next = new Map(current);
            next.set(command.threadId, {
              id: command.threadId,
              projectId: command.projectId,
              title: command.title,
              modelSelection: command.modelSelection,
              runtimeMode: command.runtimeMode,
              interactionMode: command.interactionMode,
              branch: null,
              worktreePath: null,
              latestTurn: null,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              deletedAt: null,
              messages: [],
              proposedPlans: [],
              activities: [],
              checkpoints: [],
              session: null,
            });
            return next;
          });
          break;
        case "thread.turn.start": {
          const simulatedToolFailure =
            command.modelSelection?.instanceId === "codex-work" &&
            command.message.text.includes("Node: build\n");
          yield* Ref.update(promptsRef, (current) => [...current, command.message.text]);
          yield* Ref.update(threadsRef, (current) => {
            const existing = current.get(command.threadId)!;
            const next = new Map(current);
            const turnId = TurnId.make(`turn-${command.threadId}`);
            const assistantMessageId = MessageId.make(`assistant-${command.threadId}`);
            next.set(command.threadId, {
              ...existing,
              latestTurn: {
                turnId,
                state: simulatedToolFailure ? "error" : "completed",
                requestedAt: command.createdAt,
                startedAt: command.createdAt,
                completedAt: command.createdAt,
                assistantMessageId,
              },
              updatedAt: command.createdAt,
              messages: [
                {
                  id: command.message.messageId,
                  role: "user",
                  text: command.message.text,
                  attachments: [],
                  turnId,
                  streaming: false,
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                },
                {
                  id: assistantMessageId,
                  role: "assistant",
                  text: simulatedToolFailure
                    ? "Primary Codex tool failed."
                    : responseForGraphPrompt(command.message.text),
                  attachments: [],
                  turnId,
                  streaming: false,
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                },
              ],
            });
            return next;
          });
          break;
        }
        case "project.knowledge.item.upsert":
          expect(command.projectId).toBe(projectId);
          expect(command.kind).toBe("long-term-memory");
          expect(command.content).toContain("병렬 조사와 구현 결과");
          yield* Ref.update(capturedMemoryRef, (titles) => [...titles, command.title]);
          break;
        default:
          break;
      }
      return { sequence };
    });

  const engine: OrchestrationEngineShape = {
    dispatch,
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  };
  const repository = {
    upsert: (run: WorkspaceCollaborationRun) =>
      run.id === scheduledRun.id ? Ref.set(scheduledRunRef, run) : Ref.set(runRef, run),
    requestCancel: () => Effect.void,
    getById: ({ projectId: requestedProjectId, runId: requestedRunId }) =>
      Effect.all([Ref.get(runRef), Ref.get(scheduledRunRef)]).pipe(
        Effect.map(([userRun, scheduleRun]) => {
          const run = [userRun, scheduleRun].find(
            (candidate) =>
              candidate.projectId === requestedProjectId && candidate.id === requestedRunId,
          );
          return run === undefined ? Option.none() : Option.some(run);
        }),
      ),
    list: (input) =>
      Effect.all([Ref.get(runRef), Ref.get(scheduledRunRef)]).pipe(
        Effect.map(([userRun, scheduleRun]) =>
          [userRun, scheduleRun].filter(
            (run) =>
              run.projectId === input.projectId &&
              (input.statuses === undefined || input.statuses.includes(run.status)),
          ),
        ),
      ),
    listResumable: () => Effect.all([Ref.get(scheduledRunRef), Ref.get(runRef)]),
  } satisfies ProjectionWorkspaceCollaborationRunRepository["Service"];
  const query = {
    listWorkspaceAgentRoles: () =>
      Effect.succeed({
        roles: [
          {
            projectId,
            role: "coordinator" as const,
            displayName: "Fable",
            modelSelection: {
              instanceId: ProviderInstanceId.make("fable-work"),
              model: "claude-sonnet",
            },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            instructions: "Coordinate this Workspace only.",
            enabled: true,
            updatedAt: "2026-08-08T00:00:00.000Z",
          },
          {
            projectId,
            role: "researcher" as const,
            displayName: "Grok",
            modelSelection: {
              instanceId: ProviderInstanceId.make("grok-work"),
              model: "grok-current",
            },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            instructions: "Research current evidence.",
            enabled: true,
            updatedAt: "2026-08-08T00:00:00.000Z",
          },
          {
            projectId,
            role: "implementer" as const,
            displayName: "Codex",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-work"),
              model: "gpt-5",
            },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            instructions: "Implement and test in this Workspace.",
            enabled: true,
            updatedAt: "2026-08-08T00:00:00.000Z",
          },
        ],
      }),
    composeWorkspacePrompt: () =>
      Effect.succeed({
        prompt: "Workspace ID: workspace-a\nCurrent user task: build it",
        sourceItemIds: [],
        ragMatches: [],
        truncated: false,
      }),
    getThreadDetailById: (threadId: ThreadId) =>
      Ref.get(threadsRef).pipe(
        Effect.map((threads) => Option.fromNullishOr(threads.get(threadId))),
      ),
  } as unknown as ProjectionSnapshotQueryShape;
  const providerInstances = [
    {
      instanceId: ProviderInstanceId.make("fable-work"),
      driverKind: "claude",
      enabled: true,
    },
    {
      instanceId: ProviderInstanceId.make("grok-work"),
      driverKind: "grok",
      enabled: true,
    },
    {
      instanceId: ProviderInstanceId.make("codex-work"),
      driverKind: "codex",
      enabled: true,
    },
    {
      instanceId: ProviderInstanceId.make("codex-backup"),
      driverKind: "codex",
      enabled: true,
    },
  ] as unknown as ReadonlyArray<ProviderInstance>;
  const providerRegistry = {
    getInstance: (instanceId: ProviderInstanceId) =>
      Effect.succeed(providerInstances.find((instance) => instance.instanceId === instanceId)),
    listInstances: Effect.succeed(providerInstances),
  } as unknown as ProviderInstanceRegistry["Service"];
  const layer = WorkspaceCollaborationReactorLive.pipe(
    Layer.provideMerge(OrchestrationTurnWaitLive),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
    Layer.provideMerge(Layer.succeed(ProjectionWorkspaceCollaborationRunRepository, repository)),
    Layer.provideMerge(Layer.succeed(ProviderInstanceRegistry, providerRegistry)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const scope = await Effect.runPromise(Scope.make("sequential"));

  try {
    const reactor = await runtime.runPromise(Effect.service(WorkspaceCollaborationReactor));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(reactor.drain);

    const run = await Effect.runPromise(Ref.get(runRef));
    expect(run.status).toBe("completed");
    expect(run.graph?.status).toBe("completed");
    expect(run.graph?.overallConfidence).toBe("high");
    expect(run.graph?.nodes.filter((node) => node.kind === "validation")).toHaveLength(4);
    expect(
      run.graph?.nodes
        .filter((node) => node.id === "research" || node.id === "build")
        .map((node) => node.dependsOn),
    ).toEqual([["plan"], ["plan"]]);
    expect(run.graph?.nodes.find((node) => node.id === "build")).toMatchObject({
      status: "failed",
      failureClassification: "implementation",
    });
    expect(run.graph?.nodes.find((node) => node.id === "build")?.attempts).toMatchObject([
      {
        modelSelection: { instanceId: "codex-work" },
        status: "failed",
        failureClassification: "tool",
      },
      {
        modelSelection: { instanceId: "codex-backup" },
        status: "completed",
      },
    ]);
    expect(run.graph?.nodes.find((node) => node.id === "fix-build")).toMatchObject({
      status: "completed",
      confidence: "high",
    });
    expect(run.graph?.nodes.find((node) => node.id === "conflict-check")).toMatchObject({
      status: "completed",
      confidence: "high",
    });
    expect(run.graph?.changes.some((change) => change.reason === "implementation-failure")).toBe(
      true,
    );
    expect(run.graph?.changes.some((change) => change.reason === "result-conflict")).toBe(true);
    expect(run.finalOutput).toBe("검증된 제어 센터 구현 완료");
    expect((await Effect.runPromise(Ref.get(scheduledRunRef))).status).toBe("cancelled");
    const dispatchedTypes = await Effect.runPromise(Ref.get(dispatchedTypesRef));
    expect(dispatchedTypes[0]).toBe("project.collaboration.run.cancel");
    expect(await Effect.runPromise(Ref.get(capturedMemoryRef))).toEqual(["제어 센터 검증 절차"]);
    const prompts = await Effect.runPromise(Ref.get(promptsRef));
    expect(prompts).toHaveLength(13);
    expect(prompts[0]).toContain("current user goal is the absolute priority");
    expect(prompts[1]).toContain("TASK:\n현재 자료를 조사한다.");
    expect(prompts[2]).toContain("TASK:\n제어 센터를 구현한다.");
    expect(prompts.some((prompt) => prompt.includes("Node: replan-"))).toBe(true);
    expect(prompts.every((prompt) => prompt.includes("SUCCESS CRITERIA:"))).toBe(true);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  }
});
