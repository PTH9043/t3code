// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import * as NodeCrypto from "node:crypto";
import {
  MissionControlError,
  ProjectId,
  ThreadId,
  type CompactHandoffPacket,
  type MissionActivityItem,
  type MissionBudgetSummary,
  type MissionCircuitBreakerState,
  type MissionCrewRole,
  type MissionCrewRoleUpsertInput,
  type MissionCrewStatus,
  type MissionDagStep,
  type MissionDecisionCard,
  type MissionEscalationTier,
  type MissionExecutionStyle,
  type MissionHandoffItem,
  type MissionMeetingRecord,
  type MissionMeetingStance,
  type MissionMeetingStatus,
  type MissionMeetingStyle,
  type MissionModelTier,
  type MissionOrgTier,
  type MissionReport,
  type MissionReportScope,
  type MissionRun,
  type MissionStatus,
  type MissionSynapsePacket,
  type MissionSynapseWeightRecord,
  type MissionTriggerReason,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MISSION_GUARDRAIL_LIMITS, computeCacheHitRatePercent } from "./MissionBudgetGuard.ts";
import {
  buildDefaultCrewRoles,
  isMissionCodingCapableModel,
  pickDefaultModelSlug,
} from "./MissionModelRouter.ts";
import { normalizeRoleScopedTools } from "./MissionPromptCacheAssembler.ts";
import { updateEmaScore } from "./SynapseBackpropEngine.ts";

/**
 * SQLite 영속 저장소 (Migration 112 + 기존 109 `worker_tasks` / `worker_mailbox_messages` / `worker_decision_gates`).
 *
 * - 모든 미션 상태 갱신은 `lease_epoch` 조건부 펜싱을 강제해 좀비 프로세스 덮어쓰기를 차단한다.
 * - 프로젝트 최초 접근 시 활성 프로바이더 기반으로 4인 기본 크루를 자동 시드한다.
 */

interface MissionRunRow {
  readonly id: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly title: string;
  readonly goal_prompt: string;
  readonly done_criteria_json: string;
  readonly status: MissionStatus;
  readonly active_role_id: string | null;
  readonly planner_task_id: string | null;
  readonly active_task_id: string | null;
  readonly worktree_path: string | null;
  readonly worktree_branch: string | null;
  readonly assigned_roles_json: string;
  readonly dag_steps_json: string;
  readonly execution_style?: MissionExecutionStyle | null;
  readonly max_steps?: number | null;
  readonly max_minutes?: number | null;
  readonly max_tokens?: number | null;
  readonly verification_commands_json?: string | null;
  readonly source_meeting_id?: string | null;
  readonly require_final_approval: number;
  readonly auto_merge_on_approve: number;
  readonly hop_count: number;
  readonly rework_count: number;
  readonly turn_count: number;
  readonly total_tokens_used: number;
  readonly total_cached_tokens: number;
  readonly total_cost_usd: number;
  readonly budget_limit_usd: number;
  readonly circuit_breaker_state: MissionCircuitBreakerState;
  readonly last_error_hash: string | null;
  readonly repeat_error_count: number;
  readonly lease_owner: string | null;
  readonly lease_epoch: number;
  readonly lease_expires_at_ms: number | null;
  readonly digest_line: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly completed_at_ms: number | null;
}

interface CrewRoleRow {
  readonly id: string;
  readonly project_id: string;
  readonly role_key: string;
  readonly display_name: string;
  readonly description: string;
  readonly provider_instance_id: string;
  readonly model_slug: string;
  readonly model_tier: MissionModelTier;
  readonly org_tier?: MissionOrgTier | null;
  readonly reports_to_role_key?: string | null;
  readonly specialty_tags_json?: string | null;
  readonly can_moderate?: number | null;
  readonly importance_score?: number | null;
  readonly fallback_instance_id: string | null;
  readonly fallback_model_slug: string | null;
  readonly system_directive: string;
  readonly allowed_tools_json: string;
  readonly current_status: MissionCrewStatus;
  readonly active_mission_id: string | null;
  readonly active_task_id: string | null;
  readonly context_percent: number;
  readonly turn_count: number;
  readonly max_turns: number;
  readonly last_heartbeat_at_ms: number | null;
  readonly enabled: number;
  readonly updated_at_ms: number;
}

interface GateRow {
  readonly gate_id: string;
  readonly task_id: string;
  readonly thread_id: string;
  readonly mission_id: string | null;
  readonly project_id: string | null;
  readonly risk_level: "medium" | "high" | "critical";
  readonly question: string;
  readonly status: "open" | "approved" | "denied" | "expired";
  readonly resolution: string | null;
  readonly resolved_by: string | null;
  readonly escalation_tier: MissionEscalationTier | null;
  readonly trigger_reason: MissionTriggerReason | null;
  readonly context_3lines_md: string | null;
  readonly ai_recommendation: string | null;
  readonly risk_cost_json: string | null;
  readonly diff_uri: string | null;
  readonly checkpoint_payload_json: string | null;
  readonly decision_note: string | null;
  readonly decided_by: string | null;
  readonly snoozed_until_ms: number | null;
  readonly created_at_ms: number;
  readonly resolved_at_ms: number | null;
  readonly mission_title: string | null;
  readonly worktree_path: string | null;
}

interface ReportRow {
  readonly id: string;
  readonly project_id: string;
  readonly mission_id: string | null;
  readonly thread_id: string | null;
  readonly scope: MissionReportScope;
  readonly title: string;
  readonly body_md: string;
  readonly summary_3lines_json: string;
  readonly dedup_fingerprint: string | null;
  readonly delivered_telegram: number;
  readonly created_at_ms: number;
}

interface ActivityRow {
  readonly id: string;
  readonly project_id: string;
  readonly mission_id: string | null;
  readonly thread_id: string | null;
  readonly role_key: string | null;
  readonly role_display_name: string;
  readonly level: "info" | "warn" | "error" | "success";
  readonly message: string;
  readonly artifact_id: string | null;
  readonly created_at_ms: number;
}

interface MailboxRow {
  readonly sequence: number;
  readonly message_id: string;
  readonly run_id: string;
  readonly thread_id: string;
  readonly from_actor: string;
  readonly to_actor: string;
  readonly type: string;
  readonly subject: string;
  readonly body: string;
  readonly payload_json: string | null;
  readonly created_at_ms: number;
}

interface MeetingRow {
  readonly id: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly topic: string;
  readonly moderator_role_key: string;
  readonly moderator_display_name: string;
  readonly participant_role_keys_json: string;
  readonly pruned_role_keys_json: string;
  readonly meeting_style: MissionMeetingStyle;
  readonly max_rounds: number;
  readonly current_round: number;
  readonly status: MissionMeetingStatus;
  readonly early_stop_reason: string | null;
  readonly final_synthesis_md: string;
  readonly consensus_summary_lines_json: string;
  readonly linked_mission_id: string | null;
  readonly total_tokens: number;
  readonly estimated_saved_tokens: number;
  readonly total_cost_usd: number;
  readonly created_at_ms: number;
  readonly completed_at_ms: number | null;
}

interface MeetingPacketRow {
  readonly id: string;
  readonly meeting_id: string;
  readonly project_id: string;
  readonly round_num: number;
  readonly from_role_key: string;
  readonly from_display_name: string;
  readonly from_org_tier: MissionOrgTier;
  readonly reply_to_json: string;
  readonly upward_feedback: number;
  readonly stance: MissionMeetingStance;
  readonly claim: string;
  readonly evidence_json: string;
  readonly risk_or_counter: string;
  readonly selected_for_next_round: number;
  readonly importance_contribution: number;
  readonly token_count: number;
  readonly created_at_ms: number;
}

