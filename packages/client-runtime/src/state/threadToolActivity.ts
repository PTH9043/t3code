import {
  EventId,
  ModelSelection,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationLatestTurn,
  type OrchestrationCheckpointSummary,
  type ThreadId,
  type ToolActivitySummaryInput,
  type ToolActivitySummaryResult,
  type WorkspaceOrchestraBlock,
} from "@t3tools/contracts";
import {
  partitionToolActivityGroups,
  groupToolActivities,
  hasChildActivityScope,
  buildToolActivityFacts,
  redactCommandLineForDisplay,
  redactToolActivityText,
} from "@t3tools/shared/toolActivity";
import * as Schema from "effect/Schema";
import { isLegacyUpgradeRoomExecutionId, orchestraBlocksByMessage } from "./orchestra.ts";

type ProgressActivity = Pick<
  OrchestrationThreadActivity,
  "kind" | "summary" | "createdAt" | "payload"
> & {
  readonly turnId: string | null;
};

export function selectUpgradeRoomProgress(
  threadId: string,
  activeTurnId: string | null,
  startedAt: string,
  activities: readonly ProgressActivity[],
) {
  if (threadId !== "autousage-upgrade-room" || !activeTurnId) return null;
  let latest: ProgressActivity | undefined;
  let completedTools = 0;
  let steps: readonly PlanStep[] = [];
  let stepsAt = Number.NEGATIVE_INFINITY;
  for (const entry of activities) {
    if (entry.turnId !== activeTurnId) continue;
    const announced = planSteps(entry);
    if (announced && Date.parse(entry.createdAt) >= stepsAt) {
      steps = announced;
      stepsAt = Date.parse(entry.createdAt);
    }
    if (!lifecycle.has(entry.kind)) continue;
    if (entry.kind === "tool.completed") completedTools += 1;
    if (!latest || Date.parse(entry.createdAt) >= Date.parse(latest.createdAt)) latest = entry;
  }
  const done = steps.filter((step) => step.status === "completed").length;
  const current = steps.find((step) => step.status === "inProgress")?.step;
  const plan = steps.length
    ? `계획 ${done}/${steps.length} 완료${current ? ` · 지금: ${current.replace(/\s+/g, " ").slice(0, 140)}` : ""}`
    : null;
  const payload = latest?.payload as
    | { itemType?: unknown; detail?: unknown; agentId?: unknown }
    | null
    | undefined;
  const summary = latest?.summary.trim().replace(/\s+/g, " ").slice(0, 140);
  let label = summary || null;
  if (payload?.itemType === "collab_agent_tool_call" && summary) {
    label = `하위 AI · ${summary}`;
  } else if (
    payload?.itemType === "file_change" &&
    latest?.kind === "tool.completed" &&
    typeof payload.detail === "string" &&
    /^[MAD] /m.test(payload.detail)
  ) {
    const files = payload.detail.split(/\r?\n/).flatMap((line) => {
      const match = /^[MAD] (.+)$/.exec(line);
      return match ? [match[1]!.split(/[/\\]/).at(-1)!] : [];
    });
    label = `파일 수정 완료 · ${files[0]}${files.length > 1 ? ` 외 ${files.length - 1}개` : ""}`;
  } else if (latest) {
    // The timeline row's own wording: work, phase and the target path the server marked as
    // displayable. Patterns, queries, commands and output never reach this line. A tool the
    // row cannot classify adds its name, which is the summary of a start or end receipt.
    const [work] = groupToolActivities([
      { ...latest, id: EventId.make("upgrade-room-progress"), tone: "tool", turnId: null },
    ]);
    const tool =
      latest.kind === "tool.updated"
        ? null
        : /^([\w.:-]{1,80})(?: started)?$/.exec(summary ?? "")?.[1];
    if (work) label = work.action === "other" && tool ? `${work.summary} · ${tool}` : work.summary;
  }
  // A sub-agent's own tool call, reported from its child session.
  if (label && payload?.agentId && payload.itemType !== "collab_agent_tool_call")
    label = `하위 AI · ${label}`;
  return { label, plan, recordedAt: latest?.createdAt ?? null, startedAt, completedTools };
}

type PlanStep = { readonly step: string; readonly status: "pending" | "inProgress" | "completed" };
/** The steps this activity announces, or null when it is not a plan. */
function planSteps(entry: ProgressActivity): readonly PlanStep[] | null {
  const plan = entry.kind === "turn.plan.updated" ? object(entry.payload).plan : null;
  if (!Array.isArray(plan)) return null;
  return plan.flatMap((row: unknown) => {
    const { step, status } = object(row);
    return typeof step === "string" && step.trim()
      ? [
          {
            step: step.trim(),
            status:
              status === "completed"
                ? ("completed" as const)
                : status === "inProgress"
                  ? ("inProgress" as const)
                  : ("pending" as const),
          },
        ]
      : [];
  });
}

