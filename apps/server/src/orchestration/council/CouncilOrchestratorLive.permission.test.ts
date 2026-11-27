// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { expect, it } from "@effect/vitest";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutor,
  type WorkspaceAgentExecutionInput,
} from "../Services/WorkspaceAgentExecutor.ts";
import { CouncilOrchestratorService } from "./CouncilOrchestrator.ts";
import { CouncilOrchestratorLive } from "./CouncilOrchestratorLive.ts";

function makeProvider(instanceId: string, driver: string, model: string): ServerProvider {
  return {
    provider: ProviderDriverKind.make(driver),
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(instanceId),
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-22T00:00:00.000Z",
    models: [
      {
        slug: model,
        name: model,
        isCustom: false,
        isDefault: true,
        isLegacy: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function makeTestLayer(options: {
  readonly projectRoot: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly threadRuntimeMode: RuntimeMode;
  readonly threadInteractionMode: ProviderInteractionMode;
  readonly capturedInputs: WorkspaceAgentExecutionInput[];
}) {
  const providers: ReadonlyArray<ServerProvider> = [
    makeProvider("claudeAgent", "claudeAgent", "claude-opus-5-5"),
    makeProvider("codex", "codex", "gpt-5.4"),
  ];

  const threadSummary = {
    id: options.threadId,
    projectId: options.projectId,
    title: "Permission inheritance test",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
    runtimeMode: options.threadRuntimeMode,
    interactionMode: options.threadInteractionMode,
    branch: null,
    worktreePath: null,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    session: null,
    latestTurn: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  };

  const mockProjection = Layer.succeed(ProjectionSnapshotQuery, {
    getThreadRuntimeContext: (id: ThreadId) =>
      Effect.succeed(id === options.threadId ? Option.some(threadSummary as never) : Option.none()),
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [
          {
            id: options.projectId,
            title: "Test Project",
            workspaceRoot: options.projectRoot,
            scripts: [],
            createdAt: "2026-11-22T00:00:00.000Z",
            updatedAt: "2026-11-22T00:00:00.000Z",
          },
        ],
        threads: [threadSummary],
        updatedAt: "2026-11-22T00:00:00.000Z",
      } as never),
  } as never);

  const mockSettings = Layer.succeed(ServerSettingsService, {
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
  } as never);

  const mockProviders = Layer.succeed(ProviderRegistry, {
    getProviders: Effect.succeed(providers),
  } as never);

  const mockExecutor = Layer.succeed(WorkspaceAgentExecutor, {
    execute: (input: WorkspaceAgentExecutionInput) =>
      Effect.sync(() => {
        options.capturedInputs.push(input);
        if (input.orchestraPhase === "step") {
          return `<t3_checker_verdict>{"decision":"approve","evidence":"verified"}</t3_checker_verdict>`;
        }
        if (input.role === "implementer") {
          return "worker completed";
        }
        if (input.title.includes("R3")) {
          return `<t3_council_synthesis>${JSON.stringify({
            titleKo: "합의 명세",
            executiveSummaryKo: "테스트 합의 요약",
            acceptedClaimIds: [],
            targetFiles: [
              {
                filePath: "src/sample.ts",
                patchIntentKo: "샘플 수정",
                relatedEvidenceIds: [],
              },
            ],
            acceptanceChecks: [
              {
                label: "node -e process.exit(0)",
                command: "node",
                args: ["-e", "process.exit(0)"],
              },
            ],
            unresolvedDisagreementsKo: [],
            uniqueFindingsKo: [],
          })}</t3_council_synthesis>`;
        }
        const tag = input.title.includes("R2") ? "t3_council_critique" : "t3_council_proposal";
        return `<${tag}>${JSON.stringify({
          claimKind: "PATCH_PROPOSAL",
          severity: "P1",
          statementKo: "샘플 근거 기반 제안",
          proposedDiffSketch: "update sample.ts",
          evidence: [{ filePath: "src/sample.ts", startLine: 1, endLine: 2, astSymbol: "hello" }],
          acceptanceCommands: ["node -e process.exit(0)"],
        })}</${tag}>`;
      }),
  });

  return CouncilOrchestratorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        SqlitePersistenceMemory,
        mockProjection,
        mockSettings,
        mockProviders,
        mockExecutor,
      ),
    ),
  );
}

