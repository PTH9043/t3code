// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDateInEffect:off
import * as NodeCrypto from "node:crypto";
import {
  MissionControlError,
  ThreadId,
  type CompactHandoffPacket,
  type MissionCancelInput,
  type MissionDeleteInput,
  type MissionControlSnapshot,
  type MissionControlStreamEvent,
  type MissionCreateInput,
  type MissionCrewRole,
  type MissionCrewRoleDeleteInput,
  type MissionCrewRoleUpsertInput,
  type MissionDagStep,
  type MissionDecideApprovalInput,
  type MissionDigestNowInput,
  type MissionGetSnapshotInput,
  type MissionHeartbeatCheckInput,
  type MissionHeartbeatCheckResult,
  type MissionInspectArtifactInput,
  type MissionInspectArtifactResult,
  type MissionKillSwitchInput,
  type MissionMeetingActionInput,
  type MissionMeetingRecord,
  type MissionOrgTier,
  type MissionPromoteMeetingInput,
  type MissionReport,
  type MissionRoleModelOverride,
  type MissionRoundtableStartInput,
  type MissionRun,
  type MissionSyncMeetingInput,
  type MissionSynapsePacket,
  type MissionSynapsePruneInput,
  type MissionTriggerReason,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { trigramCosineSimilarity } from "../../orchestration/ForemanMonitor.ts";
import { appendHostAuditEntry } from "../../orchestration/HostApprovalGate.ts";
import {
  ROUTING_NODE_KIND,
  indexTextArtifactIntoRoutingGraph,
} from "../../orchestration/workspaceRoutingGraph.ts";
import {
  MISSION_GUARDRAIL_LIMITS,
  computeErrorFingerprint,
  estimateMissionStepCostUsd,
  evaluateMissionCircuitBreaker,
} from "./MissionBudgetGuard.ts";
import { makeMissionControlStore, type MissionCheckpointPayload } from "./MissionControlStore.ts";
import { resolveCrewExecutionTarget } from "./MissionModelRouter.ts";
import {
  assembleCacheAlignedMissionPrompt,
  estimateCachedPromptTokens,
  estimateTextTokens,
} from "./MissionPromptCacheAssembler.ts";
import {
  archiveMissionRawArtifact,
  buildCompactHandoffPacket,
  inspectCcrArtifactById,
  runToolOutputValve,
} from "./MissionToolOutputValve.ts";
import {
  classifyGoalRiskZeroToken,
  evaluateWorkspacePulseZeroToken,
} from "./MissionZeroTokenGate.ts";
import { classifyMissionDomainTag, selectSparseCrewForTopic } from "./MissionTriageRouter.ts";
import {
  buildModeratorSynthesisPrompt,
  buildPeerRoundPrompt,
  evaluateMeetingEarlyStop,
  parseSynapsePacketFromText,
  selectTopSynapsePackets,
} from "./MeetingSynapseProtocol.ts";
import {
  backpropagateMeetingImportance,
  backpropagateMissionImportance,
} from "./SynapseBackpropEngine.ts";

/**
 * NewAutoUsage (T3) 자율 미션 컨트롤 오케스트레이터 서비스.
 *
 * 핵심 책임:
 * 1. 미션 FSM (CREATED → PLANNING → EXECUTING → VERIFYING → COMPLETED / AWAITING_APPROVAL)
 * 2. 실제 프로젝트 대화창(`threadId`) 바인딩 및 자동 생성 + 대화창 타임라인 진행/결재/완료 보고 게시
 * 3. 크루 유동 모델 라우팅(사용자 설정/즉석 오버라이드/폴백 + 이종 검수 교차 배정)
 * 4. 7대 토큰 폭발 방지(Pass-by-Reference 포인터 교신, 3단 Prompt Cache Prefix, Tool Output Valve,
 *    Zero-Token 리액터 게이트, 4계층 서킷 브레이커, ForemanMonitor 유사도 정체 차단, Map-Reduce 증분 요약)
 * 5. Tier 2 Checkpoint 동결 & 4종 결재(`approve` / `modify_resume` / `reject_rollback` / `snooze`)
 */

export interface MissionProjectContext {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly providers: ReadonlyArray<ServerProvider>;
}

export interface MissionCrewStepInput {
  readonly missionId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly role: MissionCrewRole;
  readonly providerInstanceId: string;
  readonly modelSlug: string;
  readonly displayName: string;
  readonly prompt: string;
  readonly isWriteRole: boolean;
  readonly worktreePath?: string | null;
  readonly worktreeBranch?: string | null;
}

export interface MissionCrewStepOutput {
  readonly resultText: string;
  readonly exitCode?: number;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly worktreePath?: string | null;
  readonly worktreeBranch?: string | null;
  readonly taskId?: string | null;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly providerErrorCode?: string | null;
}

export interface MissionOrchestratorDeps {
  readonly sql: SqlClient.SqlClient;
  readonly resolveProjectContext: (
    projectId: ProjectId,
  ) => Effect.Effect<MissionProjectContext, MissionControlError>;
  /** threadId 없이 미션 생성 시 실제 프로젝트 대화창을 새로 만들고 ThreadId를 반환 */
  readonly createProjectThread?: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly providerInstanceId: string;
    readonly modelSlug: string;
  }) => Effect.Effect<ThreadId, MissionControlError>;
  /** 실제 대화창 타임라인에 미션 착수·결재·최종 보고를 한국어 마크다운으로 게시 */
  readonly publishThreadMessage?: (input: {
    readonly threadId: ThreadId;
    readonly messageKey: string;
    readonly markdown: string;
  }) => Effect.Effect<void, never>;
  /** 실제 크루(프로바이더·모델) 실행기 (WorkerEngineService + WorkspaceAgentExecutor 연결) */
  readonly runCrewStep: (
    input: MissionCrewStepInput,
  ) => Effect.Effect<MissionCrewStepOutput, MissionControlError>;
  /** Worktree 병합/폐기 훅 (WorkerEngineService 연결) */
  readonly mergeWorktree?: (taskId: string) => Effect.Effect<string, MissionControlError>;
  readonly discardWorktree?: (taskId: string) => Effect.Effect<string, MissionControlError>;
  /** 부팅 시 고아 미션 자동 복구 여부 (기본 true) */
  readonly reconcileOnBoot?: boolean;
  /** 테스트용 동기/비동기 실행 제어 */
  readonly leaseOwner?: string;
}

export interface MissionOrchestratorShape {
  readonly getSnapshot: (
    input: MissionGetSnapshotInput,
  ) => Effect.Effect<MissionControlSnapshot, MissionControlError>;
  readonly subscribe: (input: {
    readonly projectId: ProjectId;
    readonly threadId?: ThreadId;
  }) => Stream.Stream<MissionControlStreamEvent, MissionControlError>;
  readonly createMission: (
    input: MissionCreateInput,
  ) => Effect.Effect<MissionRun, MissionControlError>;
  readonly cancelMission: (
    input: MissionCancelInput,
  ) => Effect.Effect<MissionRun, MissionControlError>;
  readonly deleteMission: (
    input: MissionDeleteInput,
  ) => Effect.Effect<
    { readonly deleted: boolean; readonly missionId: string },
    MissionControlError
  >;
  readonly decideApproval: (
    input: MissionDecideApprovalInput,
  ) => Effect.Effect<MissionControlSnapshot, MissionControlError>;
  readonly upsertCrewRole: (
    input: MissionCrewRoleUpsertInput,
  ) => Effect.Effect<MissionCrewRole, MissionControlError>;
  readonly deleteCrewRole: (
    input: MissionCrewRoleDeleteInput,
  ) => Effect.Effect<{ readonly deleted: boolean; readonly roleId: string }, MissionControlError>;
  readonly startSyncMeeting: (
    input: MissionSyncMeetingInput,
  ) => Effect.Effect<MissionControlSnapshot, MissionControlError>;
  readonly startRoundtableMeeting: (
    input: MissionRoundtableStartInput,
  ) => Effect.Effect<MissionMeetingRecord, MissionControlError>;
  readonly cancelMeeting: (
    input: MissionMeetingActionInput,
  ) => Effect.Effect<MissionMeetingRecord, MissionControlError>;
  readonly deleteMeeting: (
    input: MissionMeetingActionInput,
  ) => Effect.Effect<
    { readonly deleted: boolean; readonly meetingId: string },
    MissionControlError
  >;
  readonly promoteMeetingToMission: (
    input: MissionPromoteMeetingInput,
  ) => Effect.Effect<MissionRun, MissionControlError>;
  readonly setSynapsePruned: (
    input: MissionSynapsePruneInput,
  ) => Effect.Effect<{ readonly updated: boolean }, MissionControlError>;
  readonly killSwitch: (
    input: MissionKillSwitchInput,
  ) => Effect.Effect<MissionControlSnapshot, MissionControlError>;
  readonly generateDigestNow: (
    input: MissionDigestNowInput,
  ) => Effect.Effect<MissionReport, MissionControlError>;
  readonly runHeartbeatCheck: (
    input: MissionHeartbeatCheckInput,
  ) => Effect.Effect<MissionHeartbeatCheckResult, MissionControlError>;
  readonly inspectArtifact: (
    input: MissionInspectArtifactInput,
  ) => Effect.Effect<MissionInspectArtifactResult, MissionControlError>;
  readonly reconcileOrphanedMissions: (
    projectId?: ProjectId,
  ) => Effect.Effect<number, MissionControlError>;
  /** 테스트 전용: 진행 중인 미션 Fiber 완료 대기 */
  readonly awaitMission: (missionId: string) => Effect.Effect<void, never>;
  /** 테스트 전용: 진행 중인 합석 회의 Fiber 완료 대기 */
  readonly awaitMeeting: (meetingId: string) => Effect.Effect<void, never>;
}

export class MissionOrchestratorService extends Context.Service<
  MissionOrchestratorService,
  MissionOrchestratorShape
>()("t3/t3x/missionControl/MissionOrchestratorService") {}

interface ParsedCrewResult {
  readonly status: "ok" | "fix_required" | "escalate";
  readonly summary3Lines: ReadonlyArray<string>;
  readonly changedFiles: ReadonlyArray<string>;
  readonly verificationCmd: string | null;
  readonly recommendation: string;
}

function parseCrewResultTag(rawText: string): ParsedCrewResult {
  const match = rawText.match(/<t3_mission_result>([\s\S]*?)<\/t3_mission_result>/i);
  if (match && match[1]) {
    try {
      const obj = JSON.parse(match[1].trim()) as Record<string, unknown>;
      const status =
        obj.status === "fix_required" || obj.status === "escalate" || obj.status === "ok"
          ? obj.status
          : "ok";
      const summary3Lines = Array.isArray(obj.summary3Lines)
        ? obj.summary3Lines
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .slice(0, 3)
        : [];
      const changedFiles = Array.isArray(obj.changedFiles)
        ? obj.changedFiles.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        : [];
      const verificationCmd =
        typeof obj.verificationCmd === "string" && obj.verificationCmd.trim().length > 0
          ? obj.verificationCmd.trim()
          : null;
      const recommendation =
        typeof obj.recommendation === "string" && obj.recommendation.trim().length > 0
          ? obj.recommendation.trim().slice(0, 240)
          : "다음 단계 진행 가능";
      return {
        status,
        summary3Lines:
          summary3Lines.length > 0 ? summary3Lines : extractFallbackSummary3Lines(rawText),
        changedFiles,
        verificationCmd,
        recommendation,
      };
    } catch {
      // Fallback below
    }
  }
  const upper = rawText.toUpperCase();
  const status: ParsedCrewResult["status"] =
    upper.includes("FIX_REQUIRED") || upper.includes("REJECT")
      ? "fix_required"
      : upper.includes("ESCALATE")
        ? "escalate"
        : "ok";
  return {
    status,
    summary3Lines: extractFallbackSummary3Lines(rawText),
    changedFiles: [],
    verificationCmd: null,
    recommendation:
      status === "fix_required" ? "지적 사항 수정 후 재검증 필요" : "다음 단계 진행 가능",
  };
}

