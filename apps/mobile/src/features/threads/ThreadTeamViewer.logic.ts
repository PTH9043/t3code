import {
  resolveSubordinateTeam,
  ProviderInstanceId,
  TrimmedNonEmptyString,
  TokenUsageObservation,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ServerConfig,
  type ThreadId,
  type ThreadModelTeam,
  type ThreadSubordinateTeamUpdate,
  type ThreadTeamMember,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  handoffDeliveryText,
  handoffReportText,
  latestHandoffActivity,
} from "@t3tools/client-runtime/state/conversation-handoff";
import {
  derivePendingApprovals,
  sortThreadActivities,
  viewerWorkEntries,
} from "../../lib/threadActivity";
import {
  orchestraBlocksByMessage,
  orchestraStatusLabels,
} from "@t3tools/client-runtime/state/presentation";
import {
  foldSubagentActivities,
  isActiveSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";

export type TeamScope = Pick<ThreadModelTeam, "threadId" | "answeringInstanceId" | "forModel">;
type AccountMember = ThreadTeamMember & {
  answeringInstanceId: ModelSelection["instanceId"];
  forModel?: string;
};
type TeamSettings = {
  globalSubordinateTeam?: readonly ThreadTeamMember[];
  threadSubordinateTeams?: Readonly<Record<string, readonly ThreadTeamMember[] | null>>;
  threadModelTeams?: readonly ThreadModelTeam[];
  subordinateModels?: readonly AccountMember[];
};

/** The conversation's custom team, or null while it follows the global team. */
export function readRoomTeam(settings: TeamSettings | null, threadId: ThreadId) {
  const team = settings ? resolveSubordinateTeam(settings, threadId) : null;
  return team?.source === "room" ? team.members : null;
}

/** True when the server's settings hold exactly this update, including a return to the global team. */
export function confirmsRoomTeam(
  settings: TeamSettings | null,
  update: ThreadSubordinateTeamUpdate,
) {
  const teams = settings?.threadSubordinateTeams;
  if (!teams || !Object.hasOwn(teams, update.threadId)) return false;
  return sameTeam(teams[update.threadId] ?? null, update.members);
}

export function accountTeam(
  settings: TeamSettings | null,
  scope: Omit<TeamScope, "threadId">,
  providers: ServerConfig["providers"],
) {
  const seen = new Set<string>();
  return (settings?.subordinateModels ?? []).flatMap((row): ThreadTeamMember[] => {
    if (
      row.answeringInstanceId !== scope.answeringInstanceId ||
      (row.forModel !== undefined &&
        row.forModel.trim().toLowerCase() !== scope.forModel.trim().toLowerCase()) ||
      !providers.some((provider) => provider.instanceId === row.instanceId && provider.enabled)
    )
      return [];
    const key = JSON.stringify([row.instanceId, row.model.toLowerCase(), row.role]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        instanceId: row.instanceId,
        model: row.model,
        role: row.role,
        ...(row.instructions ? { instructions: row.instructions } : {}),
      },
    ];
  });
}

export function sameTeam(
  a: readonly ThreadTeamMember[] | null,
  b: readonly ThreadTeamMember[] | null,
) {
  if (a === null || b === null) return a === b;
  return (
    a.length === b.length &&
    a.every((row, i) => {
      const other = b[i];
      return (
        row.instanceId === other?.instanceId &&
        row.model === other.model &&
        row.role === other.role &&
        row.instructions === other.instructions
      );
    })
  );
}

export { threadTeamRoleLabels as teamRoleLabels } from "@t3tools/contracts";

const hasConsumption = Schema.is(
  Schema.Struct({ consumption: Schema.Array(TokenUsageObservation) }),
);
const isTurnAssignment = Schema.is(
  Schema.Struct({ instanceId: ProviderInstanceId, model: TrimmedNonEmptyString }),
);