it.effect(
  "automatically runs all council seats, worker, and checker in full-access + default mode for a full-access thread",
  () =>
    Effect.gen(function* () {
      const tmpDir = yield* Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-council-perm-full-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFs.rm(tmpDir, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFs.mkdir(NodePath.join(tmpDir, "src"), { recursive: true });
        await NodeFs.writeFile(
          NodePath.join(tmpDir, "src/sample.ts"),
          "export function hello() {\n  return 'world';\n}\n",
          "utf8",
        );
      });

      const capturedInputs: WorkspaceAgentExecutionInput[] = [];
      const projectId = ProjectId.make("proj_full");
      const threadId = ThreadId.make("thread_full");

      const layer = makeTestLayer({
        projectRoot: tmpDir,
        projectId,
        threadId,
        threadRuntimeMode: "full-access",
        threadInteractionMode: "default",
        capturedInputs,
      });

      yield* Effect.gen(function* () {
        const council = yield* CouncilOrchestratorService;
        const started = yield* council.startAutoSeat({
          threadId,
          projectId,
          userPrompt: "크라임 코인 패턴을 전체 권한으로 분석하자",
          forceCouncil: true,
        });
        const settled = yield* council.awaitCouncil(started.councilId);
        expect(settled?.state).toBe("PINNED_READY");
        expect(settled?.pinnedSpec).not.toBeNull();

        yield* council.executePinnedSpec({
          pinnedSpecId: settled!.pinnedSpec!.pinnedSpecId,
          isolateInWorktree: false,
          idempotencyKey: "perm_full_exec_001",
        });
      }).pipe(Effect.provide(layer));

      expect(capturedInputs.length).toBeGreaterThanOrEqual(4);
      for (const input of capturedInputs) {
        expect(input.runtimeMode).toBe("full-access");
        expect(input.interactionMode).toBe("default");
      }
      // PinnedSpec implementer workers must NOT set orchestraPhase="task" (no collaboration run row exists)
      const workerInputs = capturedInputs.filter((input) => input.role === "implementer");
      expect(workerInputs.length).toBe(1);
      expect(workerInputs[0]?.orchestraPhase).toBeUndefined();
    }),
);

it.effect(
  "assigns distinct dispatch/execution IDs across targeted research retry rounds so WorkerEngineStore never collides",
  () =>
    Effect.gen(function* () {
      const tmpDir = yield* Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-council-retry-ids-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFs.rm(tmpDir, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFs.mkdir(NodePath.join(tmpDir, "src"), { recursive: true });
        await NodeFs.writeFile(
          NodePath.join(tmpDir, "src/sample.ts"),
          "export function hello() {\n  return 'world';\n}\n",
          "utf8",
        );
      });

      const capturedInputs: WorkspaceAgentExecutionInput[] = [];
      const projectId = ProjectId.make("proj_retry");
      const threadId = ThreadId.make("thread_retry");
      let r1Calls = 0;

      const providers: ReadonlyArray<ServerProvider> = [
        makeProvider("claudeAgent", "claudeAgent", "claude-opus-5-5"),
        makeProvider("codex", "codex", "gpt-5.4"),
      ];
      const threadSummary = {
        id: threadId,
        projectId,
        title: "Retry ID uniqueness test",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
        },
        runtimeMode: "full-access" as RuntimeMode,
        interactionMode: "default" as ProviderInteractionMode,
        branch: null,
        worktreePath: null,
        createdAt: "2026-11-22T00:00:00.000Z",
        updatedAt: "2026-11-22T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        session: null,
        latestTurn: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      };

      const retryLayer = CouncilOrchestratorLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            SqlitePersistenceMemory,
            Layer.succeed(ProjectionSnapshotQuery, {
              getThreadRuntimeContext: () => Effect.succeed(Option.some(threadSummary as never)),
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: 1,
                  projects: [
                    {
                      id: projectId,
                      title: "Retry Project",
                      workspaceRoot: tmpDir,
                      scripts: [],
                      createdAt: "2026-11-22T00:00:00.000Z",
                      updatedAt: "2026-11-22T00:00:00.000Z",
                    },
                  ],
                  threads: [threadSummary],
                  updatedAt: "2026-11-22T00:00:00.000Z",
                } as never),
            } as never),
            Layer.succeed(ServerSettingsService, {
              getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            } as never),
            Layer.succeed(ProviderRegistry, {
              getProviders: Effect.succeed(providers),
            } as never),
            Layer.succeed(WorkspaceAgentExecutor, {
              execute: (input: WorkspaceAgentExecutionInput) =>
                Effect.sync(() => {
                  capturedInputs.push(input);
                  if (input.title.includes("R1")) {
                    r1Calls += 1;
                    // First attempt returns missing file so verifiedLedger === 0 triggers retryAttempt=1
                    const filePath = r1Calls <= 2 ? "src/missing.ts" : "src/sample.ts";
                    return `<t3_council_proposal>${JSON.stringify({
                      claimKind: "PATCH_PROPOSAL",
                      severity: "P1",
                      statementKo: "근거 탐색",
                      proposedDiffSketch: "edit",
                      evidence: [{ filePath, startLine: 1, endLine: 2, astSymbol: "hello" }],
                    })}</t3_council_proposal>`;
                  }
                  if (input.title.includes("R2")) {
                    return `<t3_council_critique>${JSON.stringify({
                      claimKind: "REBUTTAL_DEFENSE",
                      severity: null,
                      targetClaimId: null,
                      responseTaxonomy: "NEW_EVIDENCE_ADDED",
                      statementKo: "재검토",
                      proposedDiffSketch: "edit",
                      evidence: [
                        {
                          filePath: r1Calls <= 2 ? "src/missing.ts" : "src/sample.ts",
                          startLine: 1,
                          endLine: 2,
                          astSymbol: "hello",
                        },
                      ],
                    })}</t3_council_critique>`;
                  }
                  return `<t3_council_synthesis>${JSON.stringify({
                    titleKo: "재탐색 합의",
                    executiveSummaryKo: "요약",
                    acceptedClaimIds: [],
                    targetFiles: [
                      { filePath: "src/sample.ts", patchIntentKo: "수정", relatedEvidenceIds: [] },
                    ],
                    acceptanceChecks: [
                      { label: "ok", command: "node", args: ["-e", "process.exit(0)"] },
                    ],
                    unresolvedDisagreementsKo: [],
                    uniqueFindingsKo: [],
                  })}</t3_council_synthesis>`;
                }),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const council = yield* CouncilOrchestratorService;
        const started = yield* council.startAutoSeat({
          threadId,
          projectId,
          userPrompt: "재탐색 시 dispatchId 중복 없음 검증",
          forceCouncil: true,
        });
        const settled = yield* council.awaitCouncil(started.councilId);
        expect(settled?.state).toBe("PINNED_READY");
        expect(settled?.researchRetryCount).toBe(1);
      }).pipe(Effect.provide(retryLayer));

      const execIds = capturedInputs.map((i) => i.execution.executionId);
      expect(execIds.length).toBeGreaterThanOrEqual(8);
      expect(new Set(execIds).size).toBe(execIds.length);
      expect(execIds.some((id) => id.includes(":retry1"))).toBe(true);
    }),
);