function extractFallbackSummary3Lines(rawText: string): ReadonlyArray<string> {
  const cleaned = rawText
    .replace(/<t3_mission_result>[\s\S]*?<\/t3_mission_result>/gi, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*#>\s]+/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 3)
    .map((l) => (l.length > 80 ? `${l.slice(0, 79)}…` : l));
  return cleaned.length > 0 ? cleaned : ["단계 실행 완료"];
}

export const makeMissionOrchestrator = Effect.fn("MissionOrchestrator.make")(function* (
  deps: MissionOrchestratorDeps,
) {
  const scope = yield* Scope.Scope;
  const store = makeMissionControlStore(deps.sql);
  const pubsub = yield* PubSub.unbounded<MissionControlStreamEvent>();
  const activeFibers = new Map<string, Fiber.Fiber<void, never>>();
  const activeMeetingFibers = new Map<string, Fiber.Fiber<void, never>>();
  const activeOverrides = new Map<string, ReadonlyArray<MissionRoleModelOverride>>();
  const lastPrefixHashByCrew = new Map<string, string>();
  const leaseOwner = deps.leaseOwner ?? `t3-host-${NodeCrypto.randomUUID().slice(0, 8)}`;

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...activeFibers.values(), ...activeMeetingFibers.values()],
      (fiber) => Fiber.interrupt(fiber).pipe(Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          activeFibers.clear();
          activeMeetingFibers.clear();
        }),
      ),
    ),
  );

  const buildSnapshot = (
    projectId: ProjectId,
    threadId?: ThreadId,
  ): Effect.Effect<MissionControlSnapshot, MissionControlError> =>
    Effect.gen(function* () {
      const ctx = yield* deps.resolveProjectContext(projectId).pipe(
        Effect.catch(() =>
          Effect.succeed<MissionProjectContext>({
            projectId,
            projectTitle: "프로젝트",
            workspaceRoot: ".",
            providers: [],
          }),
        ),
      );
      const [
        crewRoles,
        missions,
        meetings,
        synapseWeights,
        pendingApprovals,
        recentResolvedApprovals,
        reports,
        activities,
        handoffs,
        budget,
        completedToday,
      ] = yield* Effect.all([
        store.ensureDefaultCrewRoles(projectId, ctx.providers),
        store.listMissions(projectId, threadId, 40),
        store.listMeetings(projectId, threadId, 20),
        store.listSynapseWeights(projectId),
        store.listApprovalGates(projectId, "pending", threadId, 30),
        store.listApprovalGates(projectId, "resolved", threadId, 20),
        store.listReports(projectId, 20),
        store.listActivities(projectId, threadId, 60),
        store.listHandoffs(projectId, threadId, 50),
        store.getDailyBudgetSummary(projectId),
        store.countCompletedToday(projectId),
      ]);

      const nowMs = yield* Clock.currentTimeMillis;
      const workingCrew = crewRoles.filter((r) => r.currentStatus === "WORKING").length;
      const workingMissions = missions.filter(
        (m) =>
          m.status === "CREATED" ||
          m.status === "PLANNING" ||
          m.status === "EXECUTING" ||
          m.status === "VERIFYING",
      ).length;
      const activeMeetings = meetings.filter((m) => m.status === "RUNNING").length;
      const idleCrew = crewRoles.filter((r) => r.enabled && r.currentStatus === "IDLE").length;

      return {
        projectId,
        generatedAtMs: nowMs,
        counts: {
          working: Math.max(workingCrew, workingMissions + activeMeetings),
          awaitingApproval: pendingApprovals.length,
          idle: idleCrew,
          completedToday,
          totalMissions: missions.length,
          activeMeetings,
        },
        budget,
        crewRoles: [...crewRoles],
        missions: [...missions],
        meetings: [...meetings],
        synapseWeights: [...synapseWeights],
        pendingApprovals: [...pendingApprovals],
        recentResolvedApprovals: [...recentResolvedApprovals],
        reports: [...reports],
        activities: [...activities],
        handoffs: [...handoffs],
      };
    });

  const broadcast = (
    projectId: ProjectId,
    type: MissionControlStreamEvent["type"],
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const snapshot = yield* buildSnapshot(projectId).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const nowMs = yield* Clock.currentTimeMillis;
      yield* PubSub.publish(pubsub, {
        type,
        projectId,
        snapshot,
        timestampMs: nowMs,
      });
    }).pipe(Effect.ignore);

  const postToThread = (
    threadId: ThreadId | null,
    messageKey: string,
    markdown: string,
  ): Effect.Effect<void, never> => {
    if (!threadId || !deps.publishThreadMessage) return Effect.void;
    return deps.publishThreadMessage({ threadId, messageKey, markdown }).pipe(Effect.ignore);
  };

  const tripMissionToInbox = (input: {
    readonly mission: MissionRun;
    readonly ctx: MissionProjectContext;
    readonly roleKey: string;
    readonly providerInstanceId: string;
    readonly modelSlug: string;
    readonly triggerReason: MissionTriggerReason;
    readonly riskLevel: "medium" | "high" | "critical";
    readonly title: string;
    readonly context3LinesMd: string;
    readonly aiRecommendation: string;
    readonly changedFilesCount: number;
    readonly diffUri?: string | null;
    readonly checkpoint: MissionCheckpointPayload;
    readonly circuitTripped?: boolean;
  }) =>
    Effect.gen(function* () {
      const threadId = input.mission.threadId ?? ThreadId.make(`mission-${input.mission.id}`);
      const syncedDagSteps = input.mission.dagSteps.map((step) =>
        step.status === "RUNNING" || (step.roleKey === input.roleKey && step.status === "VERIFYING")
          ? { ...step, status: "AWAITING_APPROVAL" as const }
          : step,
      );
      const updated = yield* store.updateMissionFenced(input.mission.id, input.mission.leaseEpoch, {
        status: "AWAITING_APPROVAL",
        activeRoleId: input.roleKey,
        dagSteps: syncedDagSteps,
        circuitBreakerState: input.circuitTripped
          ? "TRIPPED_TO_INBOX"
          : input.mission.circuitBreakerState,
      });

      const gate = yield* store.createApprovalGate({
        projectId: input.mission.projectId,
        missionId: input.mission.id,
        threadId,
        existingTaskId: input.mission.activeTaskId,
        cwd: input.ctx.workspaceRoot,
        roleKey: input.roleKey,
        providerInstanceId: input.providerInstanceId,
        modelSlug: input.modelSlug,
        escalationTier: "TIER_2",
        triggerReason: input.triggerReason,
        riskLevel: input.riskLevel,
        title: input.title,
        context3LinesMd: input.context3LinesMd,
        aiRecommendation: input.aiRecommendation,
        estimatedCostUsd: updated.totalCostUsd,
        changedFilesCount: input.changedFilesCount,
        diffUri: input.diffUri ?? null,
        worktreePath: updated.worktreePath,
        worktreeBranch: updated.worktreeBranch,
        checkpoint: input.checkpoint,
      });

      if (input.circuitTripped) {
        yield* store.recordBudgetUsage({
          projectId: input.mission.projectId,
          missionId: input.mission.id,
          roleKey: input.roleKey,
          providerInstanceId: input.providerInstanceId,
          modelSlug: input.modelSlug,
          promptTokens: 0,
          cachedTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          latencyMs: 0,
          circuitBreakerFlag: "TRIPPED_TO_INBOX",
        });
      }

      yield* store.updateCrewTelemetry({
        projectId: input.mission.projectId,
        roleKey: input.roleKey,
        status: "BLOCKED",
        activeMissionId: input.mission.id,
        activeTaskId: gate.taskId,
      });

      yield* store.appendActivity({
        projectId: input.mission.projectId,
        missionId: input.mission.id,
        threadId,
        roleKey: input.roleKey,
        roleDisplayName: "결재함 게이트",
        level: "warn",
        message: `[결재 상신 · ${input.triggerReason}] ${input.title}`,
      });

      yield* postToThread(
        input.mission.threadId,
        `mission:${input.mission.id}:gate:${gate.gateId}`,
        [
          `### 🛑 자율 미션 결재 대기 — ${input.mission.title}`,
          `- **사유**: \`${input.triggerReason}\` (${input.title})`,
          `- **AI 권고안**: ${input.aiRecommendation}`,
          `- **누적 비용/토큰**: $${updated.totalCostUsd.toFixed(4)} · ${updated.totalTokensUsed.toLocaleString()}T`,
          "",
          input.context3LinesMd,
          "",
          "> 상단 **자율 미션 바** 또는 **자율 운영실 → 결재함**에서 `[승인 / 수정 지시 / 반려 / 1h 보류]`를 선택하면 동결 지점에서 즉시 이어서 처리됩니다.",
        ].join("\n"),
      );

      yield* broadcast(input.mission.projectId, "approval_updated");
      return { mission: updated, gateId: gate.gateId };
    });

  const finalizeMissionCompleted = (input: {
    readonly mission: MissionRun;
    readonly summary3Lines: ReadonlyArray<string>;
    readonly changedFiles: ReadonlyArray<string>;
    readonly reviewerNote: string;
  }) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const digestLine =
        input.summary3Lines.join(" / ").slice(0, 260) || `${input.mission.title} 완료`;

      const completed = yield* store.updateMissionFenced(
        input.mission.id,
        input.mission.leaseEpoch,
        {
          status: "COMPLETED",
          activeRoleId: null,
          digestLine,
          completedAtMs: nowMs,
        },
      );

      const reportBody = [
        `## ✅ 미션 완료 보고: ${completed.title}`,
        "",
        "### 핵심 요약 (3줄)",
        ...input.summary3Lines.slice(0, 3).map((line, i) => `${i + 1}. ${line}`),
        "",
        "### 실행 지표",
        `- 변경 파일: ${input.changedFiles.length > 0 ? input.changedFiles.join(", ") : "없음 (분석/기획)"}`,
        `- 검수 판정: ${input.reviewerNote}`,
        `- 총 토큰/캐시 절감: ${completed.totalTokensUsed.toLocaleString()}T (캐시 ${completed.totalCachedTokens.toLocaleString()}T) · 추정 비용 $${completed.totalCostUsd.toFixed(4)}`,
      ].join("\n");

      yield* store.insertReport({
        projectId: completed.projectId,
        missionId: completed.id,
        threadId: completed.threadId,
        scope: "MISSION_DONE",
        title: `완료 보고 · ${completed.title}`,
        bodyMd: reportBody,
        summary3Lines: input.summary3Lines,
        dedupFingerprint: `mission_done:${completed.id}`,
      });

      yield* store.appendActivity({
        projectId: completed.projectId,
        missionId: completed.id,
        threadId: completed.threadId,
        roleKey: "digest",
        roleDisplayName: "비서실",
        level: "success",
        message: `미션 완료: ${digestLine}`,
      });

      yield* postToThread(completed.threadId, `mission:${completed.id}:completed`, reportBody);

      // DyLAN 역전파: 완료된 미션의 DAG 단계별 기여도·토큰 효율을 시냅스 가중치 테이블에 자동 누적
      const domainTag = classifyMissionDomainTag(completed.goalPrompt);
      const backpropDeltas = backpropagateMissionImportance({
        dagSteps: completed.dagSteps,
        succeeded: true,
      });
      for (const delta of backpropDeltas) {
        const step = completed.dagSteps.find((s) => s.roleKey === delta.roleKey);
        if (step?.providerInstanceId && step.modelSlug) {
          yield* store
            .recordSynapseBackprop({
              projectId: completed.projectId,
              domainTag,
              roleKey: delta.roleKey,
              providerInstanceId: step.providerInstanceId,
              modelSlug: step.modelSlug,
              importanceScore: delta.importanceScore,
              tokenEfficiency: delta.tokenEfficiency,
              adopted: delta.adopted,
            })
            .pipe(Effect.ignore);
        }
      }

      // SQLite 디스크 상주 RAG 키워드 그래프에 완료 보고 압축 인덱싱 (0 MB RAM)
      yield* indexTextArtifactIntoRoutingGraph(deps.sql, {
        projectId: completed.projectId,
        nodeKind: ROUTING_NODE_KIND.MEMORY_FACT,
        canonicalKey: `mission_report:${completed.id}`,
        title: `미션 완료: ${completed.title}`,
        summaryMoc: digestLine,
        bodyMarkdown: reportBody,
        bodyRefKind: "mission_report",
        bodyRefId: completed.id,
        epistemicState: "fact",
        keywords: [domainTag, "자율미션", ...completed.assignedRoles],
        updatedAtMs: nowMs,
      }).pipe(Effect.ignore);

      yield* broadcast(completed.projectId, "report_updated");
      return completed;
    });

  const executeMissionPipeline = (input: {
    readonly missionId: string;
    readonly startStage: "PLANNING" | "EXECUTING" | "VERIFYING";
    readonly initialPacket?: CompactHandoffPacket | null;
    readonly humanFeedbackNote?: string | null;
    readonly coderProviderOverride?: string | null;
  }): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      let mission = yield* store.getMission(input.missionId);
      if (!mission) return;
      const projectId = mission.projectId;
      const ctx = yield* deps.resolveProjectContext(projectId);
      const roles = yield* store.ensureDefaultCrewRoles(projectId, ctx.providers);
      const roleByKey = new Map(roles.map((r) => [r.roleKey, r]));
      const overrides = activeOverrides.get(mission.id);
      const threadId = mission.threadId ?? ThreadId.make(`mission-${mission.id}`);
      const flags = yield* store.getMissionFlags(mission.id);

      const plannerRole = roleByKey.get("planner") ?? roles[0];
      const coderRole = roleByKey.get("coder") ?? roles[1] ?? plannerRole;
      const reviewerRole = roleByKey.get("reviewer") ?? roles[2] ?? plannerRole;
      if (!plannerRole || !coderRole || !reviewerRole) {
        return;
      }

      const updateStepInList = (
        steps: ReadonlyArray<MissionDagStep>,
        stepId: string,
        patch: Partial<MissionDagStep>,
      ): MissionDagStep[] => steps.map((s) => (s.stepId === stepId ? { ...s, ...patch } : s));

      const recentOutputsByRole = new Map<string, string[]>();
      let currentPacket: CompactHandoffPacket | null = input.initialPacket ?? null;
      let coderProviderUsed: string | null = input.coderProviderOverride ?? null;
      let latestChangedFiles: string[] = [];
      let humanFeedback: string | null = input.humanFeedbackNote ?? null;

      const runOneRoleStep = (args: {
        readonly stepId: string;
        readonly role: MissionCrewRole;
        readonly stageStatus: "PLANNING" | "EXECUTING" | "VERIFYING";
        readonly isWriteRole: boolean;
        readonly excludeProviderIds?: ReadonlySet<string>;
      }) =>
        Effect.gen(function* () {
          const fresh = yield* store.getMission(mission!.id);
          if (!fresh || fresh.status === "CANCELLED") {
            return { aborted: true as const };
          }
          mission = fresh;

          const budgetSummary = yield* store.getDailyBudgetSummary(projectId);
          const nowMs = yield* Clock.currentTimeMillis;
          const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));

          // 3단 Cache-Aligned 프롬프트 조립
          const assembled = assembleCacheAlignedMissionPrompt({
            role: args.role,
            projectTitle: ctx.projectTitle,
            missionTitle: mission.title,
            goalPrompt: mission.goalPrompt,
            doneCriteria: mission.doneCriteria,
            incomingPacket: currentPacket,
            humanFeedbackNote: humanFeedback,
            turnNumber: mission.turnCount + 1,
            nowIso,
          });
          // 1회 사용 후 수정 지시 소비
          humanFeedback = null;

          // 서킷 브레이커 사전 평가
          const preGuard = evaluateMissionCircuitBreaker({
            turnInputTokens: assembled.totalTokens,
            turnCount: mission.turnCount + 1,
            hopCount: mission.hopCount + 1,
            reworkCount: mission.reworkCount,
            taskElapsedMs: 0,
            missionElapsedMs: Math.max(0, nowMs - mission.createdAtMs),
            missionTotalTokens: mission.totalTokensUsed + assembled.totalTokens,
            missionTotalCostUsd: mission.totalCostUsd,
            missionBudgetLimitUsd: mission.budgetLimitUsd,
            dailySpentUsd: budgetSummary.dailySpentUsd,
            dailyLimitUsd: budgetSummary.dailyLimitUsd,
            dailyRateLimitErrors: budgetSummary.rateLimitErrorsToday,
            repeatErrorCount: mission.repeatErrorCount,
            killSwitchActive: budgetSummary.killSwitchActive,
          });

          if (preGuard.shouldTripToInbox) {
            const trigger: MissionTriggerReason =
              preGuard.trigger === "HOP_LIMIT"
                ? "HOP_LIMIT"
                : preGuard.trigger === "REWORK_LIMIT"
                  ? "REWORK_LIMIT"
                  : preGuard.trigger === "REPEAT_ERROR_HASH"
                    ? "REPEAT_ERROR_HASH"
                    : "BUDGET_EXCEEDED";
            yield* tripMissionToInbox({
              mission,
              ctx,
              roleKey: args.role.roleKey,
              providerInstanceId: args.role.providerInstanceId,
              modelSlug: args.role.modelSlug,
              triggerReason: trigger,
              riskLevel: "high",
              title: preGuard.reason ?? "토큰/루프 가드레일 도달",
              context3LinesMd: [
                `1. 트리거: ${preGuard.trigger}`,
                `2. 누적 토큰 ${mission.totalTokensUsed.toLocaleString()}T · 비용 $${mission.totalCostUsd.toFixed(4)}`,
                `3. 홉 ${mission.hopCount}회 · 재작업 ${mission.reworkCount}회`,
              ].join("\n"),
              aiRecommendation:
                "방향을 좁히는 한 줄 수정 지시 후 재개하거나, 여기서 작업을 종료(반려)하는 것을 권장합니다.",
              changedFilesCount: latestChangedFiles.length,
              checkpoint: {
                missionId: mission.id,
                resumeStage: args.stageStatus,
                lastPacket: currentPacket,
                worktreePath: mission.worktreePath,
                worktreeBranch: mission.worktreeBranch,
                coderProviderInstanceId: coderProviderUsed,
              },
              circuitTripped: true,
            });
            return { aborted: true as const };
          }

          // 유동 모델 타깃 결정 (사용자 최신 설정 / 오버라이드 / 폴백 / 이종 교차 검수)
          const target = resolveCrewExecutionTarget({
            role: args.role,
            providers: ctx.providers,
            ...(overrides ? { roleModelOverrides: overrides } : {}),
            ...(args.excludeProviderIds ? { excludeProviderIds: args.excludeProviderIds } : {}),
          });

          const nextSteps = updateStepInList(mission.dagSteps, args.stepId, {
            status: args.stageStatus === "VERIFYING" ? "VERIFYING" : "RUNNING",
            providerInstanceId: target.providerInstanceId,
            modelSlug: target.modelSlug,
          });

          mission = yield* store.updateMissionFenced(mission.id, mission.leaseEpoch, {
            status: args.stageStatus,
            activeRoleId: args.role.roleKey,
            dagSteps: nextSteps,
            turnCount: mission.turnCount + 1,
            hopCount: mission.hopCount + 1,
            circuitBreakerState: assembled.throttled ? "THROTTLED" : "OK",
          });

          yield* store.updateCrewTelemetry({
            projectId,
            roleKey: args.role.roleKey,
            status: "WORKING",
            activeMissionId: mission.id,
            contextPercent: Math.min(
              100,
              Math.round(
                (assembled.totalTokens / MISSION_GUARDRAIL_LIMITS.maxTurnInputTokens) * 100,
              ),
            ),
            turnCount: mission.turnCount,
          });

          yield* store.appendActivity({
            projectId,
            missionId: mission.id,
            threadId,
            roleKey: args.role.roleKey,
            roleDisplayName: args.role.displayName,
            level: "info",
            message: `${args.role.displayName} 실행 시작 (${target.displayName})${target.substitutionReason ? ` · ${target.substitutionReason}` : ""}`,
          });
          yield* broadcast(projectId, "mission_updated");

          const startedAtMs = yield* Clock.currentTimeMillis;
          const stepResult = yield* Effect.result(
            deps.runCrewStep({
              missionId: mission.id,
              projectId,
              threadId,
              cwd: mission.worktreePath ?? ctx.workspaceRoot,
              role: args.role,
              providerInstanceId: target.providerInstanceId,
              modelSlug: target.modelSlug,
              displayName: target.displayName,
              prompt: assembled.combinedPrompt,
              isWriteRole: args.isWriteRole,
              worktreePath: mission.worktreePath,
              worktreeBranch: mission.worktreeBranch,
            }),
          );
          const finishedAtMs = yield* Clock.currentTimeMillis;
          const latencyMs = Math.max(0, finishedAtMs - startedAtMs);

          const failureMessage: string | null = Result.isFailure(stepResult)
            ? stepResult.failure.message
            : stepResult.success.resultText.trim().length === 0
              ? `${args.role.displayName} 크루가 빈 응답으로 종료되었습니다.`
              : (stepResult.success.exitCode ?? 0) !== 0
                ? `${args.role.displayName} 크루가 비정상 종료 코드(${stepResult.success.exitCode})로 실패했습니다: ${stepResult.success.resultText.slice(0, 140)}`
                : null;

          if (failureMessage !== null) {
            const errMsg = failureMessage;
            const errHash = computeErrorFingerprint(errMsg);
            const repeatCount =
              mission.lastErrorHash === errHash ? mission.repeatErrorCount + 1 : 1;
            const isRateLimit = /429|rate\s*limit|quota/i.test(errMsg);

            yield* store.recordBudgetUsage({
              projectId,
              missionId: mission.id,
              roleKey: args.role.roleKey,
              providerInstanceId: target.providerInstanceId,
              modelSlug: target.modelSlug,
              promptTokens: assembled.totalTokens,
              cachedTokens: 0,
              completionTokens: 0,
              costUsd: 0,
              latencyMs,
              providerErrorCode: isRateLimit ? "429" : "ERR",
              circuitBreakerFlag: repeatCount >= 2 ? "TRIPPED_TO_INBOX" : null,
            });

            mission = yield* store.updateMissionFenced(mission.id, mission.leaseEpoch, {
              lastErrorHash: errHash,
              repeatErrorCount: repeatCount,
              dagSteps: updateStepInList(mission.dagSteps, args.stepId, {
                status: "FAILED",
                summary: errMsg.slice(0, 140),
                durationMs: latencyMs,
              }),
            });

            yield* store.updateCrewTelemetry({
              projectId,
              roleKey: args.role.roleKey,
              status: isRateLimit ? "RATE_LIMITED" : "ERROR",
              activeMissionId: mission.id,
            });

            yield* tripMissionToInbox({
              mission,
              ctx,
              roleKey: args.role.roleKey,
              providerInstanceId: target.providerInstanceId,
              modelSlug: target.modelSlug,
              triggerReason: repeatCount >= 2 ? "REPEAT_ERROR_HASH" : "CHECKER_CONFLICT",
              riskLevel: "high",
              title: `${args.role.displayName} 실행 오류 (${target.displayName})`,
              context3LinesMd: [
                `1. 실패 모델: ${target.displayName}`,
                `2. 오류 요약: ${errMsg.slice(0, 140)}`,
                `3. 동일 오류 반복 횟수: ${repeatCount}회`,
              ].join("\n"),
              aiRecommendation:
                "크루 카드에서 다른 모델/계정으로 교체한 뒤 `[수정 지시 후 재개]`를 누르시면 이어서 진행됩니다.",
              changedFilesCount: latestChangedFiles.length,
              checkpoint: {
                missionId: mission.id,
                resumeStage: args.stageStatus,
                lastPacket: currentPacket,
                worktreePath: mission.worktreePath,
                worktreeBranch: mission.worktreeBranch,
                coderProviderInstanceId: coderProviderUsed,
              },
              circuitTripped: repeatCount >= 2,
            });
            return { aborted: true as const };
          }

          const out = Result.isSuccess(stepResult)
            ? stepResult.success
            : { resultText: "", exitCode: 1 };
          const promptTokens = out.promptTokens ?? assembled.totalTokens;
          const completionTokens = out.completionTokens ?? estimateTextTokens(out.resultText);
          const crewCacheKey = `${mission.id}:${args.role.roleKey}`;
          const prevHash = lastPrefixHashByCrew.get(crewCacheKey) ?? null;
          const cachedTokens = estimateCachedPromptTokens({
            previousPrefixHash: prevHash,
            currentPrefixHash: assembled.prefixHash,
            layer1Tokens: assembled.layer1Tokens,
            layer2Tokens: assembled.layer2Tokens,
          });
          lastPrefixHashByCrew.set(crewCacheKey, assembled.prefixHash);

          const stepCostUsd = estimateMissionStepCostUsd({
            modelTier: args.role.modelTier,
            promptTokens,
            cachedTokens,
            completionTokens,
          });

          yield* store.recordBudgetUsage({
            projectId,
            missionId: mission.id,
            roleKey: args.role.roleKey,
            providerInstanceId: target.providerInstanceId,
            modelSlug: target.modelSlug,
            promptTokens,
            cachedTokens,
            completionTokens,
            costUsd: stepCostUsd,
            latencyMs,
            ...(out.providerErrorCode ? { providerErrorCode: out.providerErrorCode } : {}),
          });

          // 원문 출력을 Tool Output Valve / CCR에 압축 보관
          const valve = yield* runToolOutputValve(deps.sql, {
            threadId,
            toolName: `mission_${args.role.roleKey}`,
            exitCode: out.exitCode ?? 0,
            rawOutput: out.resultText,
          });
          const artifactId =
            valve.artifactId ??
            (yield* archiveMissionRawArtifact(deps.sql, {
              threadId,
              toolName: `mission_${args.role.roleKey}`,
              rawText: out.resultText,
            }));

          const parsed = parseCrewResultTag(out.resultText);
          const mergedFiles = [...new Set([...(out.changedFiles ?? []), ...parsed.changedFiles])];
          if (mergedFiles.length > 0) {
            latestChangedFiles = [...new Set([...latestChangedFiles, ...mergedFiles])];
          }

          // ForemanMonitor 의미론적 반복 정체 감지 (동일 역할 내 최근 3회 유사도 >= 0.85)
          const normalizedSignature =
            parsed.summary3Lines.join(" ") || out.resultText.slice(0, 400);
          const roleHistory = recentOutputsByRole.get(args.role.roleKey) ?? [];
          let stallDetected = false;
          if (roleHistory.length >= 2) {
            const prev1 = roleHistory[roleHistory.length - 1]!;
            const prev2 = roleHistory[roleHistory.length - 2]!;
            const sim1 = trigramCosineSimilarity(normalizedSignature, prev1);
            const sim2 = trigramCosineSimilarity(normalizedSignature, prev2);
            if (
              sim1 >= MISSION_GUARDRAIL_LIMITS.foremanLoopSimilarityThreshold &&
              sim2 >= MISSION_GUARDRAIL_LIMITS.foremanLoopSimilarityThreshold
            ) {
              stallDetected = true;
            }
          }
          roleHistory.push(normalizedSignature);
          recentOutputsByRole.set(args.role.roleKey, roleHistory);

          // 동일 실패 에러 해시 누적 확인
          let nextErrHash = mission.lastErrorHash;
          let nextRepeatErr = mission.repeatErrorCount;
          if (valve.errorHash) {
            nextRepeatErr =
              mission.lastErrorHash === valve.errorHash ? mission.repeatErrorCount + 1 : 1;
            nextErrHash = valve.errorHash;
          } else {
            nextRepeatErr = 0;
          }

          mission = yield* store.updateMissionFenced(mission.id, mission.leaseEpoch, {
            activeTaskId: out.taskId ?? mission.activeTaskId,
            worktreePath: out.worktreePath ?? mission.worktreePath,
            worktreeBranch: out.worktreeBranch ?? mission.worktreeBranch,
            totalTokensUsed: mission.totalTokensUsed + promptTokens + completionTokens,
            totalCachedTokens: mission.totalCachedTokens + cachedTokens,
            totalCostUsd: Math.round((mission.totalCostUsd + stepCostUsd) * 10_000) / 10_000,
            lastErrorHash: nextErrHash,
            repeatErrorCount: nextRepeatErr,
            dagSteps: updateStepInList(mission.dagSteps, args.stepId, {
              status: parsed.status === "escalate" ? "AWAITING_APPROVAL" : "COMPLETED",
              taskId: out.taskId ?? null,
              worktreePath: out.worktreePath ?? mission.worktreePath,
              worktreeBranch: out.worktreeBranch ?? mission.worktreeBranch,
              summary: parsed.summary3Lines[0] ?? "완료",
              tokensUsed: promptTokens + completionTokens,
              cachedTokens,
              durationMs: latencyMs,
            }),
          });

          yield* store.updateCrewTelemetry({
            projectId,
            roleKey: args.role.roleKey,
            status: "IDLE",
            activeMissionId: null,
            activeTaskId: null,
          });

          if (stallDetected) {
            yield* tripMissionToInbox({
              mission,
              ctx,
              roleKey: args.role.roleKey,
              providerInstanceId: target.providerInstanceId,
              modelSlug: target.modelSlug,
              triggerReason: "STALL_LOOP",
              riskLevel: "high",
              title: "의미론적 반복 정체 감지 (ForemanMonitor 유사도 ≥ 85%)",
              context3LinesMd: [
                `1. 최근 3회 단계 출력이 실질적 진전 없이 반복되고 있습니다.`,
                `2. 마지막 요약: ${parsed.summary3Lines[0] ?? ""}`,
                `3. 누적 토큰 ${mission.totalTokensUsed.toLocaleString()}T · 비용 $${mission.totalCostUsd.toFixed(4)}`,
              ].join("\n"),
              aiRecommendation:
                "명확한 제약이나 대안 접근법을 한 줄 수정 지시로 주시거나, 크루 모델을 교체한 뒤 재개하세요.",
              changedFilesCount: latestChangedFiles.length,
              checkpoint: {
                missionId: mission.id,
                resumeStage: args.stageStatus,
                lastPacket: currentPacket,
                worktreePath: mission.worktreePath,
                worktreeBranch: mission.worktreeBranch,
                coderProviderInstanceId: coderProviderUsed,
              },
              circuitTripped: true,
            });
            return { aborted: true as const };
          }

          if (nextRepeatErr >= MISSION_GUARDRAIL_LIMITS.maxRepeatSameErrorHash) {
            yield* tripMissionToInbox({
              mission,
              ctx,
              roleKey: args.role.roleKey,
              providerInstanceId: target.providerInstanceId,
              modelSlug: target.modelSlug,
              triggerReason: "REPEAT_ERROR_HASH",
              riskLevel: "high",
              title: "동일 에러 해시 2회 반복 자동 차단",
              context3LinesMd: [
                `1. 동일한 오류 지문(${nextErrHash?.slice(0, 12)})이 2회 연속 발생했습니다.`,
                `2. 압축 요약: ${valve.compactText.slice(0, 120)}`,
                `3. 아티팩트 포인터: ${artifactId}`,
              ].join("\n"),
              aiRecommendation:
                "오류 아티팩트를 확인하신 뒤 수정 방향을 한 줄 지시하거나 작업을 반려하세요.",
              changedFilesCount: latestChangedFiles.length,
              checkpoint: {
                missionId: mission.id,
                resumeStage: args.stageStatus,
                lastPacket: currentPacket,
                worktreePath: mission.worktreePath,
                worktreeBranch: mission.worktreeBranch,
                coderProviderInstanceId: coderProviderUsed,
              },
              circuitTripped: true,
            });
            return { aborted: true as const };
          }

          return {
            aborted: false as const,
            parsed,
            artifactId,
            target,
            valve,
            taskId: out.taskId ?? null,
          };
        });

      // Stage 1: PLANNING
      if (input.startStage === "PLANNING") {
        const planRes = yield* runOneRoleStep({
          stepId: "step_plan",
          role: plannerRole,
          stageStatus: "PLANNING",
          isWriteRole: false,
        });
        if (planRes.aborted) return;

        currentPacket = buildCompactHandoffPacket({
          missionId: mission.id,
          hopCount: mission.hopCount,
          reworkCycle: mission.reworkCount,
          fromRole: plannerRole.roleKey,
          toRole: coderRole.roleKey,
          intent: "IMPLEMENT",
          summaryLines: planRes.parsed.summary3Lines,
          worktreePath: mission.worktreePath,
          changedFiles: planRes.parsed.changedFiles,
          artifactIds: [planRes.artifactId],
          taskId: planRes.taskId,
          verificationCriteria: mission.doneCriteria,
        });

        yield* store.recordHandoffMessage({
          missionId: mission.id,
          threadId,
          taskId: planRes.taskId,
          fromActor: plannerRole.displayName,
          toActor: coderRole.displayName,
          type: "dispatch",
          subject: `${plannerRole.displayName} → ${coderRole.displayName} 구현 지시`,
          packet: currentPacket,
        });

        yield* store.appendActivity({
          projectId,
          missionId: mission.id,
          threadId,
          roleKey: plannerRole.roleKey,
          roleDisplayName: plannerRole.displayName,
          level: "success",
          message: `기획 완료 (${currentPacket.estimatedTokens}T 포인터 인계): ${currentPacket.summary3Lines[0] ?? ""}`,
          artifactId: planRes.artifactId,
        });

        if (planRes.parsed.status === "escalate") {
          yield* tripMissionToInbox({
            mission,
            ctx,
            roleKey: plannerRole.roleKey,
            providerInstanceId: planRes.target.providerInstanceId,
            modelSlug: planRes.target.modelSlug,
            triggerReason: "CHECKER_CONFLICT",
            riskLevel: "medium",
            title: "기획 단계 사용자 확인 요청",
            context3LinesMd: currentPacket.summary3Lines.map((l, i) => `${i + 1}. ${l}`).join("\n"),
            aiRecommendation: planRes.parsed.recommendation,
            changedFilesCount: 0,
            checkpoint: {
              missionId: mission.id,
              resumeStage: "EXECUTING",
              lastPacket: currentPacket,
            },
          });
          return;
        }
      }

      // Stage 2 & 3: EXECUTING ↔ VERIFYING (최대 재작업 2회 + 이종 모델 교차 검수)
      let stage: "EXECUTING" | "VERIFYING" =
        input.startStage === "VERIFYING" ? "VERIFYING" : "EXECUTING";

      while (true) {
        if (stage === "EXECUTING") {
          const codeRes = yield* runOneRoleStep({
            stepId: "step_code",
            role: coderRole,
            stageStatus: "EXECUTING",
            isWriteRole: true,
          });
          if (codeRes.aborted) return;

          coderProviderUsed = codeRes.target.providerInstanceId;
          currentPacket = buildCompactHandoffPacket({
            missionId: mission.id,
            hopCount: mission.hopCount,
            reworkCycle: mission.reworkCount,
            fromRole: coderRole.roleKey,
            toRole: reviewerRole.roleKey,
            intent: "VERIFY",
            summaryLines: codeRes.parsed.summary3Lines,
            worktreePath: mission.worktreePath,
            changedFiles: latestChangedFiles,
            artifactIds: [codeRes.artifactId],
            taskId: codeRes.taskId,
            verificationCriteria: mission.doneCriteria,
            verificationProof: {
              command: codeRes.parsed.verificationCmd ?? "coder_step",
              exitCode: codeRes.valve.status === "FAIL" ? 1 : 0,
              artifactId: codeRes.artifactId,
              summary: codeRes.valve.status,
            },
          });

          yield* store.recordHandoffMessage({
            missionId: mission.id,
            threadId,
            taskId: codeRes.taskId,
            fromActor: coderRole.displayName,
            toActor: reviewerRole.displayName,
            type: "worker_done",
            subject: `${coderRole.displayName} → ${reviewerRole.displayName} 이종 검수 요청`,
            packet: currentPacket,
          });

          yield* store.appendActivity({
            projectId,
            missionId: mission.id,
            threadId,
            roleKey: coderRole.roleKey,
            roleDisplayName: coderRole.displayName,
            level: "success",
            message: `구현 완료 (${latestChangedFiles.length}파일 · ${currentPacket.estimatedTokens}T 인계): ${currentPacket.summary3Lines[0] ?? ""}`,
            artifactId: codeRes.artifactId,
          });

          stage = "VERIFYING";
        }

        // VERIFYING: 코더와 다른 이종 프로바이더 우선 배정
        const excludeSet = coderProviderUsed ? new Set([coderProviderUsed]) : undefined;
        const reviewRes = yield* runOneRoleStep({
          stepId: "step_review",
          role: reviewerRole,
          stageStatus: "VERIFYING",
          isWriteRole: false,
          ...(excludeSet ? { excludeProviderIds: excludeSet } : {}),
        });
        if (reviewRes.aborted) return;

        if (reviewRes.parsed.status === "fix_required") {
          const nextRework: number = mission.reworkCount + 1;
          mission = yield* store.updateMissionFenced(mission.id, mission.leaseEpoch, {
            reworkCount: nextRework,
          });

          currentPacket = buildCompactHandoffPacket({
            missionId: mission.id,
            hopCount: mission.hopCount,
            reworkCycle: nextRework,
            fromRole: reviewerRole.roleKey,
            toRole: coderRole.roleKey,
            intent: "FIX_REQUIRED",
            summaryLines: reviewRes.parsed.summary3Lines,
            worktreePath: mission.worktreePath,
            changedFiles: latestChangedFiles,
            artifactIds: [reviewRes.artifactId],
            taskId: reviewRes.taskId,
            verificationCriteria: mission.doneCriteria,
          });

          yield* store.recordHandoffMessage({
            missionId: mission.id,
            threadId,
            taskId: reviewRes.taskId,
            fromActor: reviewerRole.displayName,
            toActor: coderRole.displayName,
            type: "escalation",
            subject: `${reviewerRole.displayName} → ${coderRole.displayName} 보완 지시 (#${nextRework})`,
            packet: currentPacket,
          });

          if (nextRework > MISSION_GUARDRAIL_LIMITS.maxReworkCycles) {
            yield* tripMissionToInbox({
              mission,
              ctx,
              roleKey: reviewerRole.roleKey,
              providerInstanceId: reviewRes.target.providerInstanceId,
              modelSlug: reviewRes.target.modelSlug,
              triggerReason: "REWORK_LIMIT",
              riskLevel: "high",
              title: `이종 검수 반려 상한(${MISSION_GUARDRAIL_LIMITS.maxReworkCycles}회) 초과`,
              context3LinesMd: reviewRes.parsed.summary3Lines
                .map((l, i) => `${i + 1}. ${l}`)
                .join("\n"),
              aiRecommendation: reviewRes.parsed.recommendation,
              changedFilesCount: latestChangedFiles.length,
              checkpoint: {
                missionId: mission.id,
                resumeStage: "EXECUTING",
                lastPacket: currentPacket,
                worktreePath: mission.worktreePath,
                worktreeBranch: mission.worktreeBranch,
                coderProviderInstanceId: coderProviderUsed,
              },
              circuitTripped: true,
            });
            return;
          }

          stage = "EXECUTING";
          continue;
        }

        if (reviewRes.parsed.status === "escalate") {
          yield* tripMissionToInbox({
            mission,
            ctx,
            roleKey: reviewerRole.roleKey,
            providerInstanceId: reviewRes.target.providerInstanceId,
            modelSlug: reviewRes.target.modelSlug,
            triggerReason: "CHECKER_CONFLICT",
            riskLevel: "high",
            title: "감사·검수실 사용자 결정 요청",
            context3LinesMd: reviewRes.parsed.summary3Lines
              .map((l, i) => `${i + 1}. ${l}`)
              .join("\n"),
            aiRecommendation: reviewRes.parsed.recommendation,
            changedFilesCount: latestChangedFiles.length,
            checkpoint: {
              missionId: mission.id,
              resumeStage: "FINAL_APPROVAL",
              lastPacket: currentPacket,
              worktreePath: mission.worktreePath,
              worktreeBranch: mission.worktreeBranch,
              coderProviderInstanceId: coderProviderUsed,
            },
          });
          return;
        }

        // 검수 PASS!
        const approvePacket = buildCompactHandoffPacket({
          missionId: mission.id,
          hopCount: mission.hopCount,
          reworkCycle: mission.reworkCount,
          fromRole: reviewerRole.roleKey,
          toRole: "user",
          intent: "APPROVE",
          summaryLines: reviewRes.parsed.summary3Lines,
          worktreePath: mission.worktreePath,
          changedFiles: latestChangedFiles,
          artifactIds: [reviewRes.artifactId],
          taskId: reviewRes.taskId,
          verificationCriteria: mission.doneCriteria,
        });

        yield* store.recordHandoffMessage({
          missionId: mission.id,
          threadId,
          taskId: reviewRes.taskId,
          fromActor: reviewerRole.displayName,
          toActor: "대표실 (사용자)",
          type: "merge_ready",
          subject: `${reviewerRole.displayName} 검수 통과${reviewRes.target.crossModelDistinct ? " (이종 교차검증)" : ""}`,
          packet: approvePacket,
        });

        // 최종 승인 모드이거나 격리 Worktree가 생성되어 병합 확인이 필요한 경우 Tier 2 결재 상신
        if (flags.requireFinalApproval && (mission.worktreePath || latestChangedFiles.length > 0)) {
          yield* tripMissionToInbox({
            mission,
            ctx,
            roleKey: reviewerRole.roleKey,
            providerInstanceId: reviewRes.target.providerInstanceId,
            modelSlug: reviewRes.target.modelSlug,
            triggerReason: "FINAL_MERGE_CONFIRM",
            riskLevel: "medium",
            title: `최종 결과 승인 및 반영 확인 · ${mission.title}`,
            context3LinesMd: reviewRes.parsed.summary3Lines
              .map((l, i) => `${i + 1}. ${l}`)
              .join("\n"),
            aiRecommendation: `검수 통과(${reviewRes.target.displayName}). 변경 사항 확인 후 [승인]을 누르면 최종 완료${mission.worktreePath ? " 및 Worktree 반영" : ""}됩니다.`,
            changedFilesCount: latestChangedFiles.length,
            diffUri: mission.activeTaskId ? `worker-task://${mission.activeTaskId}` : null,
            checkpoint: {
              missionId: mission.id,
              resumeStage: "FINAL_APPROVAL",
              lastPacket: approvePacket,
              worktreePath: mission.worktreePath,
              worktreeBranch: mission.worktreeBranch,
              coderProviderInstanceId: coderProviderUsed,
            },
          });
          return;
        }

        // 자동 완료 처리
        yield* finalizeMissionCompleted({
          mission,
          summary3Lines: reviewRes.parsed.summary3Lines,
          changedFiles: latestChangedFiles,
          reviewerNote: `${reviewRes.target.displayName} 검수 통과${reviewRes.target.crossModelDistinct ? " (이종 교차)" : ""}`,
        });
        return;
      }
    }).pipe(
      Effect.catch((err) =>
        Effect.logWarning("Mission pipeline ended with error", {
          missionId: input.missionId,
          error: err.message,
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          activeFibers.delete(input.missionId);
        }),
      ),
    );

  const launchMissionFiber = (args: {
    readonly missionId: string;
    readonly startStage: "PLANNING" | "EXECUTING" | "VERIFYING";
    readonly initialPacket?: CompactHandoffPacket | null;
    readonly humanFeedbackNote?: string | null;
    readonly coderProviderOverride?: string | null;
  }) =>
    Effect.gen(function* () {
      const existing = activeFibers.get(args.missionId);
      if (existing) {
        yield* Fiber.interrupt(existing).pipe(Effect.ignore);
        activeFibers.delete(args.missionId);
      }
      const fiber = yield* executeMissionPipeline(args).pipe(Effect.forkIn(scope));
      activeFibers.set(args.missionId, fiber);
    });

  const reconcileOrphanedMissions = (projectId?: ProjectId) =>
    Effect.gen(function* () {
      const orphans = yield* store.listOrphanedActiveMissions(projectId);
      let recovered = 0;
      for (const m of orphans) {
        if (activeFibers.has(m.id)) continue;
        const ctx = yield* deps.resolveProjectContext(m.projectId).pipe(
          Effect.catch(() =>
            Effect.succeed<MissionProjectContext>({
              projectId: m.projectId,
              projectTitle: "프로젝트",
              workspaceRoot: ".",
              providers: [],
            }),
          ),
        );
        const bumped = yield* store
          .updateMissionFenced(m.id, m.leaseEpoch, {
            status: "AWAITING_APPROVAL",
            bumpLeaseEpoch: true,
          })
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!bumped) continue;
        yield* store
          .createApprovalGate({
            projectId: m.projectId,
            missionId: m.id,
            threadId: m.threadId ?? ThreadId.make(`mission-${m.id}`),
            existingTaskId: m.activeTaskId,
            cwd: ctx.workspaceRoot,
            roleKey: m.activeRoleId ?? "planner",
            providerInstanceId: "system",
            modelSlug: "recovery",
            escalationTier: "TIER_2",
            triggerReason: "ORPHAN_RECOVERY",
            riskLevel: "medium",
            title: `재시작으로 중단된 미션 복구 확인 · ${m.title}`,
            context3LinesMd: [
              `1. 서버 재시작 시점에 '${m.status}' 상태로 실행 중이던 미션을 안전 동결했습니다.`,
              `2. lease_epoch를 ${bumped.leaseEpoch}로 올려 이전 프로세스 쓰기를 차단했습니다.`,
              `3. 이어서 실행하려면 [수정 지시 후 재개] 또는 [승인], 중단하려면 [반려]를 선택하세요.`,
            ].join("\n"),
            aiRecommendation: "작업을 이어서 진행하려면 승인 또는 수정 지시를 선택하세요.",
            estimatedCostUsd: bumped.totalCostUsd,
            changedFilesCount: 0,
            worktreePath: bumped.worktreePath,
            worktreeBranch: bumped.worktreeBranch,
            checkpoint: {
              missionId: m.id,
              resumeStage:
                m.status === "VERIFYING"
                  ? "VERIFYING"
                  : m.status === "EXECUTING"
                    ? "EXECUTING"
                    : "PLANNING",
              worktreePath: bumped.worktreePath,
              worktreeBranch: bumped.worktreeBranch,
            },
          })
          .pipe(Effect.ignore);
        recovered += 1;
      }
      return recovered;
    });

  if (deps.reconcileOnBoot !== false) {
    yield* reconcileOrphanedMissions().pipe(Effect.ignore);
  }

  return {
    getSnapshot: (input) => buildSnapshot(input.projectId, input.threadId),

    subscribe: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const initial = yield* buildSnapshot(input.projectId, input.threadId);
          const nowMs = yield* Clock.currentTimeMillis;
          const initialEvent: MissionControlStreamEvent = {
            type: "snapshot",
            projectId: input.projectId,
            snapshot: initial,
            timestampMs: nowMs,
          };
          const live = Stream.fromPubSub(pubsub).pipe(
            Stream.filter((ev) => ev.projectId === input.projectId),
          );
          return Stream.concat(Stream.make(initialEvent), live);
        }),
      ),

    createMission: (input) =>
      Effect.gen(function* () {
        const controlState = yield* store.ensureControlState(input.projectId);
        if (controlState.killSwitchActive) {
          return yield* Effect.fail(
            new MissionControlError({
              code: "KILL_SWITCH_ACTIVE",
              message: "긴급 중지(Kill Switch)가 켜져 있습니다. 먼저 긴급 중지를 해제하세요.",
            }),
          );
        }

        const budgetSummary = yield* store.getDailyBudgetSummary(input.projectId);
        if (budgetSummary.dailySpentUsd >= budgetSummary.dailyLimitUsd) {
          return yield* Effect.fail(
            new MissionControlError({
              code: "BUDGET_EXCEEDED",
              message: `금일 비용 상한($${budgetSummary.dailyLimitUsd.toFixed(2)})에 도달했습니다.`,
            }),
          );
        }

        const ctx = yield* deps.resolveProjectContext(input.projectId);
        const roles = yield* store.ensureDefaultCrewRoles(input.projectId, ctx.providers);
        const title =
          input.title?.trim() ||
          input.goalPrompt.trim().split(/\r?\n/)[0]!.slice(0, 80) ||
          "자율 미션";

        const primaryRole = roles.find((r) => r.roleKey === "planner") ?? roles[0];
        const resolvedPrimary = primaryRole
          ? resolveCrewExecutionTarget({
              role: primaryRole,
              providers: ctx.providers,
              ...(input.roleModelOverrides ? { roleModelOverrides: input.roleModelOverrides } : {}),
            })
          : { providerInstanceId: "codex", modelSlug: "default", displayName: "codex" };

        // 실제 대화창(threadId) 바인딩: 지정된 대화창이 있으면 그대로 사용, 없으면 프로젝트에 새 실제 대화창 생성!
        let boundThreadId: ThreadId | null = input.threadId ?? null;
        if (!boundThreadId && input.createNewThread !== false && deps.createProjectThread) {
          boundThreadId = yield* deps
            .createProjectThread({
              projectId: input.projectId,
              title: `[자율 미션] ${title}`.slice(0, 100),
              providerInstanceId: resolvedPrimary.providerInstanceId,
              modelSlug: resolvedPrimary.modelSlug,
            })
            .pipe(Effect.catch(() => Effect.succeed(null)));
        }

        const missionId = `msn_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
        const assignedRoles =
          input.assignedRoles && input.assignedRoles.length > 0
            ? [...input.assignedRoles]
            : ["planner", "coder", "reviewer"];

        const roleMap = new Map(roles.map((r) => [r.roleKey, r]));
        const dagSteps: MissionDagStep[] = [
          {
            stepId: "step_plan",
            roleKey: "planner",
            roleDisplayName: roleMap.get("planner")?.displayName ?? "기획실",
            title: "목표 분해 및 작업 명세 확정",
            status: "PENDING",
            providerInstanceId: roleMap.get("planner")?.providerInstanceId ?? null,
            modelSlug: roleMap.get("planner")?.modelSlug ?? null,
            taskId: null,
            worktreePath: null,
            worktreeBranch: null,
            summary: null,
            tokensUsed: 0,
            cachedTokens: 0,
            durationMs: 0,
          },
          {
            stepId: "step_code",
            roleKey: "coder",
            roleDisplayName: roleMap.get("coder")?.displayName ?? "개발실",
            title: "격리 작업 및 구현",
            status: "PENDING",
            providerInstanceId: roleMap.get("coder")?.providerInstanceId ?? null,
            modelSlug: roleMap.get("coder")?.modelSlug ?? null,
            taskId: null,
            worktreePath: null,
            worktreeBranch: null,
            summary: null,
            tokensUsed: 0,
            cachedTokens: 0,
            durationMs: 0,
          },
          {
            stepId: "step_review",
            roleKey: "reviewer",
            roleDisplayName: roleMap.get("reviewer")?.displayName ?? "감사·검수실",
            title: "이종 모델 교차 검수",
            status: "PENDING",
            providerInstanceId: roleMap.get("reviewer")?.providerInstanceId ?? null,
            modelSlug: roleMap.get("reviewer")?.modelSlug ?? null,
            taskId: null,
            worktreePath: null,
            worktreeBranch: null,
            summary: null,
            tokensUsed: 0,
            cachedTokens: 0,
            durationMs: 0,
          },
        ];

        const mission = yield* store.createMissionRecord({
          id: missionId,
          projectId: input.projectId,
          threadId: boundThreadId,
          title,
          goalPrompt: input.goalPrompt.trim(),
          doneCriteria: input.doneCriteria ?? [],
          assignedRoles,
          dagSteps,
          executionStyle: input.executionStyle ?? "hierarchical_ops",
          maxSteps: input.maxSteps ?? null,
          maxMinutes: input.maxMinutes ?? null,
          maxTokens: input.maxTokens ?? null,
          verificationCommands: input.verificationCommands ?? [],
          sourceMeetingId: input.sourceMeetingId ?? null,
          budgetLimitUsd: input.budgetLimitUsd ?? MISSION_GUARDRAIL_LIMITS.defaultMissionBudgetUsd,
          requireFinalApproval: input.requireFinalApproval ?? true,
          autoMergeOnApprove: input.autoMergeOnApprove ?? false,
          leaseOwner,
        });

        if (input.roleModelOverrides && input.roleModelOverrides.length > 0) {
          activeOverrides.set(missionId, input.roleModelOverrides);
        }

        yield* store.appendActivity({
          projectId: input.projectId,
          missionId,
          threadId: boundThreadId,
          roleKey: "planner",
          roleDisplayName: "자율 운영실",
          level: "info",
          message: `새 자율 미션 착수: ${title}`,
        });

        yield* postToThread(
          boundThreadId,
          `mission:${missionId}:started`,
          [
            `### 🚀 자율 미션 착수 — ${title}`,
            `- **목표**: ${input.goalPrompt.trim()}`,
            `- **참여 크루**: ${dagSteps.map((s) => `${s.roleDisplayName} (\`${s.providerInstanceId ?? "-"}/${s.modelSlug ?? "-"}\`)`).join(" → ")}`,
            `- **토큰 가드레일**: 턴 ≤ 12K · 홉 ≤ 4 · 예산 ≤ $${mission.budgetLimitUsd.toFixed(2)}`,
          ].join("\n"),
        );

        // Zero-Token 위험 분류: 파괴적 연산/외부 부수효과 감지 시 실행 전 Tier 2 결재 상신!
        const risk = classifyGoalRiskZeroToken(input.goalPrompt);
        if (risk.requiresTier2Approval && risk.triggerReason) {
          const tripped = yield* tripMissionToInbox({
            mission,
            ctx,
            roleKey: "planner",
            providerInstanceId: resolvedPrimary.providerInstanceId,
            modelSlug: resolvedPrimary.modelSlug,
            triggerReason: risk.triggerReason,
            riskLevel: "critical",
            title: `고위험 작업 사전 승인 필요 (${risk.triggerReason})`,
            context3LinesMd: [
              `1. Zero-Token 게이트가 파괴적/외부 부수효과 패턴을 감지했습니다.`,
              `2. 요청 목표: ${title}`,
              `3. 승인 시에만 실제 크루 실행을 시작합니다.`,
            ].join("\n"),
            aiRecommendation:
              "대상이 안전하면 [승인]을, 범위를 제한하려면 한 줄 수정 지시 후 [수정 지시]를 선택하세요.",
            changedFilesCount: 0,
            checkpoint: {
              missionId,
              resumeStage: "PLANNING",
            },
          });
          return tripped.mission;
        }

        yield* launchMissionFiber({ missionId, startStage: "PLANNING" });
        yield* broadcast(input.projectId, "mission_updated");
        return mission;
      }),

    cancelMission: (input) =>
      Effect.gen(function* () {
        const fiber = activeFibers.get(input.missionId);
        if (fiber) {
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
          activeFibers.delete(input.missionId);
        }
        const mission = yield* store.getMission(input.missionId);
        if (!mission) {
          return yield* Effect.fail(
            new MissionControlError({
              code: "NOT_FOUND",
              message: `미션 '${input.missionId}'을(를) 찾을 수 없습니다.`,
            }),
          );
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const nextDagSteps = mission.dagSteps.map((step) =>
          step.status === "COMPLETED" || step.status === "FAILED" || step.status === "SKIPPED"
            ? step
            : {
                ...step,
                status: "SKIPPED" as const,
              },
        );
        const cancelled = yield* store.updateMissionFenced(mission.id, mission.leaseEpoch, {
          status: "CANCELLED",
          activeRoleId: null,
          dagSteps: nextDagSteps,
          completedAtMs: nowMs,
          bumpLeaseEpoch: true,
        });

        // 열려 있는 결재 게이트가 남아있다면 함께 종료 처리한다.
        const openGates = yield* store.listApprovalGates(input.projectId, "pending", undefined, 50);
        for (const gate of openGates) {
          if (gate.missionId === mission.id) {
            yield* store
              .resolveApprovalGate({
                gateId: gate.gateId,
                dbStatus: "denied",
                resolution: "cancelled",
                decisionNote: input.reason?.trim() || "사용자 미션 종료",
              })
              .pipe(Effect.ignore);
          }
        }

        // 이 미션을 담당하던 크루는 즉시 대기(IDLE) 상태로 복귀시킨다.
        const roles = yield* store.listCrewRoles(input.projectId);
        for (const role of roles) {
          if (
            role.activeMissionId === mission.id ||
            (role.roleKey === mission.activeRoleId && role.currentStatus !== "IDLE")
          ) {
            yield* store
              .updateCrewTelemetry({
                projectId: input.projectId,
                roleKey: role.roleKey,
                status: "IDLE",
                activeMissionId: null,
                activeTaskId: null,
              })
              .pipe(Effect.ignore);
          }
        }

        yield* store.appendActivity({
          projectId: input.projectId,
          missionId: mission.id,
          threadId: mission.threadId,
          roleKey: null,
          roleDisplayName: "사용자",
          level: "warn",
          message: `미션 종료됨: ${input.reason?.trim() || "사용자 요청"}`,
        });
        yield* broadcast(input.projectId, "mission_updated");
        return cancelled;
      }),

    deleteMission: (input) =>
      Effect.gen(function* () {
        const fiber = activeFibers.get(input.missionId);
        if (fiber) {
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
          activeFibers.delete(input.missionId);
        }
        const mission = yield* store.getMission(input.missionId);
        if (mission) {
          const roles = yield* store.listCrewRoles(input.projectId);
          for (const role of roles) {
            if (
              role.activeMissionId === mission.id ||
              (role.roleKey === mission.activeRoleId && role.currentStatus !== "IDLE")
            ) {
              yield* store
                .updateCrewTelemetry({
                  projectId: input.projectId,
                  roleKey: role.roleKey,
                  status: "IDLE",
                  activeMissionId: null,
                  activeTaskId: null,
                })
                .pipe(Effect.ignore);
            }
          }
        }
        const result = yield* store.deleteMissionRecord(input.projectId, input.missionId);
        yield* broadcast(input.projectId, "mission_updated");
        return result;
      }),

    decideApproval: (input) =>
      Effect.gen(function* () {
        const detail = yield* store.getApprovalGateDetail(input.gateId);
        if (!detail) {
          return yield* Effect.fail(
            new MissionControlError({
              code: "NOT_FOUND",
              message: `결재 항목 '${input.gateId}'을(를) 찾을 수 없습니다.`,
            }),
          );
        }
        const { card, checkpoint } = detail;
        const nowMs = yield* Clock.currentTimeMillis;

        if (input.action === "snooze") {
          const snoozeMs = Math.max(5, Math.min(1440, input.snoozeMinutes ?? 60)) * 60_000;
          yield* store.resolveApprovalGate({
            gateId: input.gateId,
            dbStatus: "open",
            resolution: "snoozed",
            decisionNote: input.note ?? null,
            snoozedUntilMs: nowMs + snoozeMs,
          });
          yield* store.appendActivity({
            projectId: input.projectId,
            missionId: card.missionId,
            threadId: card.threadId,
            roleKey: null,
            roleDisplayName: "사용자",
            level: "info",
            message: `결재 보류 (${Math.round(snoozeMs / 60_000)}분): ${card.title}`,
          });
          yield* broadcast(input.projectId, "approval_updated");
          return yield* buildSnapshot(input.projectId);
        }

        const mission = card.missionId ? yield* store.getMission(card.missionId) : null;

        if (input.action === "reject_rollback") {
          yield* store.resolveApprovalGate({
            gateId: input.gateId,
            dbStatus: "denied",
            resolution: "reject_rollback",
            decisionNote: input.note ?? null,
          });
          if (mission) {
            if (mission.activeTaskId && mission.worktreePath && deps.discardWorktree) {
              yield* deps.discardWorktree(mission.activeTaskId).pipe(Effect.ignore);
            }
            yield* store
              .updateMissionFenced(mission.id, mission.leaseEpoch, {
                status: "CANCELLED",
                activeRoleId: null,
                completedAtMs: nowMs,
                bumpLeaseEpoch: true,
              })
              .pipe(Effect.ignore);
            yield* postToThread(
              mission.threadId,
              `mission:${mission.id}:rejected:${input.gateId}`,
              `### ↩️ 자율 미션 반려 및 원복 — ${mission.title}\n- 사유: ${input.note?.trim() || "사용자 반려"}`,
            );
          }
          yield* appendHostAuditEntry({
            kind: "approval.rejected",
            actorId: "user",
            actorKind: "human",
            resource: input.gateId,
            payload: { missionId: card.missionId, action: input.action, note: input.note ?? null },
          }).pipe(Effect.provideService(SqlClient.SqlClient, deps.sql), Effect.ignore);
          yield* store.appendActivity({
            projectId: input.projectId,
            missionId: card.missionId,
            threadId: card.threadId,
            roleKey: null,
            roleDisplayName: "사용자",
            level: "warn",
            message: `결재 반려·롤백: ${card.title}`,
          });
          yield* broadcast(input.projectId, "approval_updated");
          return yield* buildSnapshot(input.projectId);
        }

        // approve 또는 modify_resume
        yield* store.resolveApprovalGate({
          gateId: input.gateId,
          dbStatus: "approved",
          resolution: input.action,
          decisionNote: input.note ?? null,
        });

        yield* appendHostAuditEntry({
          kind: "approval.approved",
          actorId: "user",
          actorKind: "human",
          resource: input.gateId,
          payload: { missionId: card.missionId, action: input.action, note: input.note ?? null },
        }).pipe(Effect.provideService(SqlClient.SqlClient, deps.sql), Effect.ignore);

        if (mission) {
          if (input.action === "approve" && checkpoint?.resumeStage === "FINAL_APPROVAL") {
            let mergeNote = "사용자 최종 승인 완료";
            if (mission.activeTaskId && mission.worktreePath && deps.mergeWorktree) {
              const mergeRes = yield* Effect.result(deps.mergeWorktree(mission.activeTaskId));
              mergeNote = Result.isSuccess(mergeRes)
                ? `사용자 승인 및 Worktree 병합 완료 (${mergeRes.success})`
                : `사용자 승인 완료 (Worktree 병합 참고: ${mergeRes.failure.message})`;
            }
            yield* finalizeMissionCompleted({
              mission,
              summary3Lines: checkpoint.lastPacket?.summary3Lines ?? [card.title],
              changedFiles: checkpoint.lastPacket?.pointers.changedFiles ?? [],
              reviewerNote: mergeNote,
            });
          } else {
            // Checkpoint 지점에서 즉시 재개 (서킷 브레이커/재작업 카운트 완화 + 사용자 수정 지시 주입)
            const resumed = yield* store.updateMissionFenced(mission.id, mission.leaseEpoch, {
              status: "EXECUTING",
              circuitBreakerState: "OK",
              repeatErrorCount: 0,
              reworkCount: 0,
              hopCount: Math.max(0, mission.hopCount - 1),
              bumpLeaseEpoch: true,
            });
            const nextStage: "PLANNING" | "EXECUTING" | "VERIFYING" =
              input.action === "modify_resume"
                ? checkpoint?.resumeStage === "PLANNING"
                  ? "PLANNING"
                  : "EXECUTING"
                : checkpoint?.resumeStage === "PLANNING"
                  ? "PLANNING"
                  : checkpoint?.resumeStage === "VERIFYING"
                    ? "VERIFYING"
                    : "EXECUTING";

            yield* store.appendActivity({
              projectId: input.projectId,
              missionId: resumed.id,
              threadId: resumed.threadId,
              roleKey: null,
              roleDisplayName: "사용자",
              level: "info",
              message:
                input.action === "modify_resume"
                  ? `수정 지시 후 재개 (${nextStage}): ${input.note?.trim() ?? ""}`
                  : `결재 승인 후 재개 (${nextStage}): ${card.title}`,
            });

            yield* launchMissionFiber({
              missionId: resumed.id,
              startStage: nextStage,
              initialPacket: checkpoint?.lastPacket ?? null,
              humanFeedbackNote: input.note?.trim() || null,
              coderProviderOverride: checkpoint?.coderProviderInstanceId ?? null,
            });
          }
        }

        yield* broadcast(input.projectId, "approval_updated");
        return yield* buildSnapshot(input.projectId);
      }),

    upsertCrewRole: (input) =>
      Effect.gen(function* () {
        const saved = yield* store.upsertCrewRole(input);
        // Sync updated crew model onto PENDING DAG steps of active/waiting missions
        // so the Mission Pipeline board immediately reflects the newly chosen model.
        const projectMissions = yield* store.listMissions(input.projectId, undefined, 20);
        let syncedAnyMission = false;
        for (const mission of projectMissions) {
          if (
            mission.status === "COMPLETED" ||
            mission.status === "FAILED" ||
            mission.status === "CANCELLED"
          ) {
            continue;
          }
          let changed = false;
          const nextSteps = mission.dagSteps.map((step) => {
            if (step.roleKey === saved.roleKey && step.status === "PENDING") {
              if (
                step.providerInstanceId !== saved.providerInstanceId ||
                step.modelSlug !== saved.modelSlug ||
                step.roleDisplayName !== saved.displayName
              ) {
                changed = true;
                return {
                  ...step,
                  roleDisplayName: saved.displayName,
                  providerInstanceId: saved.providerInstanceId,
                  modelSlug: saved.modelSlug,
                };
              }
            }
            return step;
          });
          if (changed) {
            yield* store
              .updateMissionFenced(mission.id, mission.leaseEpoch, { dagSteps: nextSteps })
              .pipe(Effect.ignore);
            syncedAnyMission = true;
          }
        }
        yield* store.appendActivity({
          projectId: input.projectId,
          roleKey: saved.roleKey,
          roleDisplayName: saved.displayName,
          level: "info",
          message: `크루 모델 변경 저장: ${saved.displayName} → ${saved.providerInstanceId}/${saved.modelSlug} (${saved.modelTier})`,
        });
        yield* broadcast(input.projectId, syncedAnyMission ? "mission_updated" : "crew_updated");
        return saved;
      }),

    deleteCrewRole: (input) =>
      Effect.gen(function* () {
        const res = yield* store.deleteCrewRole(input.projectId, input.roleId);
        yield* broadcast(input.projectId, "crew_updated");
        return res;
      }),

    startSyncMeeting: (input) =>
      Effect.gen(function* () {
        const ctx = yield* deps.resolveProjectContext(input.projectId);
        const allRoles = yield* store.ensureDefaultCrewRoles(input.projectId, ctx.providers);
        const selectedKeys =
          input.participantRoleKeys && input.participantRoleKeys.length > 0
            ? new Set(input.participantRoleKeys)
            : new Set(["planner", "coder", "reviewer"]);
        const participants = allRoles
          .filter((r) => r.enabled && selectedKeys.has(r.roleKey))
          .slice(0, 3);
        const threadId = input.threadId ?? ThreadId.make(`sync-${input.projectId}`);
        const meetingMissionId =
          input.missionId ?? `sync_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

        const lines: string[] = [];
        for (const role of participants) {
          const target = resolveCrewExecutionTarget({ role, providers: ctx.providers });
          const nowMs = yield* Clock.currentTimeMillis;
          const assembled = assembleCacheAlignedMissionPrompt({
            role,
            projectTitle: ctx.projectTitle,
            missionTitle: `크루 싱크 회의: ${input.topic.slice(0, 60)}`,
            goalPrompt: `안건: ${input.topic}\n당신의 역할 관점에서 핵심 의견 1~2줄과 실행 제안을 답하라.`,
            doneCriteria: ["3줄 이내 핵심 제안"],
            turnNumber: 1,
            nowIso: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          });

          const stepRes = yield* Effect.result(
            deps.runCrewStep({
              missionId: meetingMissionId,
              projectId: input.projectId,
              threadId,
              cwd: ctx.workspaceRoot,
              role,
              providerInstanceId: target.providerInstanceId,
              modelSlug: target.modelSlug,
              displayName: target.displayName,
              prompt: assembled.combinedPrompt,
              isWriteRole: false,
            }),
          );
          const summary = Result.isSuccess(stepRes)
            ? (parseCrewResultTag(stepRes.success.resultText).summary3Lines[0] ?? "의견 제출 완료")
            : `응답 지연 (${stepRes.failure.message.slice(0, 80)})`;
          lines.push(`- **${role.displayName}** (\`${target.displayName}\`): ${summary}`);
        }

        const reportBody = [
          `## 🤝 크루 싱크 회의 결과`,
          `- **안건**: ${input.topic}`,
          "",
          "### 참여 크루 요약",
          ...(lines.length > 0 ? lines : ["- 참여 가능한 활성 크루가 없습니다."]),
        ].join("\n");

        yield* store.insertReport({
          projectId: input.projectId,
          missionId: input.missionId ?? null,
          threadId: input.threadId ?? null,
          scope: "DAILY_DIGEST",
          title: `회의록 · ${input.topic.slice(0, 60)}`,
          bodyMd: reportBody,
          summary3Lines: lines.slice(0, 3),
        });

        yield* store.appendActivity({
          projectId: input.projectId,
          missionId: input.missionId ?? null,
          threadId: input.threadId ?? null,
          roleKey: "planner",
          roleDisplayName: "회의 소집",
          level: "success",
          message: `크루 싱크 회의 완료 (${participants.length}명 참여): ${input.topic.slice(0, 80)}`,
        });

        yield* postToThread(input.threadId ?? null, `mission:sync:${meetingMissionId}`, reportBody);

        yield* broadcast(input.projectId, "report_updated");
        return yield* buildSnapshot(input.projectId);
      }),

    killSwitch: (input) =>
      Effect.gen(function* () {
        yield* store.setKillSwitch(input.projectId, input.active, input.reason ?? null);
        if (input.active) {
          const activeList = yield* store.listOrphanedActiveMissions(input.projectId);
          for (const m of activeList) {
            const fiber = activeFibers.get(m.id);
            if (fiber) {
              yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
              activeFibers.delete(m.id);
            }
            const nextDagSteps = m.dagSteps.map((step) =>
              step.status === "RUNNING" || step.status === "VERIFYING"
                ? { ...step, status: "AWAITING_APPROVAL" as const }
                : step,
            );
            yield* store
              .updateMissionFenced(m.id, m.leaseEpoch, {
                status: "AWAITING_APPROVAL",
                circuitBreakerState: "TRIPPED_TO_INBOX",
                activeRoleId: null,
                dagSteps: nextDagSteps,
                bumpLeaseEpoch: true,
              })
              .pipe(Effect.ignore);
          }
          const roles = yield* store.listCrewRoles(input.projectId);
          for (const r of roles) {
            if (r.currentStatus === "WORKING" || r.currentStatus === "BLOCKED") {
              yield* store.updateCrewTelemetry({
                projectId: input.projectId,
                roleKey: r.roleKey,
                status: "IDLE",
                activeMissionId: null,
                activeTaskId: null,
              });
            }
          }
        } else {
          // 재가동 시 미션이 연결되지 않은 BLOCKED/ERROR 크루를 대기(IDLE) 상태로 정상 복귀한다.
          const roles = yield* store.listCrewRoles(input.projectId);
          for (const r of roles) {
            if (r.currentStatus === "BLOCKED" && !r.activeMissionId) {
              yield* store.updateCrewTelemetry({
                projectId: input.projectId,
                roleKey: r.roleKey,
                status: "IDLE",
                activeMissionId: null,
                activeTaskId: null,
              });
            }
          }
        }
        yield* store.appendActivity({
          projectId: input.projectId,
          roleKey: null,
          roleDisplayName: "자율 운영실",
          level: input.active ? "error" : "success",
          message: input.active
            ? `자율 운영실 중지·종료됨 (${input.reason?.trim() || "사용자 즉시 중지"})`
            : "자율 운영실 재가동됨 — 자율 미션을 다시 실행할 수 있습니다.",
        });
        yield* broadcast(input.projectId, "kill_switch");
        return yield* buildSnapshot(input.projectId);
      }),

    generateDigestNow: (input) =>
      Effect.gen(function* () {
        // Map-Reduce 증분 요약: 각 미션의 `digestLine`만 Reduce하여 LLM 재독 토큰 0으로 일일 보고서 생성
        const [missions, budget, pending] = yield* Effect.all([
          store.listMissions(input.projectId, undefined, 40),
          store.getDailyBudgetSummary(input.projectId),
          store.listApprovalGates(input.projectId, "pending", undefined, 20),
        ]);
        const nowMs = yield* Clock.currentTimeMillis;
        const dayStart = new Date(nowMs);
        dayStart.setHours(0, 0, 0, 0);
        const todayDone = missions.filter(
          (m) =>
            m.status === "COMPLETED" && (m.completedAtMs ?? m.updatedAtMs) >= dayStart.getTime(),
        );
        const activeNow = missions.filter(
          (m) => m.status === "PLANNING" || m.status === "EXECUTING" || m.status === "VERIFYING",
        );

        const summary3Lines = [
          `오늘 완료 미션 ${todayDone.length}건 · 진행 중 ${activeNow.length}건 · 결재 대기 ${pending.length}건`,
          `금일 비용 $${budget.dailySpentUsd.toFixed(4)} / $${budget.dailyLimitUsd.toFixed(2)} · 캐시 히트율 ${budget.cacheHitRatePercent}%`,
          todayDone[0]?.digestLine
            ? `최근 완료: ${todayDone[0].digestLine.slice(0, 70)}`
            : "완료된 미션이 생기면 3줄 증분 요약이 자동으로 누적됩니다.",
        ];

        const bodyMd = [
          `## 📊 자율 운영실 일일 경영 브리핑`,
          "",
          "### 핵심 지표",
          `- 완료: **${todayDone.length}건** · 진행 중: **${activeNow.length}건** · 결재 대기: **${pending.length}건**`,
          `- 금일 비용: **$${budget.dailySpentUsd.toFixed(4)}** / $${budget.dailyLimitUsd.toFixed(2)}`,
          `- 프롬프트 캐시 히트율: **${budget.cacheHitRatePercent}%** (Zero-Token 스킵 ${budget.zeroTokenSkipsCount}회)`,
          "",
          "### 오늘 완료된 미션 (증분 다이제스트)",
          ...(todayDone.length > 0
            ? todayDone.map(
                (m) =>
                  `- **${m.title}**: ${m.digestLine ?? "완료"} ($${m.totalCostUsd.toFixed(4)})`,
              )
            : ["- 오늘 완료된 미션이 아직 없습니다."]),
          "",
          "### 대기 중 결재 항목",
          ...(pending.length > 0
            ? pending.map((g) => `- [${g.triggerReason}] **${g.title}**`)
            : ["- 대기 중인 결재가 없습니다."]),
        ].join("\n");

        const report = yield* store.insertReport({
          projectId: input.projectId,
          scope: "DAILY_DIGEST",
          title: `오늘의 자율 운영 보고서 (${new Date(nowMs).toLocaleDateString("ko-KR")})`,
          bodyMd,
          summary3Lines,
        });
        yield* broadcast(input.projectId, "report_updated");
        return report;
      }),

    runHeartbeatCheck: (input) =>
      Effect.gen(function* () {
        const ctx = yield* deps.resolveProjectContext(input.projectId);
        const pulse = yield* evaluateWorkspacePulseZeroToken(ctx.workspaceRoot);
        const recovered = yield* reconcileOrphanedMissions(input.projectId);
        const nowMs = yield* Clock.currentTimeMillis;

        // Zero-Token 스킵 원장 기록 (LLM 호출 0회!)
        yield* store.recordBudgetUsage({
          projectId: input.projectId,
          roleKey: "zero_token_gate",
          promptTokens: 0,
          cachedTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          latencyMs: 0,
          zeroTokenSkip: true,
        });

        yield* store.appendActivity({
          projectId: input.projectId,
          roleKey: "zero_token_gate",
          roleDisplayName: "Zero-Token 게이트",
          level: "info",
          message: `${pulse.summary}${recovered > 0 ? ` · 고아 미션 ${recovered}건 복구` : ""}`,
        });
        yield* broadcast(input.projectId, "heartbeat");

        return {
          projectId: input.projectId,
          checkedAtMs: nowMs,
          llmCalled: false,
          dirtyFilesCount: pulse.dirtyFilesCount,
          staleMissionsRecovered: recovered,
          summary: pulse.summary,
        };
      }),

    inspectArtifact: (input) =>
      Effect.gen(function* () {
        const found = yield* inspectCcrArtifactById(
          deps.sql,
          input.artifactId,
          input.maxChars ?? 16_000,
        );
        if (!found) {
          return yield* Effect.fail(
            new MissionControlError({
              code: "NOT_FOUND",
              message: `아티팩트 '${input.artifactId}'을(를) 찾을 수 없습니다.`,
            }),
          );
        }
        return found;
      }),

    reconcileOrphanedMissions,

    startRoundtableMeeting: (input) =>
      Effect.gen(function* () {
        const controlState = yield* store.ensureControlState(input.projectId);
        if (controlState.killSwitchActive) {
          return yield* Effect.fail(
            new MissionControlError({
              code: "KILL_SWITCH_ACTIVE",
              message: "자율 운영실이 종료(중지)되어 있습니다. 먼저 운영실을 재가동해 주세요.",
            }),
          );
        }
        const ctx = yield* deps.resolveProjectContext(input.projectId);
        const [allRoles, synapseWeights] = yield* Effect.all([
          store.ensureDefaultCrewRoles(input.projectId, ctx.providers),
          store.listSynapseWeights(input.projectId),
        ]);

        const selection = selectSparseCrewForTopic({
          topic: input.topic,
          roles: allRoles,
          synapseWeights,
          ...(input.moderatorRoleKey ? { requestedModeratorRoleKey: input.moderatorRoleKey } : {}),
          ...(input.participantRoleKeys
            ? { requestedParticipantRoleKeys: input.participantRoleKeys }
            : {}),
          autoSparseSelect: input.autoSparseSelect ?? !input.participantRoleKeys?.length,
        });

        const roleByKey = new Map(allRoles.map((r) => [r.roleKey, r]));
        const moderator = roleByKey.get(selection.moderatorRoleKey) ?? allRoles[0];
        if (!moderator) {
          return yield* Effect.fail(
            new MissionControlError({
              code: "INVALID_STATE",
              message: "회의를 진행할 활성 크루 역할이 없습니다.",
            }),
          );
        }

        const participants = selection.selectedRoleKeys
          .map((k) => roleByKey.get(k))
          .filter((r): r is MissionCrewRole => Boolean(r && r.enabled));

        const meetingId = `mtg_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
        const maxRounds = Math.max(1, Math.min(5, Math.round(input.maxRounds ?? 3)));
        const meetingStyle = input.meetingStyle ?? "roundtable";

        let boundThreadId: ThreadId | null = input.threadId ?? null;
        if (!boundThreadId && input.createNewThread !== false && deps.createProjectThread) {
          const modTarget = resolveCrewExecutionTarget({
            role: moderator,
            providers: ctx.providers,
          });
          boundThreadId = yield* deps
            .createProjectThread({
              projectId: input.projectId,
              title: `[합석 회의] ${input.topic.trim().slice(0, 56)}`,
              providerInstanceId: modTarget.providerInstanceId,
              modelSlug: modTarget.modelSlug,
            })
            .pipe(Effect.orElseSucceed(() => null));
        }

        const created = yield* store.createMeetingRecord({
          id: meetingId,
          projectId: input.projectId,
          threadId: boundThreadId,
          topic: input.topic.trim(),
          moderatorRoleKey: moderator.roleKey,
          moderatorDisplayName: moderator.displayName,
          participantRoleKeys: participants.map((p) => p.roleKey),
          prunedRoleKeys: selection.prunedRoleKeys,
          meetingStyle,
          maxRounds,
        });

        yield* store.appendActivity({
          projectId: input.projectId,
          missionId: meetingId,
          threadId: boundThreadId,
          roleKey: moderator.roleKey,
          roleDisplayName: moderator.displayName,
          level: "info",
          message: `합석 회의 개회 (${meetingStyle === "blind_audit" ? "블라인드 감사" : "전원 동등 대화"}): ${selection.rationale}`,
        });

        yield* postToThread(
          boundThreadId,
          `meeting:${meetingId}:started`,
          [
            `### 🤝 합석 회의 개회 — ${input.topic.trim().slice(0, 120)}`,
            `- **주최자(감독자)**: ${moderator.displayName} (\`${moderator.providerInstanceId}/${moderator.modelSlug}\`) — 진행·합의 판정·최종 종합`,
            `- **동등 참가자 (${participants.length}명 · 직급 무관 동등 발언권)**: ${participants.map((p) => `${p.displayName}`).join(", ")}`,
            selection.prunedRoleKeys.length > 0
              ? `- **Layer 0 희소 비활성화 (토큰 0)**: ${selection.prunedRoleKeys.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );

        const roleTierByKey = new Map<string, MissionOrgTier>(
          allRoles.map((r) => [r.roleKey, r.orgTier ?? "L2_SPECIALIST"]),
        );

        const runMeetingFiber = Effect.gen(function* () {
          const meetingThreadId = boundThreadId ?? ThreadId.make(`meeting-${meetingId}`);
          const allSelectedPackets: MissionSynapsePacket[] = [];
          const allEmittedPackets: MissionSynapsePacket[] = [];
          let priorRoundSelected: MissionSynapsePacket[] = [];
          let totalTokens = 0;
          let estimatedSavedTokens = 0;
          let totalCostUsd = 0;
          let earlyStopReason: string | null = null;
          let finalRound = 0;

          for (let roundNum = 1; roundNum <= maxRounds; roundNum += 1) {
            finalRound = roundNum;
            yield* store.updateMeetingRecord(meetingId, { currentRound: roundNum });
            yield* broadcast(input.projectId, "meeting_updated");

            const roundPackets: MissionSynapsePacket[] = [];

            for (const peer of participants) {
              const target = resolveCrewExecutionTarget({ role: peer, providers: ctx.providers });
              yield* store
                .updateCrewTelemetry({
                  projectId: input.projectId,
                  roleKey: peer.roleKey,
                  status: "WORKING",
                  activeMissionId: meetingId,
                })
                .pipe(Effect.ignore);

              const peerPrompt = buildPeerRoundPrompt({
                topic: input.topic.trim(),
                roundNum,
                maxRounds,
                meetingStyle,
                moderator,
                speaker: peer,
                allParticipants: participants,
                priorSelectedPackets: priorRoundSelected,
              });

              const startedAt = yield* Clock.currentTimeMillis;
              const res = yield* Effect.result(
                deps.runCrewStep({
                  missionId: meetingId,
                  projectId: input.projectId,
                  threadId: meetingThreadId,
                  cwd: ctx.workspaceRoot,
                  role: peer,
                  providerInstanceId: target.providerInstanceId,
                  modelSlug: target.modelSlug,
                  displayName: target.displayName,
                  prompt: peerPrompt,
                  isWriteRole: false,
                }),
              );
              const endedAt = yield* Clock.currentTimeMillis;

              yield* store
                .updateCrewTelemetry({
                  projectId: input.projectId,
                  roleKey: peer.roleKey,
                  status: "IDLE",
                  activeMissionId: null,
                })
                .pipe(Effect.ignore);

              const rawText = Result.isSuccess(res)
                ? res.success.resultText
                : `[참가자 오류: ${res.failure.message.slice(0, 120)}]`;
              const pTokens = Result.isSuccess(res)
                ? (res.success.promptTokens ?? estimateTextTokens(peerPrompt))
                : estimateTextTokens(peerPrompt);
              const cTokens = Result.isSuccess(res)
                ? (res.success.completionTokens ?? estimateTextTokens(rawText))
                : 0;
              const cost = estimateMissionStepCostUsd({
                modelTier: peer.modelTier,
                promptTokens: pTokens,
                cachedTokens: 0,
                completionTokens: cTokens,
              });
              totalTokens += pTokens + cTokens;
              totalCostUsd = Math.round((totalCostUsd + cost) * 10_000) / 10_000;

              yield* store
                .recordBudgetUsage({
                  projectId: input.projectId,
                  missionId: meetingId,
                  roleKey: peer.roleKey,
                  providerInstanceId: target.providerInstanceId,
                  modelSlug: target.modelSlug,
                  promptTokens: pTokens,
                  cachedTokens: 0,
                  completionTokens: cTokens,
                  costUsd: cost,
                  latencyMs: Math.max(0, endedAt - startedAt),
                })
                .pipe(Effect.ignore);

              const packet = parseSynapsePacketFromText({
                meetingId,
                roundNum,
                speaker: peer,
                roleTierByKey,
                rawText,
                nowMs: endedAt,
              });
              roundPackets.push(packet);
            }

            // SMoA Response Selection + Jaccard 중복 제거
            const selectionRes = selectTopSynapsePackets(roundPackets, 4);
            estimatedSavedTokens += selectionRes.estimatedSavedTokens;
            priorRoundSelected = [...selectionRes.selected];
            for (const pkt of selectionRes.packets) {
              yield* store.upsertMeetingPacket(input.projectId, pkt).pipe(Effect.ignore);
              allEmittedPackets.push(pkt);
              if (pkt.selectedForNextRound) allSelectedPackets.push(pkt);
            }

            const stopEval = evaluateMeetingEarlyStop({
              roundPackets: selectionRes.packets,
              currentRound: roundNum,
              maxRounds,
            });
            if (stopEval.shouldStop) {
              earlyStopReason = stopEval.reason;
              break;
            }
          }

          // Layer 3: 주최자(감독자) 단 1회 호출로 최종 메타 통합 (MoA Aggregator)
          const modTarget = resolveCrewExecutionTarget({
            role: moderator,
            providers: ctx.providers,
          });
          yield* store
            .updateCrewTelemetry({
              projectId: input.projectId,
              roleKey: moderator.roleKey,
              status: "WORKING",
              activeMissionId: meetingId,
            })
            .pipe(Effect.ignore);

          const synthPrompt = buildModeratorSynthesisPrompt({
            topic: input.topic.trim(),
            moderator,
            selectedPackets: allSelectedPackets.length > 0 ? allSelectedPackets : allEmittedPackets,
            earlyStopReason,
            prunedRoleKeys: selection.prunedRoleKeys,
          });
          const modStart = yield* Clock.currentTimeMillis;
          const modRes = yield* Effect.result(
            deps.runCrewStep({
              missionId: meetingId,
              projectId: input.projectId,
              threadId: meetingThreadId,
              cwd: ctx.workspaceRoot,
              role: moderator,
              providerInstanceId: modTarget.providerInstanceId,
              modelSlug: modTarget.modelSlug,
              displayName: modTarget.displayName,
              prompt: synthPrompt,
              isWriteRole: false,
            }),
          );
          const modEnd = yield* Clock.currentTimeMillis;

          yield* store
            .updateCrewTelemetry({
              projectId: input.projectId,
              roleKey: moderator.roleKey,
              status: "IDLE",
              activeMissionId: null,
            })
            .pipe(Effect.ignore);

          const finalSynthesisMd =
            Result.isSuccess(modRes) && modRes.success.resultText.trim()
              ? modRes.success.resultText.trim()
              : [
                  `## 감독자 종합 결론 (${moderator.displayName})`,
                  ...allSelectedPackets
                    .slice(-3)
                    .map((p, i) => `${i + 1}. [${p.fromDisplayName}] ${p.claim}`),
                ].join("\n");

          const modPTokens = Result.isSuccess(modRes)
            ? (modRes.success.promptTokens ?? estimateTextTokens(synthPrompt))
            : estimateTextTokens(synthPrompt);
          const modCTokens = Result.isSuccess(modRes)
            ? (modRes.success.completionTokens ?? estimateTextTokens(finalSynthesisMd))
            : 0;
          const modCost = estimateMissionStepCostUsd({
            modelTier: moderator.modelTier,
            promptTokens: modPTokens,
            cachedTokens: 0,
            completionTokens: modCTokens,
          });
          totalTokens += modPTokens + modCTokens;
          totalCostUsd = Math.round((totalCostUsd + modCost) * 10_000) / 10_000;

          yield* store
            .recordBudgetUsage({
              projectId: input.projectId,
              missionId: meetingId,
              roleKey: moderator.roleKey,
              providerInstanceId: modTarget.providerInstanceId,
              modelSlug: modTarget.modelSlug,
              promptTokens: modPTokens,
              cachedTokens: 0,
              completionTokens: modCTokens,
              costUsd: modCost,
              latencyMs: Math.max(0, modEnd - modStart),
            })
            .pipe(Effect.ignore);

          // DyLAN Agent Importance Score & GPTSwarm 시냅스 간선 역전파 갱신
          const backprop = backpropagateMeetingImportance({
            packets: allEmittedPackets,
            finalSynthesisMd,
          });
          for (const pkt of backprop.updatedPackets) {
            yield* store.upsertMeetingPacket(input.projectId, pkt).pipe(Effect.ignore);
          }
          for (const delta of backprop.roleDeltas) {
            const role = roleByKey.get(delta.roleKey);
            if (!role) continue;
            const t = resolveCrewExecutionTarget({ role, providers: ctx.providers });
            yield* store
              .recordSynapseBackprop({
                projectId: input.projectId,
                domainTag: selection.domainTag,
                roleKey: delta.roleKey,
                providerInstanceId: t.providerInstanceId,
                modelSlug: t.modelSlug,
                importanceScore: delta.importanceScore,
                tokenEfficiency: delta.tokenEfficiency,
                adopted: delta.adopted,
              })
              .pipe(Effect.ignore);
          }
          for (const edge of backprop.synapseEdges) {
            yield* store
              .recordSynapseEdge({
                projectId: input.projectId,
                domainTag: selection.domainTag,
                fromRoleKey: edge.fromRoleKey,
                toRoleKey: edge.toRoleKey,
                weight: edge.weight,
              })
              .pipe(Effect.ignore);
          }

          const summaryLines = extractFallbackSummary3Lines(finalSynthesisMd);
          const finishedStatus =
            earlyStopReason && earlyStopReason.includes("조기 종료")
              ? ("CONSENSUS_REACHED" as const)
              : ("COMPLETED" as const);

          yield* store.updateMeetingRecord(meetingId, {
            currentRound: finalRound,
            status: finishedStatus,
            earlyStopReason,
            finalSynthesisMd,
            consensusSummaryLines: summaryLines,
            totalTokens,
            estimatedSavedTokens,
            totalCostUsd,
            completedAtMs: modEnd,
          });

          yield* store.insertReport({
            projectId: input.projectId,
            missionId: meetingId,
            threadId: boundThreadId,
            scope: "MISSION_DONE",
            title: `합석 회의 결론 · ${input.topic.trim().slice(0, 60)}`,
            bodyMd: finalSynthesisMd,
            summary3Lines: summaryLines,
            dedupFingerprint: `meeting_done:${meetingId}`,
          });

          yield* store.appendActivity({
            projectId: input.projectId,
            missionId: meetingId,
            threadId: boundThreadId,
            roleKey: moderator.roleKey,
            roleDisplayName: moderator.displayName,
            level: "success",
            message: `합석 회의 종료 (${finalRound}R · 절감 추정 ${estimatedSavedTokens.toLocaleString()}T): ${summaryLines[0] ?? ""}`,
          });

          yield* postToThread(
            boundThreadId,
            `meeting:${meetingId}:completed`,
            [
              `### 📋 합석 회의 최종 결론 (감독자: ${moderator.displayName})`,
              earlyStopReason ? `> ${earlyStopReason}` : "",
              "",
              finalSynthesisMd,
              "",
              `---`,
              `토큰 ${totalTokens.toLocaleString()}T · 시냅스 압축 절감 ~${estimatedSavedTokens.toLocaleString()}T · 추정 비용 $${totalCostUsd.toFixed(4)}`,
            ]
              .filter(Boolean)
              .join("\n"),
          );

          // SQLite 디스크 상주 RAG 키워드 그래프에 회의 결론 압축 인덱싱
          yield* indexTextArtifactIntoRoutingGraph(deps.sql, {
            projectId: input.projectId,
            nodeKind: ROUTING_NODE_KIND.MEMORY_FACT,
            canonicalKey: `meeting:${meetingId}`,
            title: `합석 회의 결론: ${input.topic.trim().slice(0, 80)}`,
            summaryMoc: summaryLines.join(" / "),
            bodyMarkdown: finalSynthesisMd,
            bodyRefKind: "meeting",
            bodyRefId: meetingId,
            epistemicState: "fact",
            keywords: [
              selection.domainTag,
              "합석회의",
              moderator.roleKey,
              ...selection.selectedRoleKeys,
            ],
            updatedAtMs: modEnd,
          }).pipe(Effect.ignore);

          yield* broadcast(input.projectId, "meeting_updated");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              activeMeetingFibers.delete(meetingId);
            }),
          ),
          Effect.catchCause(() => Effect.void),
        );

        const fiber = yield* Effect.forkIn(runMeetingFiber, scope);
        activeMeetingFibers.set(meetingId, fiber);
        yield* broadcast(input.projectId, "meeting_updated");
        return created;
      }),

    cancelMeeting: (input) =>
      Effect.gen(function* () {
        const fiber = activeMeetingFibers.get(input.meetingId);
        if (fiber) {
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
          activeMeetingFibers.delete(input.meetingId);
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const cancelled = yield* store.updateMeetingRecord(input.meetingId, {
          status: "CANCELLED",
          earlyStopReason: input.reason?.trim() || "사용자 회의 중단",
          completedAtMs: nowMs,
        });
        const roles = yield* store.listCrewRoles(input.projectId);
        for (const role of roles) {
          if (role.activeMissionId === input.meetingId) {
            yield* store
              .updateCrewTelemetry({
                projectId: input.projectId,
                roleKey: role.roleKey,
                status: "IDLE",
                activeMissionId: null,
              })
              .pipe(Effect.ignore);
          }
        }
        yield* broadcast(input.projectId, "meeting_updated");
        return cancelled;
      }),

    deleteMeeting: (input) =>
      Effect.gen(function* () {
        const fiber = activeMeetingFibers.get(input.meetingId);
        if (fiber) {
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
          activeMeetingFibers.delete(input.meetingId);
        }
        const res = yield* store.deleteMeetingRecord(input.projectId, input.meetingId);
        yield* broadcast(input.projectId, "meeting_updated");
        return res;
      }),

    promoteMeetingToMission: (input) =>
      Effect.gen(function* () {
        const meeting = yield* store.getMeeting(input.meetingId);
        if (!meeting) {
          return yield* Effect.fail(
            new MissionControlError({
              code: "NOT_FOUND",
              message: `회의 '${input.meetingId}'을(를) 찾을 수 없습니다.`,
            }),
          );
        }
        const controlState = yield* store.ensureControlState(input.projectId);
        if (controlState.killSwitchActive) {
          yield* store.setKillSwitch(input.projectId, false, "회의 결론 미션 승격으로 자동 재가동");
        }
        const ctx = yield* deps.resolveProjectContext(input.projectId);
        const roles = yield* store.ensureDefaultCrewRoles(input.projectId, ctx.providers);
        const roleMap = new Map(roles.map((r) => [r.roleKey, r]));
        const missionId = `msn_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
        const title = `[회의 실행] ${meeting.topic.slice(0, 56)}`;
        const goalPrompt = [
          `[합석 회의 합의안 기반 실행 지시]`,
          `원래 안건: ${meeting.topic}`,
          "",
          `감독자(${meeting.moderatorDisplayName}) 최종 합의 결론:`,
          meeting.finalSynthesisMd.slice(0, 5_000),
        ].join("\n");
        const assignedRoles = ["planner", "coder", "reviewer"];
        const dagSteps: MissionDagStep[] = [
          {
            stepId: "step_plan",
            roleKey: "planner",
            roleDisplayName: roleMap.get("planner")?.displayName ?? "기획실",
            title: "합의안 기반 작업 분해",
            status: "PENDING",
            providerInstanceId: roleMap.get("planner")?.providerInstanceId ?? null,
            modelSlug: roleMap.get("planner")?.modelSlug ?? null,
            taskId: null,
            worktreePath: null,
            worktreeBranch: null,
            summary: null,
            tokensUsed: 0,
            cachedTokens: 0,
            durationMs: 0,
          },
          {
            stepId: "step_code",
            roleKey: "coder",
            roleDisplayName: roleMap.get("coder")?.displayName ?? "개발실",
            title: "격리 작업 및 구현",
            status: "PENDING",
            providerInstanceId: roleMap.get("coder")?.providerInstanceId ?? null,
            modelSlug: roleMap.get("coder")?.modelSlug ?? null,
            taskId: null,
            worktreePath: null,
            worktreeBranch: null,
            summary: null,
            tokensUsed: 0,
            cachedTokens: 0,
            durationMs: 0,
          },
          {
            stepId: "step_review",
            roleKey: "reviewer",
            roleDisplayName: roleMap.get("reviewer")?.displayName ?? "감사·검수실",
            title: "이종 모델 교차 검수",
            status: "PENDING",
            providerInstanceId: roleMap.get("reviewer")?.providerInstanceId ?? null,
            modelSlug: roleMap.get("reviewer")?.modelSlug ?? null,
            taskId: null,
            worktreePath: null,
            worktreeBranch: null,
            summary: null,
            tokensUsed: 0,
            cachedTokens: 0,
            durationMs: 0,
          },
        ];

        const mission = yield* store.createMissionRecord({
          id: missionId,
          projectId: input.projectId,
          threadId: meeting.threadId,
          title,
          goalPrompt,
          doneCriteria: meeting.consensusSummaryLines.slice(0, 3),
          assignedRoles,
          dagSteps,
          executionStyle: input.executionStyle ?? "hierarchical_ops",
          sourceMeetingId: meeting.id,
          budgetLimitUsd: MISSION_GUARDRAIL_LIMITS.defaultMissionBudgetUsd,
          requireFinalApproval: input.requireFinalApproval ?? true,
          autoMergeOnApprove: false,
          leaseOwner,
        });

        yield* store
          .updateMeetingRecord(meeting.id, { linkedMissionId: mission.id })
          .pipe(Effect.ignore);
        yield* launchMissionFiber({ missionId: mission.id, startStage: "PLANNING" });
        yield* broadcast(input.projectId, "mission_updated");
        return mission;
      }),

    setSynapsePruned: (input) =>
      Effect.gen(function* () {
        const res = yield* store.setSynapsePruned(input);
        yield* broadcast(input.projectId, "crew_updated");
        return res;
      }),

    awaitMission: (missionId) =>
      Effect.gen(function* () {
        const fiber = activeFibers.get(missionId);
        if (!fiber) return;
        yield* Fiber.await(fiber).pipe(Effect.ignore);
      }),

    awaitMeeting: (meetingId) =>
      Effect.gen(function* () {
        const fiber = activeMeetingFibers.get(meetingId);
        if (!fiber) return;
        yield* Fiber.await(fiber).pipe(Effect.ignore);
      }),
  } satisfies MissionOrchestratorShape;
});