export type UpgradeRoomProgress = NonNullable<ReturnType<typeof selectUpgradeRoomProgress>>;

export function describeUpgradeRoomProgress(
  progress: UpgradeRoomProgress,
  now: number,
  waiting: string | null,
): string {
  if (waiting) return waiting;
  const minutes = Math.floor(
    (now - Date.parse(progress.recordedAt ?? progress.startedAt)) / 60_000,
  );
  if (minutes >= 2) return `${minutes}분간 새 작업 기록 없음`;
  return progress.recordedAt ? "마지막 작업 기록" : "아직 작업 기록 없음";
}

const isAssignedModel = Schema.is(ModelSelection);
const lifecycle = new Set(["tool.started", "tool.updated", "tool.progress", "tool.completed"]);
export type ThreadToolActivity = ReturnType<typeof groupToolActivities>[number];
export interface PresentedToolWork {
  id: string;
  createdAt: string;
  turnId: OrchestrationThreadActivity["turnId"];
  label: string;
  tone: "tool" | "info";
  orchestraMessageId?: string;
  toolActivity?: ThreadToolActivity;
  unlinkedToolSignals?: readonly ThreadToolActivity[];
}
export function separateThreadToolActivities(
  activities: readonly OrchestrationThreadActivity[],
  latest?: OrchestrationLatestTurn | null,
  checkpoints?: readonly OrchestrationCheckpointSummary[],
  activeTurnId?: OrchestrationThreadActivity["turnId"],
) {
  const settled = new Set(checkpoints?.filter((c) => c.status === "ready").map((c) => c.turnId));
  const otherActivities: OrchestrationThreadActivity[] = [];
  const blocks: ReadonlyMap<string, WorkspaceOrchestraBlock> = orchestraBlocksByMessage(activities);
  const byOwner = new Map<string | null, OrchestrationThreadActivity[]>();
  const assignments: OrchestrationThreadActivity[] = [];
  for (const event of activities) {
    const payload: Record<string, unknown> =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    const internal = !!(payload.agentId || payload.parentToolUseId || payload.timelineBypass);
    if (!lifecycle.has(event.kind)) {
      if (
        event.kind === "conversation.turn-assigned" &&
        event.turnId &&
        !internal &&
        !hasChildActivityScope(payload) &&
        isAssignedModel(event.payload)
      )
        assignments.push(event);
      otherActivities.push(event);
      continue;
    }
    if (
      internal ||
      (typeof payload.detail === "string" && payload.detail.startsWith("ExitPlanMode:"))
    )
      continue;
    if (
      event.turnId &&
      (payload.toolActivityTurnState === "completed" ||
        payload.toolActivityTurnState === "interrupted" ||
        payload.toolActivityTurnState === "error")
    )
      settled.add(event.turnId);
    const legacyExecution = payload.executionId;
    if (
      isLegacyUpgradeRoomExecutionId(legacyExecution) &&
      event.id.startsWith(`orchestra:${legacyExecution}:1:`)
    ) {
      // Old room jobs retain their persisted receipts and control routing. De-scope only tool presentation.
      const {
        executionId: _execution,
        messageId: _message,
        attempt: _attempt,
        ...ordinaryPayload
      } = payload;
      const ordinary = {
        ...event,
        turnId: TurnId.make(`upgrade-room:${legacyExecution}`),
        payload: ordinaryPayload,
      };
      const rows = byOwner.get(null);
      if (rows) rows.push(ordinary);
      else byOwner.set(null, [ordinary]);
      continue;
    }
    const messageId =
      payload.executionId && typeof payload.messageId === "string" ? payload.messageId : null;
    const block = messageId ? blocks.get(messageId) : undefined;
    // Keep a conflicting receipt visible without attaching it to an unrelated task or retry.
    const owner =
      block &&
      (block.executionId !== payload.executionId ||
        (payload.attempt !== undefined && payload.attempt !== block.attempt) ||
        (payload.providerInstanceId !== undefined &&
          payload.providerInstanceId !== block.modelSelection.instanceId))
        ? null
        : messageId;
    const rows = byOwner.get(owner);
    if (rows) rows.push(event);
    else byOwner.set(owner, [event]);
  }
  if (
    latest &&
    (latest.state === "completed" || latest.state === "interrupted" || latest.state === "error")
  )
    settled.add(latest.turnId);
  if (latest?.state === "running") settled.delete(latest.turnId);
  if (activeTurnId) settled.delete(activeTurnId);
  const tools: PresentedToolWork[] = [];
  for (const [owner, events] of byOwner) {
    const block = owner ? blocks.get(owner) : undefined;
    const groups = groupToolActivities(
      !owner && assignments.length ? [...events, ...assignments] : events,
      block ? { assignedExecution: block } : {},
    );
    const { visible, technicalByTurn } = partitionToolActivityGroups(groups, settled);
    const scope = owner ? { orchestraMessageId: owner } : {};
    for (const group of visible)
      tools.push({
        id: group.id,
        turnId: group.turnId,
        createdAt: group.createdAt,
        tone: "tool",
        label: group.summary,
        toolActivity: group,
        ...scope,
      });
    for (const groups of technicalByTurn.values()) {
      const first = groups[0];
      if (!first) continue;
      tools.push({
        id: "unlinked-tool-signals:" + JSON.stringify([first.turnId, owner]),
        turnId: first.turnId,
        createdAt: first.createdAt,
        tone: "info",
        label: "연결되지 않은 중간 기술 기록",
        unlinkedToolSignals: groups,
        ...scope,
      });
    }
  }
  return { otherActivities, tools };
}