it.effect(
  "preserves approval-required + plan mode on restricted threads and honors explicit full-access start override",
  () =>
    Effect.gen(function* () {
      const tmpDir = yield* Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-council-perm-restr-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFs.rm(tmpDir, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFs.mkdir(NodePath.join(tmpDir, "src"), { recursive: true });
        await NodeFs.writeFile(
          NodePath.join(tmpDir, "src/sample.ts"),
          "export function hello() {\n  return 'world';\n}\n",
          "utf8",
        );
      });

      const restrictedInputs: WorkspaceAgentExecutionInput[] = [];
      const projectId = ProjectId.make("proj_restr");
      const threadId = ThreadId.make("thread_restr");

      const layerRestricted = makeTestLayer({
        projectRoot: tmpDir,
        projectId,
        threadId,
        threadRuntimeMode: "approval-required",
        threadInteractionMode: "plan",
        capturedInputs: restrictedInputs,
      });

      yield* Effect.gen(function* () {
        const council = yield* CouncilOrchestratorService;
        const started = yield* council.startAutoSeat({
          threadId,
          projectId,
          userPrompt: "제한 모드에서 협의",
          forceCouncil: true,
        });
        const settled = yield* council.awaitCouncil(started.councilId);
        expect(settled?.state).toBe("PINNED_READY");

        yield* council.executePinnedSpec({
          pinnedSpecId: settled!.pinnedSpec!.pinnedSpecId,
          isolateInWorktree: false,
          idempotencyKey: "perm_restr_exec_001",
        });
      }).pipe(Effect.provide(layerRestricted));

      expect(restrictedInputs.length).toBeGreaterThanOrEqual(4);
      for (const input of restrictedInputs) {
        expect(input.runtimeMode).toBe("approval-required");
        expect(input.interactionMode).toBe("plan");
      }

      // Now verify explicit composer override promotes an unsynced thread immediately
      const overrideInputs: WorkspaceAgentExecutionInput[] = [];
      const layerOverride = makeTestLayer({
        projectRoot: tmpDir,
        projectId,
        threadId,
        threadRuntimeMode: "approval-required",
        threadInteractionMode: "plan",
        capturedInputs: overrideInputs,
      });

      yield* Effect.gen(function* () {
        const council = yield* CouncilOrchestratorService;
        const started = yield* council.startAutoSeat({
          threadId,
          projectId,
          userPrompt: "콤포저에서 방금 전체 권한으로 바꾼 뒤 위원회 실행",
          forceCouncil: true,
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        const settled = yield* council.awaitCouncil(started.councilId);
        expect(settled?.state).toBe("PINNED_READY");
      }).pipe(Effect.provide(layerOverride));

      expect(overrideInputs.length).toBeGreaterThanOrEqual(3);
      for (const input of overrideInputs) {
        expect(input.runtimeMode).toBe("full-access");
        expect(input.interactionMode).toBe("default");
      }
    }),
);