interface SynapseWeightRow {
  readonly project_id: string;
  readonly domain_tag: string;
  readonly role_key: string;
  readonly provider_instance_id: string;
  readonly model_slug: string;
  readonly importance_ema: number;
  readonly token_efficiency_ema: number;
  readonly adoption_rate: number;
  readonly sample_count: number;
  readonly pruned: number;
  readonly updated_at_ms: number;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapMissionRow(row: MissionRunRow): MissionRun {
  return {
    id: row.id,
    projectId: ProjectId.make(row.project_id),
    threadId: row.thread_id ? ThreadId.make(row.thread_id) : null,
    title: row.title,
    goalPrompt: row.goal_prompt,
    doneCriteria: safeJsonParse<string[]>(row.done_criteria_json, []),
    status: row.status,
    activeRoleId: row.active_role_id,
    plannerTaskId: row.planner_task_id,
    activeTaskId: row.active_task_id,
    worktreePath: row.worktree_path,
    worktreeBranch: row.worktree_branch,
    assignedRoles: safeJsonParse<string[]>(row.assigned_roles_json, []),
    dagSteps: safeJsonParse<MissionDagStep[]>(row.dag_steps_json, []),
    executionStyle: row.execution_style ?? "hierarchical_ops",
    maxSteps: row.max_steps ?? null,
    maxMinutes: row.max_minutes ?? null,
    maxTokens: row.max_tokens ?? null,
    verificationCommands: safeJsonParse<string[]>(row.verification_commands_json, []),
    sourceMeetingId: row.source_meeting_id ?? null,
    hopCount: Math.max(0, row.hop_count),
    reworkCount: Math.max(0, row.rework_count),
    turnCount: Math.max(0, row.turn_count),
    totalTokensUsed: Math.max(0, row.total_tokens_used),
    totalCachedTokens: Math.max(0, row.total_cached_tokens),
    totalCostUsd: Number(row.total_cost_usd) || 0,
    budgetLimitUsd:
      Number(row.budget_limit_usd) || MISSION_GUARDRAIL_LIMITS.defaultMissionBudgetUsd,
    circuitBreakerState: row.circuit_breaker_state,
    lastErrorHash: row.last_error_hash,
    repeatErrorCount: Math.max(0, row.repeat_error_count),
    leaseOwner: row.lease_owner,
    leaseEpoch: Math.max(0, row.lease_epoch),
    leaseExpiresAtMs: row.lease_expires_at_ms,
    digestLine: row.digest_line,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    completedAtMs: row.completed_at_ms,
  };
}

function mapCrewRow(row: CrewRoleRow): MissionCrewRole {
  return {
    id: row.id,
    projectId: ProjectId.make(row.project_id),
    roleKey: row.role_key,
    displayName: row.display_name,
    description: row.description,
    providerInstanceId: row.provider_instance_id,
    modelSlug: row.model_slug,
    modelTier: row.model_tier,
    orgTier: row.org_tier ?? "L2_SPECIALIST",
    reportsToRoleKey: row.reports_to_role_key ?? null,
    specialtyTags: safeJsonParse<string[]>(row.specialty_tags_json, []),
    canModerate: (row.can_moderate ?? 0) !== 0,
    importanceScore: Number.isFinite(Number(row.importance_score))
      ? Number(row.importance_score)
      : 0.5,
    fallbackInstanceId: row.fallback_instance_id,
    fallbackModelSlug: row.fallback_model_slug,
    systemDirective: row.system_directive,
    allowedTools: safeJsonParse<string[]>(row.allowed_tools_json, []),
    currentStatus: row.current_status,
    activeMissionId: row.active_mission_id,
    activeTaskId: row.active_task_id,
    contextPercent: Number(row.context_percent) || 0,
    turnCount: Math.max(0, row.turn_count),
    maxTurns: Math.max(1, row.max_turns),
    lastHeartbeatAtMs: row.last_heartbeat_at_ms,
    enabled: row.enabled !== 0,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapGateRow(row: GateRow, fallbackProjectId: ProjectId): MissionDecisionCard {
  const riskCost = safeJsonParse<{
    readonly estimatedCostUsd?: number;
    readonly changedFilesCount?: number;
  }>(row.risk_cost_json, {});
  const mappedStatus =
    row.status === "open" ? "pending" : row.status === "expired" ? "expired" : "resolved";
  return {
    gateId: row.gate_id,
    taskId: row.task_id,
    missionId: row.mission_id,
    projectId: row.project_id ? ProjectId.make(row.project_id) : fallbackProjectId,
    threadId: row.thread_id ? ThreadId.make(row.thread_id) : null,
    missionTitle: row.mission_title ?? "자율 미션",
    escalationTier: row.escalation_tier ?? "TIER_2",
    triggerReason: row.trigger_reason ?? "FINAL_MERGE_CONFIRM",
    status: mappedStatus,
    title: row.question,
    context3LinesMd: row.context_3lines_md ?? row.question,
    aiRecommendation:
      row.ai_recommendation ?? "변경 사항을 검토한 뒤 승인 또는 수정 지시를 선택하세요.",
    riskLevel: row.risk_level,
    estimatedCostUsd: Number(riskCost.estimatedCostUsd ?? 0),
    changedFilesCount: Math.max(0, Number(riskCost.changedFilesCount ?? 0)),
    diffUri: row.diff_uri,
    worktreePath: row.worktree_path,
    decisionNote: row.decision_note,
    decidedBy: row.decided_by ?? row.resolved_by,
    resolution: row.resolution,
    snoozedUntilMs: row.snoozed_until_ms,
    createdAtMs: row.created_at_ms,
    resolvedAtMs: row.resolved_at_ms,
  };
}

function startOfTodayMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface MissionCheckpointPayload {
  readonly missionId: string;
  readonly resumeStage: "PLANNING" | "EXECUTING" | "VERIFYING" | "FINAL_APPROVAL";
  readonly lastPacket?: CompactHandoffPacket | null;
  readonly worktreePath?: string | null;
  readonly worktreeBranch?: string | null;
  readonly coderProviderInstanceId?: string | null;
}

export function makeMissionControlStore(sql: SqlClient.SqlClient) {
  const wrapSqlError = <A, E>(eff: Effect.Effect<A, E>): Effect.Effect<A, MissionControlError> =>
    eff.pipe(
      Effect.mapError(
        (cause) =>
          new MissionControlError({
            code: "EXECUTION_FAILED",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );

  const ensureControlState = (projectId: ProjectId) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        yield* sql`INSERT OR IGNORE INTO mission_control_state (
          project_id, kill_switch_active, kill_switch_reason, daily_limit_usd, updated_at_ms
        ) VALUES (
          ${projectId}, 0, NULL, ${MISSION_GUARDRAIL_LIMITS.defaultDailyBudgetUsd}, ${nowMs}
        )`;
        const rows = yield* sql<{
          readonly kill_switch_active: number;
          readonly kill_switch_reason: string | null;
          readonly daily_limit_usd: number;
        }>`SELECT kill_switch_active, kill_switch_reason, daily_limit_usd
           FROM mission_control_state WHERE project_id = ${projectId} LIMIT 1`;
        const row = rows[0];
        return {
          killSwitchActive: (row?.kill_switch_active ?? 0) !== 0,
          killSwitchReason: row?.kill_switch_reason ?? null,
          dailyLimitUsd:
            Number(row?.daily_limit_usd) || MISSION_GUARDRAIL_LIMITS.defaultDailyBudgetUsd,
        };
      }),
    );

  const setKillSwitch = (projectId: ProjectId, active: boolean, reason?: string | null) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO mission_control_state (
          project_id, kill_switch_active, kill_switch_reason, daily_limit_usd, updated_at_ms
        ) VALUES (
          ${projectId}, ${active ? 1 : 0}, ${reason ?? null},
          ${MISSION_GUARDRAIL_LIMITS.defaultDailyBudgetUsd}, ${nowMs}
        )
        ON CONFLICT(project_id) DO UPDATE SET
          kill_switch_active = excluded.kill_switch_active,
          kill_switch_reason = excluded.kill_switch_reason,
          updated_at_ms = excluded.updated_at_ms`;
      }),
    );

  const listCrewRoles = (projectId: ProjectId) =>
    wrapSqlError(
      sql<CrewRoleRow>`SELECT * FROM mission_crew_roles
        WHERE project_id = ${projectId}
        ORDER BY CASE role_key
          WHEN 'planner' THEN 1
          WHEN 'coder' THEN 2
          WHEN 'reviewer' THEN 3
          WHEN 'digest' THEN 4
          ELSE 10
        END, role_key ASC`.pipe(Effect.map((rows) => rows.map(mapCrewRow))),
    );

  const ensureDefaultCrewRoles = (projectId: ProjectId, providers: ReadonlyArray<ServerProvider>) =>
    Effect.gen(function* () {
      const existing = yield* listCrewRoles(projectId);
      if (existing.length > 0) {
        // Auto-heal any legacy mis-seeded non-coding media model (e.g. video generator)
        // on existing crew roles when healthy coding models are available.
        let healed = false;
        const providerMap = new Map<string, ServerProvider>(
          providers.map((p) => [String(p.instanceId), p]),
        );
        const fallbackSeed =
          providers.length > 0
            ? buildDefaultCrewRoles({ projectId, providers, nowMs: yield* Clock.currentTimeMillis })
            : [];
        for (const role of existing) {
          if (!isMissionCodingCapableModel(role.modelSlug)) {
            const sameProvider = providerMap.get(role.providerInstanceId);
            const sameProviderBest = sameProvider ? pickDefaultModelSlug(sameProvider) : null;
            const replacement =
              sameProviderBest && isMissionCodingCapableModel(sameProviderBest)
                ? { providerInstanceId: role.providerInstanceId, modelSlug: sameProviderBest }
                : (fallbackSeed.find((s) => s.roleKey === role.roleKey) ?? fallbackSeed[0]);
            if (replacement && isMissionCodingCapableModel(replacement.modelSlug)) {
              const nowMs = yield* Clock.currentTimeMillis;
              yield* wrapSqlError(
                sql`UPDATE mission_crew_roles
                    SET provider_instance_id = ${replacement.providerInstanceId},
                        model_slug = ${replacement.modelSlug},
                        updated_at_ms = ${nowMs}
                    WHERE id = ${role.id}`,
              );
              healed = true;
            }
          }
        }
        return healed ? yield* listCrewRoles(projectId) : existing;
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const seeded = buildDefaultCrewRoles({ projectId, providers, nowMs });
      for (const role of seeded) {
        yield* wrapSqlError(
          sql`INSERT OR IGNORE INTO mission_crew_roles (
            id, project_id, role_key, display_name, description,
            provider_instance_id, model_slug, model_tier,
            org_tier, reports_to_role_key, specialty_tags_json, can_moderate, importance_score,
            fallback_instance_id, fallback_model_slug,
            system_directive, allowed_tools_json, current_status,
            active_mission_id, active_task_id, context_percent,
            turn_count, max_turns, last_heartbeat_at_ms, enabled, updated_at_ms
          ) VALUES (
            ${role.id}, ${role.projectId}, ${role.roleKey}, ${role.displayName}, ${role.description},
            ${role.providerInstanceId}, ${role.modelSlug}, ${role.modelTier},
            ${role.orgTier ?? "L2_SPECIALIST"}, ${role.reportsToRoleKey ?? null},
            ${JSON.stringify(role.specialtyTags ?? [])}, ${role.canModerate ? 1 : 0},
            ${role.importanceScore ?? 0.5},
            ${role.fallbackInstanceId}, ${role.fallbackModelSlug},
            ${role.systemDirective}, ${JSON.stringify(role.allowedTools)}, ${role.currentStatus},
            NULL, NULL, 0, 0, ${role.maxTurns}, NULL, 1, ${nowMs}
          )`,
        );
      }
      return yield* listCrewRoles(projectId);
    });

  const upsertCrewRole = (input: MissionCrewRoleUpsertInput) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const normalizedKey = input.roleKey
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "_");
        const id = input.id?.trim() || `crew_${input.projectId}_${normalizedKey}`;
        const tools = normalizeRoleScopedTools(normalizedKey, input.allowedTools);
        const maxTurns = Math.max(1, Math.min(30, Math.round(input.maxTurns ?? 12)));
        const enabled = input.enabled !== false ? 1 : 0;
        const orgTier: MissionOrgTier =
          input.orgTier ??
          (normalizedKey === "commander"
            ? "L0_COMMANDER"
            : normalizedKey === "planner" || normalizedKey === "reviewer"
              ? "L1_LEAD"
              : normalizedKey === "digest"
                ? "L3_SUPPORT"
                : "L2_SPECIALIST");
        const reportsToRoleKey =
          input.reportsToRoleKey !== undefined
            ? input.reportsToRoleKey
            : orgTier === "L2_SPECIALIST" || orgTier === "L3_SUPPORT"
              ? "planner"
              : null;
        const specialtyTags =
          input.specialtyTags && input.specialtyTags.length > 0
            ? [...input.specialtyTags]
            : normalizedKey === "planner"
              ? ["architecture", "planning"]
              : normalizedKey === "coder"
                ? ["coding", "implementation"]
                : normalizedKey === "reviewer"
                  ? ["review", "security", "risk"]
                  : normalizedKey === "digest"
                    ? ["summary", "documentation"]
                    : [normalizedKey];
        const canModerate =
          input.canModerate !== undefined
            ? input.canModerate
              ? 1
              : 0
            : orgTier === "L0_COMMANDER" || orgTier === "L1_LEAD"
              ? 1
              : 0;

        yield* sql`INSERT INTO mission_crew_roles (
          id, project_id, role_key, display_name, description,
          provider_instance_id, model_slug, model_tier,
          org_tier, reports_to_role_key, specialty_tags_json, can_moderate, importance_score,
          fallback_instance_id, fallback_model_slug,
          system_directive, allowed_tools_json, current_status,
          active_mission_id, active_task_id, context_percent,
          turn_count, max_turns, last_heartbeat_at_ms, enabled, updated_at_ms
        ) VALUES (
          ${id}, ${input.projectId}, ${normalizedKey}, ${input.displayName.trim()},
          ${(input.description ?? "").trim()},
          ${input.providerInstanceId.trim()}, ${input.modelSlug.trim()}, ${input.modelTier},
          ${orgTier}, ${reportsToRoleKey}, ${JSON.stringify(specialtyTags)}, ${canModerate}, 0.5,
          ${input.fallbackInstanceId ?? null}, ${input.fallbackModelSlug ?? null},
          ${(input.systemDirective ?? "").trim()}, ${JSON.stringify(tools)}, 'IDLE',
          NULL, NULL, 0, 0, ${maxTurns}, NULL, ${enabled}, ${nowMs}
        )
        ON CONFLICT(project_id, role_key) DO UPDATE SET
          display_name = excluded.display_name,
          description = CASE WHEN excluded.description != '' THEN excluded.description ELSE mission_crew_roles.description END,
          provider_instance_id = excluded.provider_instance_id,
          model_slug = excluded.model_slug,
          model_tier = excluded.model_tier,
          org_tier = ${input.orgTier ? sql`${orgTier}` : sql`mission_crew_roles.org_tier`},
          reports_to_role_key = ${input.reportsToRoleKey !== undefined ? sql`${reportsToRoleKey}` : sql`mission_crew_roles.reports_to_role_key`},
          specialty_tags_json = ${input.specialtyTags ? sql`${JSON.stringify(specialtyTags)}` : sql`mission_crew_roles.specialty_tags_json`},
          can_moderate = ${input.canModerate !== undefined ? sql`${canModerate}` : sql`mission_crew_roles.can_moderate`},
          fallback_instance_id = excluded.fallback_instance_id,
          fallback_model_slug = excluded.fallback_model_slug,
          system_directive = CASE WHEN excluded.system_directive != '' THEN excluded.system_directive ELSE mission_crew_roles.system_directive END,
          allowed_tools_json = excluded.allowed_tools_json,
          max_turns = excluded.max_turns,
          enabled = excluded.enabled,
          updated_at_ms = excluded.updated_at_ms`;

        const rows = yield* sql<CrewRoleRow>`SELECT * FROM mission_crew_roles
          WHERE project_id = ${input.projectId} AND role_key = ${normalizedKey} LIMIT 1`;
        const row = rows[0];
        if (!row) {
          return yield* new MissionControlError({
            code: "EXECUTION_FAILED",
            message: "크루 저장 후 조회에 실패했습니다.",
          });
        }
        return mapCrewRow(row);
      }),
    );

  const deleteCrewRole = (projectId: ProjectId, roleId: string) =>
    wrapSqlError(
      Effect.gen(function* () {
        yield* sql`DELETE FROM mission_crew_roles WHERE project_id = ${projectId} AND id = ${roleId}`;
        return { deleted: true, roleId };
      }),
    );

  const updateCrewTelemetry = (input: {
    readonly projectId: ProjectId;
    readonly roleKey: string;
    readonly status: MissionCrewStatus;
    readonly activeMissionId: string | null;
    readonly activeTaskId?: string | null;
    readonly contextPercent?: number;
    readonly turnCount?: number;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE mission_crew_roles
          SET current_status = ${input.status},
              active_mission_id = ${input.activeMissionId},
              active_task_id = ${input.activeTaskId ?? null},
              context_percent = COALESCE(${input.contextPercent ?? null}, context_percent),
              turn_count = COALESCE(${input.turnCount ?? null}, turn_count),
              last_heartbeat_at_ms = ${nowMs},
              updated_at_ms = ${nowMs}
          WHERE project_id = ${input.projectId} AND role_key = ${input.roleKey}`;
      }),
    );