export const toolPhaseLabel = {
  started: "시작",
  running: "진행 중",
  completed: "완료",
  failed: "실패",
  stopped: "중단",
  declined: "거절",
} as const;
export const toolEvidenceLabel = {
  planned: "요청 내용",
  observed: "실행 기록",
  "tool-reported": "도구가 보고한 결과",
  "confirmed-diff": "변경 차이로 확인",
} as const;
export const toolEventLabel: Readonly<Record<string, string>> = {
  "tool.started": "시작",
  "tool.updated": "상태 갱신",
  "tool.progress": "진행 보고",
  "tool.completed": "종료",
};

export function makeThreadActivitySummaryReader(
  threadId: ThreadId,
  run: (input: ToolActivitySummaryInput) => Promise<ToolActivitySummaryResult | null>,
) {
  const cache = new Map<
    string,
    { signature: string; response: Promise<ToolActivitySummaryResult | null> }
  >();
  return (group: ThreadToolActivity) => {
    const [fact] = buildToolActivityFacts([group]);
    const activityId = group.eventIds[0];
    if (!activityId || !fact) return Promise.resolve(null);
    const signature = JSON.stringify(fact);
    const seen = cache.get(activityId);
    if (seen?.signature === signature) return seen.response;
    const response = run({ threadId, activityId, fact })
      .catch(() => null)
      .then((result) => {
        if (!result?.summary && cache.get(activityId)?.response === response)
          cache.delete(activityId);
        return result;
      });
    cache.set(activityId, { signature, response });
    return response;
  };
}

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function maskedCommand(value: unknown) {
  return redactCommandLineForDisplay(value, 240);
}
export function maskedActivityRecord(
  event: OrchestrationThreadActivity,
  group: ThreadToolActivity,
) {
  const p = object(event.payload),
    data = object(p.data),
    item = object(data.item),
    rawInput = object(data.rawInput),
    rawOutput = object(data.rawOutput);
  const command = maskedCommand(
    p.command ??
      data.command ??
      object(data.input).command ??
      rawInput.CommandLine ??
      rawInput.command ??
      item.command ??
      object(item.input).command ??
      object(item.result).command ??
      (p.itemType === "command_execution" && typeof p.detail === "string"
        ? /^(?:Bash|Shell|Terminal):\s*([^\r\n]+)/iu.exec(p.detail)?.[1]
        : undefined),
  );
  const tool = data.toolName ?? p.toolName ?? p.itemType;
  const name =
    typeof tool === "string" &&
    [
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Grep",
      "Glob",
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "dynamic_tool_call",
      "web_search",
      "image_view",
    ].includes(tool)
      ? tool
      : null;
  const intent =
    typeof data.intent === "string" && data.intent.trim()
      ? redactToolActivityText(data.intent.trim(), 120)
      : group.preview?.intent;
  const argumentsRecord = object(item.arguments ?? data.input);
  const argPairs = ["command", "query", "path", "file_path", "pattern", "url"]
    .filter((k) => Object.hasOwn(argumentsRecord, k))
    .map((k) => {
      const rawVal = argumentsRecord[k];
      if (k === "command" && command) return null;
      const rendered =
        typeof rawVal === "string" && rawVal.trim().length > 0
          ? redactToolActivityText(rawVal.replace(/\s+/gu, " ").trim(), 100)
          : "•••";
      return `${k}=${rendered}`;
    })
    .filter((entry): entry is string => entry !== null);
  const outputPreview =
    typeof rawOutput.content === "string" && rawOutput.content.trim()
      ? redactToolActivityText(rawOutput.content.trim(), 220)
      : group.preview?.outputSnippet;
  return [
    name && `도구 ${name}`,
    intent && `의도 ${intent}`,
    command && `명령 ${command}`,
    argPairs.length > 0 && `입력 ${argPairs.join(" ")}`,
    outputPreview && `출력 ${outputPreview}`,
  ]
    .filter(Boolean)
    .join("\n");
}