export function turnEvidence(thread: OrchestrationThreadShell, detail: OrchestrationThread | null) {
  const current = thread.latestTurn;
  if (!detail || detail.id !== thread.id) return null;
  const turnId =
    (thread.session?.status === "running" ? thread.session.activeTurnId : null) ?? current?.turnId;
  const handoff = latestHandoffActivity(detail.activities);
  const models = new Set<string>();
  let assigned: Pick<ModelSelection, "instanceId" | "model"> | null = null;
  for (const activity of detail.activities) {
    if (!turnId || activity.turnId !== turnId) continue;
    const payload = activity.payload;
    if (
      typeof payload !== "object" ||
      !payload ||
      "executionId" in payload ||
      "agentId" in payload ||
      "parentToolUseId" in payload
    )
      continue;
    if (activity.kind === "conversation.turn-assigned" && isTurnAssignment(payload)) {
      assigned = { instanceId: payload.instanceId, model: payload.model };
    }
    if (activity.kind === "context-window.updated" && hasConsumption(payload)) {
      for (const usage of payload.consumption) {
        // Claude's per-model ledger includes native children. Its fallback can carry the requested model.
        if (
          usage.model &&
          (usage.provider === "opencode" ||
            usage.provider === "grok" ||
            (usage.provider === "claude" && usage.includesNativeChildren))
        ) {
          models.add(
            usage.provider +
              " · " +
              usage.model +
              (usage.includesNativeChildren ? " (하위 AI 포함)" : ""),
          );
        }
      }
    }
  }
  const blocks = orchestraBlocksByMessage(detail.activities);
  const result =
    turnId &&
    detail.messages.findLast(
      (message) =>
        !blocks.has(message.id) &&
        message.role === "assistant" &&
        (message.turnId === turnId ||
          (current?.turnId === turnId && message.id === current.assistantMessageId)),
    );
  return {
    turnId,
    assigned,
    models: [...models],
    actions: turnId
      ? viewerWorkEntries(
          detail.activities,
          turnId,
          detail.latestTurn,
          detail.checkpoints,
          thread.session?.status === "running" ? thread.session.activeTurnId : null,
        )
      : [],
    approvals: derivePendingApprovals(sortThreadActivities(detail.activities)),
    files: [
      ...new Set(
        detail.checkpoints
          .filter((checkpoint) => checkpoint.turnId === turnId)
          .flatMap((checkpoint) => checkpoint.files.map((file) => file.path)),
      ),
    ],
    result,
    handoff: handoff
      ? {
          at: handoff.createdAt,
          text: handoff.delivery
            ? `${handoff.summary} · ${handoffDeliveryText(handoff.delivery)}`
            : handoff.prepared
              ? handoffReportText(handoff.prepared)
              : handoff.summary,
        }
      : null,
  };
}

const agentStatusLabels = {
  pending: "시작 대기",
  running: "실행 중",
  waiting: "답변 대기",
  idle: "대기",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
  interrupted: "중단",
} as const;

export function recordedAgents(
  thread: Pick<OrchestrationThreadShell, "id" | "session">,
  activities: readonly OrchestrationThreadActivity[],
) {
  const session = thread.session;
  const sessionLive =
    session != null &&
    session.status !== "stopped" &&
    session.status !== "interrupted" &&
    session.status !== "error";
  const native = foldSubagentActivities(activities, { sessionLive }).map((agent) => ({
    key: "native:" + agent.id,
    title: agent.title,
    detail: [agent.role, agent.model, agent.effort, agent.progress ?? agent.lastToolName]
      .filter(Boolean)
      .join(" · "),
    status: agentStatusLabels[agent.status],
    active: isActiveSubagentStatus(agent.status),
  }));
  const blocks = [...orchestraBlocksByMessage(activities).values()]
    .filter((block) => block.ownerThreadId === thread.id)
    .map((block) => ({
      key: "execution:" + block.executionId,
      title: block.displayName,
      detail: [
        block.modelSelection.instanceId,
        block.modelSelection.model,
        block.instruction ?? block.title,
      ].join(" · "),
      status: orchestraStatusLabels[block.status],
      active: block.status === "running" || block.status === "awaiting-user",
    }));
  return [...native, ...blocks];
}