  const createMissionRecord = (input: {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId | null;
    readonly title: string;
    readonly goalPrompt: string;
    readonly doneCriteria: ReadonlyArray<string>;
    readonly assignedRoles: ReadonlyArray<string>;
    readonly dagSteps: ReadonlyArray<MissionDagStep>;
    readonly executionStyle?: MissionExecutionStyle | undefined;
    readonly maxSteps?: number | null | undefined;
    readonly maxMinutes?: number | null | undefined;
    readonly maxTokens?: number | null | undefined;
    readonly verificationCommands?: ReadonlyArray<string> | undefined;
    readonly sourceMeetingId?: string | null | undefined;
    readonly budgetLimitUsd: number;
    readonly requireFinalApproval: boolean;
    readonly autoMergeOnApprove: boolean;
    readonly leaseOwner: string;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const leaseExpiresAtMs = nowMs + MISSION_GUARDRAIL_LIMITS.maxMissionDurationMs;
        yield* sql`INSERT INTO mission_runs (
          id, project_id, thread_id, title, goal_prompt, done_criteria_json, status,
          active_role_id, planner_task_id, active_task_id, worktree_path, worktree_branch,
          assigned_roles_json, dag_steps_json,
          execution_style, max_steps, max_minutes, max_tokens, verification_commands_json, source_meeting_id,
          require_final_approval, auto_merge_on_approve,
          hop_count, rework_count, turn_count, total_tokens_used, total_cached_tokens,
          total_cost_usd, budget_limit_usd, circuit_breaker_state, last_error_hash,
          repeat_error_count, lease_owner, lease_epoch, lease_expires_at_ms, digest_line,
          created_at_ms, updated_at_ms, completed_at_ms
        ) VALUES (
          ${input.id}, ${input.projectId}, ${input.threadId}, ${input.title}, ${input.goalPrompt},
          ${JSON.stringify(input.doneCriteria)}, 'CREATED',
          NULL, NULL, NULL, NULL, NULL,
          ${JSON.stringify(input.assignedRoles)}, ${JSON.stringify(input.dagSteps)},
          ${input.executionStyle ?? "hierarchical_ops"}, ${input.maxSteps ?? null},
          ${input.maxMinutes ?? null}, ${input.maxTokens ?? null},
          ${JSON.stringify(input.verificationCommands ?? [])}, ${input.sourceMeetingId ?? null},
          ${input.requireFinalApproval ? 1 : 0}, ${input.autoMergeOnApprove ? 1 : 0},
          0, 0, 0, 0, 0,
          0.0, ${input.budgetLimitUsd}, 'OK', NULL,
          0, ${input.leaseOwner}, 1, ${leaseExpiresAtMs}, NULL,
          ${nowMs}, ${nowMs}, NULL
        )`;
        const rows =
          yield* sql<MissionRunRow>`SELECT * FROM mission_runs WHERE id = ${input.id} LIMIT 1`;
        return mapMissionRow(rows[0]!);
      }),
    );

  const getMission = (missionId: string) =>
    wrapSqlError(
      sql<MissionRunRow>`SELECT * FROM mission_runs WHERE id = ${missionId} LIMIT 1`.pipe(
        Effect.map((rows) => (rows[0] ? mapMissionRow(rows[0]) : null)),
      ),
    );

  const getMissionFlags = (missionId: string) =>
    wrapSqlError(
      sql<{
        readonly require_final_approval: number;
        readonly auto_merge_on_approve: number;
      }>`SELECT require_final_approval, auto_merge_on_approve FROM mission_runs WHERE id = ${missionId} LIMIT 1`.pipe(
        Effect.map((rows) => ({
          requireFinalApproval: (rows[0]?.require_final_approval ?? 1) !== 0,
          autoMergeOnApprove: (rows[0]?.auto_merge_on_approve ?? 0) !== 0,
        })),
      ),
    );

  /**
   * `lease_epoch` 조건부 펜싱 업데이트.
   * 예상 `expectedLeaseEpoch`와 불일치하면 `FENCING_CONFLICT`를 발생시켜 좀비 에이전트 쓰기를 차단한다.
   */
  const updateMissionFenced = (
    missionId: string,
    expectedLeaseEpoch: number,
    patch: {
      readonly status?: MissionStatus;
      readonly activeRoleId?: string | null;
      readonly plannerTaskId?: string | null;
      readonly activeTaskId?: string | null;
      readonly worktreePath?: string | null;
      readonly worktreeBranch?: string | null;
      readonly dagSteps?: ReadonlyArray<MissionDagStep>;
      readonly hopCount?: number;
      readonly reworkCount?: number;
      readonly turnCount?: number;
      readonly totalTokensUsed?: number;
      readonly totalCachedTokens?: number;
      readonly totalCostUsd?: number;
      readonly circuitBreakerState?: MissionCircuitBreakerState;
      readonly lastErrorHash?: string | null;
      readonly repeatErrorCount?: number;
      readonly digestLine?: string | null;
      readonly completedAtMs?: number | null;
      readonly bumpLeaseEpoch?: boolean;
    },
  ): Effect.Effect<MissionRun, MissionControlError> =>
    Effect.gen(function* () {
      const current = yield* getMission(missionId);
      if (!current) {
        return yield* Effect.fail(
          new MissionControlError({
            code: "NOT_FOUND",
            message: `미션 '${missionId}'을(를) 찾을 수 없습니다.`,
          }),
        );
      }
      if (current.leaseEpoch !== expectedLeaseEpoch) {
        return yield* Effect.fail(
          new MissionControlError({
            code: "FENCING_CONFLICT",
            message: `미션 '${missionId}'의 lease_epoch 충돌 (기대=${expectedLeaseEpoch}, 현재=${current.leaseEpoch}). 좀비 쓰기가 차단되었습니다.`,
          }),
        );
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const nextEpoch = patch.bumpLeaseEpoch ? expectedLeaseEpoch + 1 : expectedLeaseEpoch;
      const nextStatus = patch.status ?? current.status;
      const nextActiveRoleId =
        patch.activeRoleId !== undefined ? patch.activeRoleId : current.activeRoleId;
      const nextPlannerTaskId =
        patch.plannerTaskId !== undefined ? patch.plannerTaskId : current.plannerTaskId;
      const nextActiveTaskId =
        patch.activeTaskId !== undefined ? patch.activeTaskId : current.activeTaskId;
      const nextWorktreePath =
        patch.worktreePath !== undefined ? patch.worktreePath : current.worktreePath;
      const nextWorktreeBranch =
        patch.worktreeBranch !== undefined ? patch.worktreeBranch : current.worktreeBranch;
      const nextDagSteps = patch.dagSteps ?? current.dagSteps;
      const nextHopCount = patch.hopCount ?? current.hopCount;
      const nextReworkCount = patch.reworkCount ?? current.reworkCount;
      const nextTurnCount = patch.turnCount ?? current.turnCount;
      const nextTotalTokens = patch.totalTokensUsed ?? current.totalTokensUsed;
      const nextTotalCached = patch.totalCachedTokens ?? current.totalCachedTokens;
      const nextTotalCost = patch.totalCostUsd ?? current.totalCostUsd;
      const nextBreaker = patch.circuitBreakerState ?? current.circuitBreakerState;
      const nextErrorHash =
        patch.lastErrorHash !== undefined ? patch.lastErrorHash : current.lastErrorHash;
      const nextRepeatErr = patch.repeatErrorCount ?? current.repeatErrorCount;
      const nextDigestLine = patch.digestLine !== undefined ? patch.digestLine : current.digestLine;
      const nextCompletedAtMs =
        patch.completedAtMs !== undefined ? patch.completedAtMs : current.completedAtMs;
      const nextLeaseExpiresAtMs =
        nextStatus === "COMPLETED" || nextStatus === "FAILED" || nextStatus === "CANCELLED"
          ? null
          : nowMs + MISSION_GUARDRAIL_LIMITS.maxMissionDurationMs;

      yield* wrapSqlError(
        sql`UPDATE mission_runs
          SET status = ${nextStatus},
              active_role_id = ${nextActiveRoleId},
              planner_task_id = ${nextPlannerTaskId},
              active_task_id = ${nextActiveTaskId},
              worktree_path = ${nextWorktreePath},
              worktree_branch = ${nextWorktreeBranch},
              dag_steps_json = ${JSON.stringify(nextDagSteps)},
              hop_count = ${nextHopCount},
              rework_count = ${nextReworkCount},
              turn_count = ${nextTurnCount},
              total_tokens_used = ${nextTotalTokens},
              total_cached_tokens = ${nextTotalCached},
              total_cost_usd = ${nextTotalCost},
              circuit_breaker_state = ${nextBreaker},
              last_error_hash = ${nextErrorHash},
              repeat_error_count = ${nextRepeatErr},
              lease_epoch = ${nextEpoch},
              lease_expires_at_ms = ${nextLeaseExpiresAtMs},
              digest_line = ${nextDigestLine},
              updated_at_ms = ${nowMs},
              completed_at_ms = ${nextCompletedAtMs}
          WHERE id = ${missionId} AND lease_epoch = ${expectedLeaseEpoch}`,
      );

      const updated = yield* getMission(missionId);
      if (!updated || updated.leaseEpoch !== nextEpoch) {
        return yield* Effect.fail(
          new MissionControlError({
            code: "FENCING_CONFLICT",
            message: `미션 '${missionId}'의 동시성 펜싱 검증에 실패했습니다.`,
          }),
        );
      }
      return updated;
    });

  const deleteMissionRecord = (projectId: ProjectId, missionId: string) =>
    wrapSqlError(
      Effect.gen(function* () {
        yield* sql`DELETE FROM worker_decision_gates WHERE project_id = ${projectId} AND mission_id = ${missionId}`;
        yield* sql`DELETE FROM mission_activity_log WHERE project_id = ${projectId} AND mission_id = ${missionId}`;
        yield* sql`DELETE FROM mission_reports WHERE project_id = ${projectId} AND mission_id = ${missionId}`;
        yield* sql`DELETE FROM mission_budget_ledger WHERE project_id = ${projectId} AND mission_id = ${missionId}`;
        yield* sql`DELETE FROM worker_mailbox_messages WHERE run_id = ${missionId}`;
        yield* sql`DELETE FROM mission_runs WHERE project_id = ${projectId} AND id = ${missionId}`;
        return { deleted: true, missionId };
      }),
    );

  const listMissions = (projectId: ProjectId, threadId?: ThreadId, limit = 40) =>
    wrapSqlError(
      (threadId
        ? sql<MissionRunRow>`SELECT * FROM mission_runs
            WHERE project_id = ${projectId} AND thread_id = ${threadId}
            ORDER BY updated_at_ms DESC LIMIT ${limit}`
        : sql<MissionRunRow>`SELECT * FROM mission_runs
            WHERE project_id = ${projectId}
            ORDER BY updated_at_ms DESC LIMIT ${limit}`
      ).pipe(Effect.map((rows) => rows.map(mapMissionRow))),
    );

  const appendActivity = (input: {
    readonly projectId: ProjectId;
    readonly missionId?: string | null;
    readonly threadId?: ThreadId | null;
    readonly roleKey?: string | null;
    readonly roleDisplayName: string;
    readonly level: "info" | "warn" | "error" | "success";
    readonly message: string;
    readonly artifactId?: string | null;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const id = `mact_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        yield* sql`INSERT INTO mission_activity_log (
          id, project_id, mission_id, thread_id, role_key, role_display_name,
          level, message, artifact_id, created_at_ms
        ) VALUES (
          ${id}, ${input.projectId}, ${input.missionId ?? null}, ${input.threadId ?? null},
          ${input.roleKey ?? null}, ${input.roleDisplayName}, ${input.level},
          ${input.message.slice(0, 800)}, ${input.artifactId ?? null}, ${nowMs}
        )`;
        return id;
      }),
    );

  const listActivities = (projectId: ProjectId, threadId?: ThreadId, limit = 60) =>
    wrapSqlError(
      (threadId
        ? sql<ActivityRow>`SELECT * FROM mission_activity_log
            WHERE project_id = ${projectId} AND thread_id = ${threadId}
            ORDER BY created_at_ms DESC LIMIT ${limit}`
        : sql<ActivityRow>`SELECT * FROM mission_activity_log
            WHERE project_id = ${projectId}
            ORDER BY created_at_ms DESC LIMIT ${limit}`
      ).pipe(
        Effect.map(
          (rows): ReadonlyArray<MissionActivityItem> =>
            rows.map((r) => ({
              id: r.id,
              missionId: r.mission_id,
              threadId: r.thread_id ? ThreadId.make(r.thread_id) : null,
              roleKey: r.role_key,
              roleDisplayName: r.role_display_name,
              level: r.level,
              message: r.message,
              artifactId: r.artifact_id,
              createdAtMs: r.created_at_ms,
            })),
        ),
      ),
    );

  const recordHandoffMessage = (input: {
    readonly missionId: string;
    readonly threadId: ThreadId;
    readonly taskId?: string | null;
    readonly fromActor: string;
    readonly toActor: string;
    readonly type:
      | "dispatch"
      | "worker_done"
      | "question"
      | "answer"
      | "escalation"
      | "decision_gate"
      | "heartbeat"
      | "merge_ready"
      | "status";
    readonly subject: string;
    readonly packet: CompactHandoffPacket;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const messageId = `mmsg_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const body = input.packet.summary3Lines.join("\n");
        yield* sql`INSERT INTO worker_mailbox_messages (
          message_id, run_id, thread_id, task_id, dispatch_id, fencing_token,
          from_actor, to_actor, type, outcome, subject, body, payload_json,
          delivery_id, created_at_ms, delivered_at_ms, acknowledged_at_ms
        ) VALUES (
          ${messageId}, ${input.missionId}, ${input.threadId}, ${input.taskId ?? null},
          NULL, ${input.packet.hopCount},
          ${input.fromActor}, ${input.toActor}, ${input.type}, NULL,
          ${input.subject.slice(0, 200)}, ${body}, ${JSON.stringify(input.packet)},
          NULL, ${nowMs}, ${nowMs}, NULL
        )`;
        return messageId;
      }),
    );

  const listHandoffs = (projectId: ProjectId, threadId?: ThreadId, limit = 50) =>
    wrapSqlError(
      (threadId
        ? sql<MailboxRow>`SELECT m.sequence, m.message_id, m.run_id, m.thread_id, m.from_actor,
            m.to_actor, m.type, m.subject, m.body, m.payload_json, m.created_at_ms
            FROM worker_mailbox_messages m
            INNER JOIN mission_runs r ON r.id = m.run_id
            WHERE r.project_id = ${projectId} AND m.thread_id = ${threadId}
            ORDER BY m.sequence DESC LIMIT ${limit}`
        : sql<MailboxRow>`SELECT m.sequence, m.message_id, m.run_id, m.thread_id, m.from_actor,
            m.to_actor, m.type, m.subject, m.body, m.payload_json, m.created_at_ms
            FROM worker_mailbox_messages m
            INNER JOIN mission_runs r ON r.id = m.run_id
            WHERE r.project_id = ${projectId}
            ORDER BY m.sequence DESC LIMIT ${limit}`
      ).pipe(
        Effect.map(
          (rows): ReadonlyArray<MissionHandoffItem> =>
            rows.map((row) => {
              const parsed = safeJsonParse<CompactHandoffPacket | null>(row.payload_json, null);
              const packet = parsed && parsed.schemaVersion === "handoff.v2" ? parsed : null;
              return {
                id: row.message_id,
                missionId: row.run_id,
                threadId: row.thread_id ? ThreadId.make(row.thread_id) : null,
                sequence: row.sequence,
                fromActor: row.from_actor,
                toActor: row.to_actor,
                type: row.type,
                subject: row.subject,
                packet,
                bodyPreview: row.body.slice(0, 300),
                createdAtMs: row.created_at_ms,
              };
            }),
        ),
      ),
    );

  /**
   * 기존 `worker_decision_gates`에 6필드 결재 카드를 생성한다.
   * FK (`worker_tasks`)를 보장하기 위해 필요 시 경량 anchor task 행을 함께 생성한다.
   */
  const createApprovalGate = (input: {
    readonly projectId: ProjectId;
    readonly missionId: string;
    readonly threadId: ThreadId;
    readonly existingTaskId?: string | null;
    readonly cwd: string;
    readonly roleKey: string;
    readonly providerInstanceId: string;
    readonly modelSlug: string;
    readonly escalationTier: MissionEscalationTier;
    readonly triggerReason: MissionTriggerReason;
    readonly riskLevel: "medium" | "high" | "critical";
    readonly title: string;
    readonly context3LinesMd: string;
    readonly aiRecommendation: string;
    readonly estimatedCostUsd: number;
    readonly changedFilesCount: number;
    readonly diffUri?: string | null;
    readonly worktreePath?: string | null;
    readonly worktreeBranch?: string | null;
    readonly checkpoint: MissionCheckpointPayload;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        let taskId = input.existingTaskId?.trim() || "";
        if (taskId) {
          const exists = yield* sql<{ readonly task_id: string }>`
            SELECT task_id FROM worker_tasks WHERE task_id = ${taskId} LIMIT 1
          `;
          if (exists.length === 0) taskId = "";
        }
        if (!taskId) {
          taskId = `mtask_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
          const dedupKey = `mission-gate:${input.missionId}:${nowMs}:${taskId}`;
          yield* sql`INSERT INTO worker_tasks (
            task_id, run_id, thread_id, owner_turn_id, caller_kind,
            dedup_key, idempotency_key, role, target_instance_id, target_model,
            spec_text, rag_facts_json, status, active_dispatch_id, fencing_epoch,
            failure_count, worktree_mode, worktree_path, worktree_branch,
            worktree_base_ref, worktree_state, cwd, outcome_json,
            created_at_ms, updated_at_ms, finished_at_ms,
            mission_id, dag_node_id, role_id
          ) VALUES (
            ${taskId}, ${input.missionId}, ${input.threadId}, NULL, 'orchestra',
            ${dedupKey}, ${dedupKey}, ${input.roleKey}, ${input.providerInstanceId}, ${input.modelSlug},
            ${input.title.slice(0, 600)}, NULL, 'blocked', NULL, 1,
            0, ${input.worktreePath ? "isolated" : "current"},
            ${input.worktreePath ?? null}, ${input.worktreeBranch ?? null},
            NULL, ${input.worktreePath ? "review_ready" : "none"}, ${input.cwd}, NULL,
            ${nowMs}, ${nowMs}, NULL,
            ${input.missionId}, ${input.checkpoint.resumeStage}, ${input.roleKey}
          )`;
        }

        const gateId = `mgate_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
        const riskCostJson = JSON.stringify({
          estimatedCostUsd: input.estimatedCostUsd,
          changedFilesCount: input.changedFilesCount,
        });
        yield* sql`INSERT INTO worker_decision_gates (
          gate_id, task_id, dispatch_id, thread_id, risk_level, question,
          options_json, status, resolution, resolved_by, created_at_ms, resolved_at_ms,
          mission_id, project_id, escalation_tier, trigger_reason, context_3lines_md,
          ai_recommendation, risk_cost_json, diff_uri, checkpoint_payload_json,
          decision_note, decided_by, telegram_message_id, snoozed_until_ms
        ) VALUES (
          ${gateId}, ${taskId}, NULL, ${input.threadId}, ${input.riskLevel}, ${input.title},
          ${JSON.stringify(["승인", "수정 지시 후 재개", "반려·폐기", "1시간 보류"])},
          'open', NULL, NULL, ${nowMs}, NULL,
          ${input.missionId}, ${input.projectId}, ${input.escalationTier}, ${input.triggerReason},
          ${input.context3LinesMd}, ${input.aiRecommendation}, ${riskCostJson},
          ${input.diffUri ?? null}, ${JSON.stringify(input.checkpoint)},
          NULL, NULL, NULL, NULL
        )`;

        return { gateId, taskId };
      }),
    );

  const getApprovalGateDetail = (gateId: string) =>
    wrapSqlError(
      sql<GateRow>`SELECT g.*, r.title AS mission_title, r.worktree_path AS worktree_path
        FROM worker_decision_gates g
        LEFT JOIN mission_runs r ON r.id = g.mission_id
        WHERE g.gate_id = ${gateId}
        LIMIT 1`.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          if (!row) return null;
          return {
            card: mapGateRow(row, ProjectId.make(row.project_id ?? "unknown")),
            checkpoint: safeJsonParse<MissionCheckpointPayload | null>(
              row.checkpoint_payload_json,
              null,
            ),
            rawStatus: row.status,
          };
        }),
      ),
    );

  const listApprovalGates = (
    projectId: ProjectId,
    filter: "pending" | "resolved",
    threadId?: ThreadId,
    limit = 30,
  ) =>
    wrapSqlError(
      (filter === "pending"
        ? threadId
          ? sql<GateRow>`SELECT g.*, r.title AS mission_title, r.worktree_path AS worktree_path
              FROM worker_decision_gates g
              LEFT JOIN mission_runs r ON r.id = g.mission_id
              WHERE g.project_id = ${projectId} AND g.status = 'open' AND g.thread_id = ${threadId}
              ORDER BY g.created_at_ms DESC LIMIT ${limit}`
          : sql<GateRow>`SELECT g.*, r.title AS mission_title, r.worktree_path AS worktree_path
              FROM worker_decision_gates g
              LEFT JOIN mission_runs r ON r.id = g.mission_id
              WHERE g.project_id = ${projectId} AND g.status = 'open'
              ORDER BY g.created_at_ms DESC LIMIT ${limit}`
        : threadId
          ? sql<GateRow>`SELECT g.*, r.title AS mission_title, r.worktree_path AS worktree_path
              FROM worker_decision_gates g
              LEFT JOIN mission_runs r ON r.id = g.mission_id
              WHERE g.project_id = ${projectId} AND g.status != 'open' AND g.thread_id = ${threadId}
              ORDER BY COALESCE(g.resolved_at_ms, g.created_at_ms) DESC LIMIT ${limit}`
          : sql<GateRow>`SELECT g.*, r.title AS mission_title, r.worktree_path AS worktree_path
              FROM worker_decision_gates g
              LEFT JOIN mission_runs r ON r.id = g.mission_id
              WHERE g.project_id = ${projectId} AND g.status != 'open'
              ORDER BY COALESCE(g.resolved_at_ms, g.created_at_ms) DESC LIMIT ${limit}`
      ).pipe(Effect.map((rows) => rows.map((r) => mapGateRow(r, projectId)))),
    );

  const resolveApprovalGate = (input: {
    readonly gateId: string;
    readonly dbStatus: "open" | "approved" | "denied" | "expired";
    readonly resolution: string;
    readonly decisionNote?: string | null;
    readonly decidedBy?: string;
    readonly snoozedUntilMs?: number | null;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const resolvedAtMs = input.dbStatus === "open" ? null : nowMs;
        yield* sql`UPDATE worker_decision_gates
          SET status = ${input.dbStatus},
              resolution = ${input.resolution},
              resolved_by = ${input.decidedBy ?? "user"},
              decision_note = ${input.decisionNote ?? null},
              decided_by = ${input.decidedBy ?? "user"},
              snoozed_until_ms = ${input.snoozedUntilMs ?? null},
              resolved_at_ms = ${resolvedAtMs}
          WHERE gate_id = ${input.gateId}`;
      }),
    );

  const insertReport = (input: {
    readonly projectId: ProjectId;
    readonly missionId?: string | null;
    readonly threadId?: ThreadId | null;
    readonly scope: MissionReportScope;
    readonly title: string;
    readonly bodyMd: string;
    readonly summary3Lines: ReadonlyArray<string>;
    readonly dedupFingerprint?: string | null;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const id = `mrep_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
        const summary3Lines = input.summary3Lines.slice(0, 3);
        yield* sql`INSERT OR REPLACE INTO mission_reports (
          id, project_id, mission_id, thread_id, scope, title, body_md,
          summary_3lines_json, dedup_fingerprint, delivered_telegram, created_at_ms
        ) VALUES (
          ${id}, ${input.projectId}, ${input.missionId ?? null}, ${input.threadId ?? null},
          ${input.scope}, ${input.title}, ${input.bodyMd},
          ${JSON.stringify(summary3Lines)}, ${input.dedupFingerprint ?? null}, 0, ${nowMs}
        )`;
        const rows = yield* sql<ReportRow>`SELECT * FROM mission_reports WHERE id = ${id} LIMIT 1`;
        const row = rows[0]!;
        return {
          id: row.id,
          projectId: ProjectId.make(row.project_id),
          missionId: row.mission_id,
          threadId: row.thread_id ? ThreadId.make(row.thread_id) : null,
          scope: row.scope,
          title: row.title,
          bodyMd: row.body_md,
          summary3Lines: safeJsonParse<string[]>(row.summary_3lines_json, []),
          dedupFingerprint: row.dedup_fingerprint,
          deliveredTelegram: row.delivered_telegram !== 0,
          createdAtMs: row.created_at_ms,
        } satisfies MissionReport;
      }),
    );

  const listReports = (projectId: ProjectId, limit = 20) =>
    wrapSqlError(
      sql<ReportRow>`SELECT * FROM mission_reports
        WHERE project_id = ${projectId}
        ORDER BY created_at_ms DESC LIMIT ${limit}`.pipe(
        Effect.map(
          (rows): ReadonlyArray<MissionReport> =>
            rows.map((row) => ({
              id: row.id,
              projectId: ProjectId.make(row.project_id),
              missionId: row.mission_id,
              threadId: row.thread_id ? ThreadId.make(row.thread_id) : null,
              scope: row.scope,
              title: row.title,
              bodyMd: row.body_md,
              summary3Lines: safeJsonParse<string[]>(row.summary_3lines_json, []),
              dedupFingerprint: row.dedup_fingerprint,
              deliveredTelegram: row.delivered_telegram !== 0,
              createdAtMs: row.created_at_ms,
            })),
        ),
      ),
    );

  const recordBudgetUsage = (input: {
    readonly projectId: ProjectId;
    readonly missionId?: string | null;
    readonly roleKey?: string | null;
    readonly providerInstanceId?: string | null;
    readonly modelSlug?: string | null;
    readonly promptTokens: number;
    readonly cachedTokens: number;
    readonly completionTokens: number;
    readonly costUsd: number;
    readonly latencyMs: number;
    readonly providerErrorCode?: string | null;
    readonly circuitBreakerFlag?: string | null;
    readonly zeroTokenSkip?: boolean;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO mission_budget_ledger (
          project_id, mission_id, role_key, provider_instance_id, model_slug,
          prompt_tokens, cached_tokens, completion_tokens, cost_usd, latency_ms,
          provider_error_code, circuit_breaker_flag, zero_token_skip, created_at_ms
        ) VALUES (
          ${input.projectId}, ${input.missionId ?? null}, ${input.roleKey ?? null},
          ${input.providerInstanceId ?? null}, ${input.modelSlug ?? null},
          ${Math.max(0, Math.round(input.promptTokens))},
          ${Math.max(0, Math.round(input.cachedTokens))},
          ${Math.max(0, Math.round(input.completionTokens))},
          ${input.costUsd}, ${Math.max(0, Math.round(input.latencyMs))},
          ${input.providerErrorCode ?? null}, ${input.circuitBreakerFlag ?? null},
          ${input.zeroTokenSkip ? 1 : 0}, ${nowMs}
        )`;
      }),
    );

  const getDailyBudgetSummary = (
    projectId: ProjectId,
  ): Effect.Effect<MissionBudgetSummary, MissionControlError> =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const dayStart = startOfTodayMs(nowMs);
      const state = yield* ensureControlState(projectId);
      const rows = yield* wrapSqlError(
        sql<{
          readonly spent_usd: number | null;
          readonly input_tokens: number | null;
          readonly cached_tokens: number | null;
          readonly completion_tokens: number | null;
          readonly zero_skips: number | null;
          readonly circuit_trips: number | null;
          readonly rate_limits: number | null;
        }>`SELECT
            SUM(cost_usd) AS spent_usd,
            SUM(prompt_tokens) AS input_tokens,
            SUM(cached_tokens) AS cached_tokens,
            SUM(completion_tokens) AS completion_tokens,
            SUM(CASE WHEN zero_token_skip != 0 THEN 1 ELSE 0 END) AS zero_skips,
            SUM(CASE WHEN circuit_breaker_flag = 'TRIPPED_TO_INBOX' THEN 1 ELSE 0 END) AS circuit_trips,
            SUM(CASE WHEN provider_error_code = '429' THEN 1 ELSE 0 END) AS rate_limits
          FROM mission_budget_ledger
          WHERE project_id = ${projectId} AND created_at_ms >= ${dayStart}`,
      );
      const agg = rows[0];
      const totalInputTokens = Math.max(0, Number(agg?.input_tokens ?? 0));
      const totalCachedTokens = Math.max(0, Number(agg?.cached_tokens ?? 0));
      return {
        dailySpentUsd: Math.round(Number(agg?.spent_usd ?? 0) * 10_000) / 10_000,
        dailyLimitUsd: state.dailyLimitUsd,
        totalInputTokens,
        totalCachedTokens,
        totalCompletionTokens: Math.max(0, Number(agg?.completion_tokens ?? 0)),
        cacheHitRatePercent: computeCacheHitRatePercent(totalInputTokens, totalCachedTokens),
        zeroTokenSkipsCount: Math.max(0, Number(agg?.zero_skips ?? 0)),
        circuitTripsToday: Math.max(0, Number(agg?.circuit_trips ?? 0)),
        rateLimitErrorsToday: Math.max(0, Number(agg?.rate_limits ?? 0)),
        killSwitchActive: state.killSwitchActive,
      };
    });

  const listOrphanedActiveMissions = (projectId?: ProjectId) =>
    wrapSqlError(
      (projectId
        ? sql<MissionRunRow>`SELECT * FROM mission_runs
            WHERE project_id = ${projectId}
              AND status IN ('CREATED','PLANNING','EXECUTING','VERIFYING')`
        : sql<MissionRunRow>`SELECT * FROM mission_runs
            WHERE status IN ('CREATED','PLANNING','EXECUTING','VERIFYING')`
      ).pipe(Effect.map((rows) => rows.map(mapMissionRow))),
    );

  const countCompletedToday = (projectId: ProjectId) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const dayStart = startOfTodayMs(nowMs);
        const rows = yield* sql<{ readonly cnt: number }>`
          SELECT COUNT(*) AS cnt FROM mission_runs
          WHERE project_id = ${projectId}
            AND status = 'COMPLETED'
            AND COALESCE(completed_at_ms, updated_at_ms) >= ${dayStart}
        `;
        return Math.max(0, Number(rows[0]?.cnt ?? 0));
      }),
    );

  const mapMeetingPacketRow = (row: MeetingPacketRow): MissionSynapsePacket => ({
    id: row.id,
    meetingId: row.meeting_id,
    roundNum: Math.max(0, row.round_num),
    fromRoleKey: row.from_role_key,
    fromDisplayName: row.from_display_name,
    fromOrgTier: row.from_org_tier ?? "L2_SPECIALIST",
    replyToRoleKeys: safeJsonParse<string[]>(row.reply_to_json, []),
    upwardFeedback: row.upward_feedback !== 0,
    stance: row.stance,
    claim: row.claim,
    evidence: safeJsonParse<string[]>(row.evidence_json, []),
    riskOrCounter: row.risk_or_counter ?? "",
    selectedForNextRound: row.selected_for_next_round !== 0,
    importanceContribution: Number(row.importance_contribution) || 0.5,
    tokenCount: Math.max(0, row.token_count),
    createdAtMs: row.created_at_ms,
  });

  const listMeetingPackets = (meetingId: string) =>
    wrapSqlError(
      sql<MeetingPacketRow>`SELECT * FROM mission_meeting_packets
        WHERE meeting_id = ${meetingId}
        ORDER BY round_num ASC, created_at_ms ASC`.pipe(
        Effect.map((rows) => rows.map(mapMeetingPacketRow)),
      ),
    );

  const mapMeetingRow = (
    row: MeetingRow,
    packets: ReadonlyArray<MissionSynapsePacket>,
  ): MissionMeetingRecord => ({
    id: row.id,
    projectId: ProjectId.make(row.project_id),
    threadId: row.thread_id ? ThreadId.make(row.thread_id) : null,
    topic: row.topic,
    moderatorRoleKey: row.moderator_role_key,
    moderatorDisplayName: row.moderator_display_name,
    participantRoleKeys: safeJsonParse<string[]>(row.participant_role_keys_json, []),
    prunedRoleKeys: safeJsonParse<string[]>(row.pruned_role_keys_json, []),
    meetingStyle: row.meeting_style,
    maxRounds: Math.max(1, row.max_rounds),
    currentRound: Math.max(0, row.current_round),
    status: row.status,
    earlyStopReason: row.early_stop_reason,
    finalSynthesisMd: row.final_synthesis_md ?? "",
    consensusSummaryLines: safeJsonParse<string[]>(row.consensus_summary_lines_json, []),
    linkedMissionId: row.linked_mission_id,
    totalTokens: Math.max(0, row.total_tokens),
    estimatedSavedTokens: Math.max(0, row.estimated_saved_tokens),
    totalCostUsd: Number(row.total_cost_usd) || 0,
    packets: [...packets],
    createdAtMs: row.created_at_ms,
    completedAtMs: row.completed_at_ms,
  });

  const createMeetingRecord = (input: {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId | null;
    readonly topic: string;
    readonly moderatorRoleKey: string;
    readonly moderatorDisplayName: string;
    readonly participantRoleKeys: ReadonlyArray<string>;
    readonly prunedRoleKeys: ReadonlyArray<string>;
    readonly meetingStyle: MissionMeetingStyle;
    readonly maxRounds: number;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO mission_meetings (
          id, project_id, thread_id, topic, moderator_role_key, moderator_display_name,
          participant_role_keys_json, pruned_role_keys_json, meeting_style,
          max_rounds, current_round, status, early_stop_reason,
          final_synthesis_md, consensus_summary_lines_json, linked_mission_id,
          total_tokens, estimated_saved_tokens, total_cost_usd, created_at_ms, completed_at_ms
        ) VALUES (
          ${input.id}, ${input.projectId}, ${input.threadId}, ${input.topic},
          ${input.moderatorRoleKey}, ${input.moderatorDisplayName},
          ${JSON.stringify(input.participantRoleKeys)}, ${JSON.stringify(input.prunedRoleKeys)},
          ${input.meetingStyle}, ${input.maxRounds}, 0, 'RUNNING', NULL,
          '', '[]', NULL, 0, 0, 0.0, ${nowMs}, NULL
        )`;
        const rows =
          yield* sql<MeetingRow>`SELECT * FROM mission_meetings WHERE id = ${input.id} LIMIT 1`;
        return mapMeetingRow(rows[0]!, []);
      }),
    );

  const getMeeting = (meetingId: string) =>
    wrapSqlError(
      Effect.gen(function* () {
        const rows =
          yield* sql<MeetingRow>`SELECT * FROM mission_meetings WHERE id = ${meetingId} LIMIT 1`;
        const row = rows[0];
        if (!row) return null;
        const packets = yield* listMeetingPackets(meetingId);
        return mapMeetingRow(row, packets);
      }),
    );

  const listMeetings = (projectId: ProjectId, threadId?: ThreadId, limit = 20) =>
    wrapSqlError(
      Effect.gen(function* () {
        const rows = yield* threadId
          ? sql<MeetingRow>`SELECT * FROM mission_meetings
              WHERE project_id = ${projectId} AND thread_id = ${threadId}
              ORDER BY created_at_ms DESC LIMIT ${limit}`
          : sql<MeetingRow>`SELECT * FROM mission_meetings
              WHERE project_id = ${projectId}
              ORDER BY created_at_ms DESC LIMIT ${limit}`;
        const out: MissionMeetingRecord[] = [];
        for (const row of rows) {
          const packets = yield* listMeetingPackets(row.id);
          out.push(mapMeetingRow(row, packets));
        }
        return out;
      }),
    );

  const updateMeetingRecord = (
    meetingId: string,
    patch: {
      readonly currentRound?: number;
      readonly status?: MissionMeetingStatus;
      readonly earlyStopReason?: string | null;
      readonly finalSynthesisMd?: string;
      readonly consensusSummaryLines?: ReadonlyArray<string>;
      readonly linkedMissionId?: string | null;
      readonly totalTokens?: number;
      readonly estimatedSavedTokens?: number;
      readonly totalCostUsd?: number;
      readonly completedAtMs?: number | null;
    },
  ) =>
    wrapSqlError(
      Effect.gen(function* () {
        const existing = yield* getMeeting(meetingId);
        if (!existing) {
          return yield* new MissionControlError({
            code: "NOT_FOUND",
            message: `회의 '${meetingId}'을(를) 찾을 수 없습니다.`,
          });
        }
        yield* sql`UPDATE mission_meetings
          SET current_round = ${patch.currentRound ?? existing.currentRound},
              status = ${patch.status ?? existing.status},
              early_stop_reason = ${patch.earlyStopReason !== undefined ? patch.earlyStopReason : existing.earlyStopReason},
              final_synthesis_md = ${patch.finalSynthesisMd !== undefined ? patch.finalSynthesisMd : existing.finalSynthesisMd},
              consensus_summary_lines_json = ${JSON.stringify(patch.consensusSummaryLines ?? existing.consensusSummaryLines)},
              linked_mission_id = ${patch.linkedMissionId !== undefined ? patch.linkedMissionId : existing.linkedMissionId},
              total_tokens = ${patch.totalTokens ?? existing.totalTokens},
              estimated_saved_tokens = ${patch.estimatedSavedTokens ?? existing.estimatedSavedTokens},
              total_cost_usd = ${patch.totalCostUsd ?? existing.totalCostUsd},
              completed_at_ms = ${patch.completedAtMs !== undefined ? patch.completedAtMs : existing.completedAtMs}
          WHERE id = ${meetingId}`;
        return (yield* getMeeting(meetingId))!;
      }),
    );

  const deleteMeetingRecord = (projectId: ProjectId, meetingId: string) =>
    wrapSqlError(
      Effect.gen(function* () {
        yield* sql`DELETE FROM mission_meeting_packets WHERE project_id = ${projectId} AND meeting_id = ${meetingId}`;
        yield* sql`DELETE FROM mission_meetings WHERE project_id = ${projectId} AND id = ${meetingId}`;
        return { deleted: true, meetingId };
      }),
    );

  const upsertMeetingPacket = (projectId: ProjectId, packet: MissionSynapsePacket) =>
    wrapSqlError(
      sql`INSERT OR REPLACE INTO mission_meeting_packets (
        id, meeting_id, project_id, round_num, from_role_key, from_display_name,
        from_org_tier, reply_to_json, upward_feedback, stance, claim, evidence_json,
        risk_or_counter, selected_for_next_round, importance_contribution, token_count, created_at_ms
      ) VALUES (
        ${packet.id}, ${packet.meetingId}, ${projectId}, ${packet.roundNum},
        ${packet.fromRoleKey}, ${packet.fromDisplayName}, ${packet.fromOrgTier},
        ${JSON.stringify(packet.replyToRoleKeys)}, ${packet.upwardFeedback ? 1 : 0},
        ${packet.stance}, ${packet.claim}, ${JSON.stringify(packet.evidence)},
        ${packet.riskOrCounter}, ${packet.selectedForNextRound ? 1 : 0},
        ${packet.importanceContribution}, ${packet.tokenCount}, ${packet.createdAtMs}
      )`.pipe(Effect.asVoid),
    );

  const listSynapseWeights = (projectId: ProjectId) =>
    wrapSqlError(
      sql<SynapseWeightRow>`SELECT * FROM mission_synapse_weights
        WHERE project_id = ${projectId}
        ORDER BY importance_ema DESC, sample_count DESC LIMIT 60`.pipe(
        Effect.map(
          (rows): ReadonlyArray<MissionSynapseWeightRecord> =>
            rows.map((r) => ({
              domainTag: r.domain_tag,
              roleKey: r.role_key,
              providerInstanceId: r.provider_instance_id,
              modelSlug: r.model_slug,
              importanceEma: Number(r.importance_ema) || 0.5,
              tokenEfficiencyEma: Number(r.token_efficiency_ema) || 0.5,
              adoptionRate: Number(r.adoption_rate) || 0.5,
              sampleCount: Math.max(0, r.sample_count),
              pruned: r.pruned !== 0,
              updatedAtMs: r.updated_at_ms,
            })),
        ),
      ),
    );

  const recordSynapseBackprop = (input: {
    readonly projectId: ProjectId;
    readonly domainTag: string;
    readonly roleKey: string;
    readonly providerInstanceId: string;
    readonly modelSlug: string;
    readonly importanceScore: number;
    readonly tokenEfficiency: number;
    readonly adopted: boolean;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const rows = yield* sql<SynapseWeightRow>`SELECT * FROM mission_synapse_weights
          WHERE project_id = ${input.projectId}
            AND domain_tag = ${input.domainTag}
            AND role_key = ${input.roleKey}
            AND provider_instance_id = ${input.providerInstanceId}
            AND model_slug = ${input.modelSlug}
          LIMIT 1`;
        const prev = rows[0];
        const prevCount = prev?.sample_count ?? 0;
        const nextImp = updateEmaScore(
          prev?.importance_ema ?? 0.5,
          input.importanceScore,
          prevCount,
        );
        const nextEff = updateEmaScore(
          prev?.token_efficiency_ema ?? 0.5,
          input.tokenEfficiency,
          prevCount,
        );
        const nextAdopt = updateEmaScore(
          prev?.adoption_rate ?? 0.5,
          input.adopted ? 1 : 0,
          prevCount,
        );
        const nextCount = prevCount + 1;
        yield* sql`INSERT INTO mission_synapse_weights (
          project_id, domain_tag, role_key, provider_instance_id, model_slug,
          importance_ema, token_efficiency_ema, adoption_rate, sample_count, pruned, updated_at_ms
        ) VALUES (
          ${input.projectId}, ${input.domainTag}, ${input.roleKey},
          ${input.providerInstanceId}, ${input.modelSlug},
          ${nextImp}, ${nextEff}, ${nextAdopt}, ${nextCount}, ${prev?.pruned ?? 0}, ${nowMs}
        )
        ON CONFLICT(project_id, domain_tag, role_key, provider_instance_id, model_slug) DO UPDATE SET
          importance_ema = excluded.importance_ema,
          token_efficiency_ema = excluded.token_efficiency_ema,
          adoption_rate = excluded.adoption_rate,
          sample_count = excluded.sample_count,
          updated_at_ms = excluded.updated_at_ms`;
        yield* sql`UPDATE mission_crew_roles
          SET importance_score = ${nextImp}, updated_at_ms = ${nowMs}
          WHERE project_id = ${input.projectId} AND role_key = ${input.roleKey}`;
      }),
    );

  const recordSynapseEdge = (input: {
    readonly projectId: ProjectId;
    readonly domainTag: string;
    readonly fromRoleKey: string;
    readonly toRoleKey: string;
    readonly weight: number;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        if (input.fromRoleKey === input.toRoleKey) return;
        const nowMs = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO mission_synapse_edges (
          project_id, domain_tag, from_role_key, to_role_key, edge_weight, helpful_handoffs, updated_at_ms
        ) VALUES (
          ${input.projectId}, ${input.domainTag}, ${input.fromRoleKey}, ${input.toRoleKey},
          ${input.weight}, 1, ${nowMs}
        )
        ON CONFLICT(project_id, domain_tag, from_role_key, to_role_key) DO UPDATE SET
          edge_weight = ROUND(mission_synapse_edges.edge_weight * 0.7 + excluded.edge_weight * 0.3, 3),
          helpful_handoffs = mission_synapse_edges.helpful_handoffs + 1,
          updated_at_ms = excluded.updated_at_ms`;
      }),
    );

  const setSynapsePruned = (input: {
    readonly projectId: ProjectId;
    readonly domainTag: string;
    readonly roleKey: string;
    readonly providerInstanceId: string;
    readonly modelSlug: string;
    readonly pruned: boolean;
  }) =>
    wrapSqlError(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE mission_synapse_weights
          SET pruned = ${input.pruned ? 1 : 0}, updated_at_ms = ${nowMs}
          WHERE project_id = ${input.projectId}
            AND domain_tag = ${input.domainTag}
            AND role_key = ${input.roleKey}
            AND provider_instance_id = ${input.providerInstanceId}
            AND model_slug = ${input.modelSlug}`;
        return { updated: true };
      }),
    );

  return {
    ensureControlState,
    setKillSwitch,
    listCrewRoles,
    ensureDefaultCrewRoles,
    upsertCrewRole,
    deleteCrewRole,
    updateCrewTelemetry,
    createMissionRecord,
    getMission,
    getMissionFlags,
    updateMissionFenced,
    deleteMissionRecord,
    listMissions,
    appendActivity,
    listActivities,
    recordHandoffMessage,
    listHandoffs,
    createApprovalGate,
    getApprovalGateDetail,
    listApprovalGates,
    resolveApprovalGate,
    insertReport,
    listReports,
    recordBudgetUsage,
    getDailyBudgetSummary,
    listOrphanedActiveMissions,
    countCompletedToday,
    createMeetingRecord,
    getMeeting,
    listMeetings,
    updateMeetingRecord,
    deleteMeetingRecord,
    upsertMeetingPacket,
    listSynapseWeights,
    recordSynapseBackprop,
    recordSynapseEdge,
    setSynapsePruned,
  };
}

export type MissionControlStoreApi = ReturnType<typeof makeMissionControlStore>;
