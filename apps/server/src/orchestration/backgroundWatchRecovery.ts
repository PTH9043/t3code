import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ServerSettings, ThreadId } from "@t3tools/contracts";

export const RECOVERY_TURN_TEXT_PREFIX = "[자동 복구]";
export const RECOVERY_TURN_TEXT = [
  `${RECOVERY_TURN_TEXT_PREFIX} 서버가 재시작되면서 직전 턴이 중단되었습니다.`,
  "중단 전까지의 대화와 작업 상태를 직접 확인한 뒤, 끝나지 않은 작업이 있으면 이어서 완료해 주세요.",
  "이미 완료된 작업은 반복하지 말고, 확인 결과와 이어서 한 작업을 정리해 보고해 주세요.",
].join(" ");
export const RECOVERY_BACKGROUND_TEXT = [
  `${RECOVERY_TURN_TEXT_PREFIX} 서버 재시작으로 이전 대화에서 실행하던 백그라운드 감시가 중단되었습니다.`,
  "기존 대화와 현재 대상의 실제 상태, 사용자가 정한 중지 조건과 기한을 먼저 확인하세요.",
  "계속 승인되어 있고 아직 필요한 감시는 중복 실행 없이 복구하고, 확인되지 않은 외부 작업은 반복하지 마세요.",
  "이미 완료되었거나 중지된 감시는 다시 시작하지 말고 실제 확인·복구 결과를 보고하세요.",
].join(" ");
export const RECOVERY_MCP_CHECK_TEXT = [
  `${RECOVERY_TURN_TEXT_PREFIX} 서버 재시작 전 MCP 감시 기록이 있습니다.`,
  "감시가 재시작 시점까지 살아 있었는지는 기록만으로 확정할 수 없습니다.",
  "기존 지시와 대상 상태를 확인하고, 확인할 수 없는 작업은 반복하지 마세요.",
].join(" ");

export const ABANDONED_QUESTION_TEXT =
  "중단 직전에 사용자에게 던진 질문은 답을 받지 못한 채 사라졌습니다. 아직 답이 필요하면 같은 질문을 다시 해 주세요.";

export function allowsBackgroundWatch(
  settings: Pick<ServerSettings, "backgroundWatchThreadIds" | "backgroundWatchRevokedAtMs">,
  threadId: ThreadId,
  createdAt: string,
): boolean {
  if (!settings.backgroundWatchThreadIds.includes(threadId)) return false;
  const revoked = settings.backgroundWatchRevokedAtMs?.[threadId];
  return revoked === undefined || Date.parse(createdAt) > revoked;
}

/** Only classify text already authenticated by the server's recovery delivery journal. */
export function recoveryMessageParts(text: string) {
  if (text.startsWith(RECOVERY_BACKGROUND_TEXT) || text.startsWith(RECOVERY_MCP_CHECK_TEXT))
    return { foreground: null, watch: text };
  if (text.startsWith(RECOVERY_TURN_TEXT)) {
    const foreground = text.startsWith(RECOVERY_TURN_TEXT + " " + ABANDONED_QUESTION_TEXT)
      ? RECOVERY_TURN_TEXT + " " + ABANDONED_QUESTION_TEXT
      : RECOVERY_TURN_TEXT;
    return { foreground, watch: text.slice(foreground.length).trim() };
  }
  return { foreground: text, watch: "" };
}

type WatchActivity = {
  readonly activityId: string;
  readonly createdAt: string;
  readonly kind: string;
  readonly payload: unknown;
};

// The installed Claude Monitor limits non-persistent watches to one hour.
export const MCP_MONITOR_MAX_MS = 3_600_000;
export const MCP_RECOVERY_SUMMARIES = [
  "t3-claude-tools · Monitor",
  "t3-claude-tools · TaskStop",
  "t3-claude-tools · ScheduleWakeup",
];
const decodeMcpItem = Schema.decodeUnknownOption(
  Schema.Struct({
    itemType: Schema.Literal("mcp_tool_call"),
    data: Schema.Struct({
      item: Schema.Struct({
        type: Schema.Literal("mcpToolCall"),
        server: Schema.Literal("t3-claude-tools"),
        tool: Schema.String,
        status: Schema.String,
        error: Schema.optionalKey(Schema.Null),
        durationMs: Schema.optionalKey(Schema.Number),
        arguments: Schema.optionalKey(Schema.Unknown),
        result: Schema.optionalKey(Schema.Unknown),
      }),
    }),
  }),
);
const decodeMcpResult = Schema.decodeUnknownOption(
  Schema.Struct({
    isError: Schema.optionalKey(Schema.Boolean),
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  }),
);
const decodeMonitorOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      taskId: Schema.String,
      timeoutMs: Schema.Number,
      persistent: Schema.Literal(false),
      status: Schema.optionalKey(Schema.String),
      error: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const decodeStopOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.optionalKey(Schema.Unknown),
      success: Schema.optionalKey(Schema.Boolean),
      status: Schema.optionalKey(Schema.String),
    }),
  ),
);
const decodeStopArguments = Schema.decodeUnknownOption(
  Schema.Struct({
    task_id: Schema.optionalKey(Schema.String),
    taskId: Schema.optionalKey(Schema.String),
  }),
);

/** Background work the dead session was running, read back from the activity log. */
export interface OrphanedBackgroundWork {
  readonly tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly title: string | null;
    readonly startedAt: string;
  }>;
  readonly otherTasks: OrphanedBackgroundWork["tasks"];
  readonly mcpMonitors: ReadonlyArray<{
    readonly taskId: string;
    readonly startedAt: string;
    readonly expiresAt: string;
  }>;
  /** ISO time the seat had scheduled itself to wake, if that was still ahead. */
  readonly wakeupScheduledFor: string | null;
}

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

export function payloadOf(activity: WatchActivity): Record<string, unknown> | null {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : null;
}

/**
 * Monitor loops / background shells still open at the end of the log, and a
 * self-wakeup scheduled for after `nowMs`. Ordered by the same rule as the
 * question scan so both read the log the same way.
 */
export function orphanedBackgroundWork(
  activities: ReadonlyArray<WatchActivity>,
  nowMs: number,
  revokedAtMs?: number,
): OrphanedBackgroundWork {
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );
  const open = new Map<
    string,
    { readonly taskId: string; readonly title: string | null; readonly startedAt: string }
  >();
  const other = new Map<string, OrphanedBackgroundWork["tasks"][number]>();
  const monitors = new Map<string, { taskId: string; startedAt: string; expiresAt: string }>();
  let wakeupScheduledFor: string | null = null;
  for (const activity of ordered) {
    const payload = payloadOf(activity);
    if (payload === null) continue;
    if (activity.kind === "session.recovered") {
      // Everything before an earlier recovery marker was already settled.
      open.clear();
      other.clear();
      monitors.clear();
      wakeupScheduledFor = null;
      continue;
    }
    const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
    if (taskId !== null) {
      if (activity.kind === "task.started" && payload.agentKind === "background") {
        const isWatch = payload.taskType === "monitor" || payload.taskType === "monitor_mcp";
        if (isWatch && revokedAtMs !== undefined && Date.parse(activity.createdAt) <= revokedAtMs)
          continue;
        const tasks = isWatch ? open : other;
        tasks.set(taskId, {
          taskId,
          title: typeof payload.title === "string" ? payload.title : null,
          startedAt: tasks.get(taskId)?.startedAt ?? activity.createdAt,
        });
      } else if (
        (activity.kind === "task.completed" &&
          typeof payload.status === "string" &&
          TERMINAL_TASK_STATUSES.has(payload.status)) ||
        (activity.kind === "task.updated" &&
          (typeof payload.endedAt === "string" ||
            (typeof payload.status === "string" && TERMINAL_TASK_STATUSES.has(payload.status))))
      ) {
        open.delete(taskId);
        other.delete(taskId);
        monitors.delete(taskId);
      }
      continue;
    }
    if (activity.kind === "tool.completed") {
      let wakeInput: unknown;
      const mcp = decodeMcpItem(payload);
      if (Option.isSome(mcp)) {
        const item = mcp.value.data.item;
        if (item.tool === "TaskStop" && item.status === "completed" && item.error == null) {
          const args = decodeStopArguments(item.arguments);
          const stopResult = decodeMcpResult(item.result);
          const failureText =
            Option.isSome(stopResult) &&
            stopResult.value.content.some((entry) => {
              const parsed = decodeStopOutput(entry.text);
              return (
                /^\s*(?:error\b|failed\b|오류|실패)/i.test(entry.text) ||
                (Option.isSome(parsed) &&
                  (parsed.value.error != null ||
                    parsed.value.success === false ||
                    (typeof parsed.value.status === "string" &&
                      ["failed", "error"].includes(parsed.value.status))))
              );
            });
          if (
            Option.isSome(args) &&
            Option.isSome(stopResult) &&
            stopResult.value.content.length > 0 &&
            stopResult.value.isError !== true &&
            !failureText
          ) {
            const stopped = args.value.task_id ?? args.value.taskId;
            if (stopped) {
              monitors.delete(stopped);
              open.delete(stopped);
            }
          }
        } else if (
          item.tool === "Monitor" &&
          item.status === "completed" &&
          item.error == null &&
          typeof item.durationMs === "number" &&
          Number.isSafeInteger(item.durationMs) &&
          item.durationMs >= 0
        ) {
          const result = decodeMcpResult(item.result);
          if (Option.isSome(result) && result.value.isError !== true) {
            const outputs = result.value.content
              .map((entry) => decodeMonitorOutput(entry.text))
              .filter(Option.isSome);
            if (outputs.length === 1) {
              const value = outputs[0]!.value;
              const started = Date.parse(activity.createdAt) - item.durationMs;
              const expires = started + value.timeoutMs;
              if (
                (revokedAtMs === undefined || started > revokedAtMs) &&
                /^[A-Za-z0-9_-]+$/.test(value.taskId) &&
                value.error == null &&
                (value.status === undefined || value.status === "running") &&
                Number.isSafeInteger(value.timeoutMs) &&
                value.timeoutMs > 0 &&
                value.timeoutMs <= MCP_MONITOR_MAX_MS &&
                Number.isFinite(started) &&
                started <= nowMs &&
                expires > nowMs
              ) {
                monitors.set(value.taskId, {
                  taskId: value.taskId,
                  startedAt: DateTime.formatIso(DateTime.makeUnsafe(started)),
                  expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires)),
                });
              }
            }
          }
        }
        if (item.tool !== "ScheduleWakeup" || item.status !== "completed" || item.error != null)
          continue;
        const result = decodeMcpResult(item.result);
        if (
          Option.isNone(result) ||
          result.value.isError === true ||
          result.value.content.length === 0
        )
          continue;
        wakeInput = item.arguments;
      } else {
        const data = payloadOf({ ...activity, payload: payload.data });
        if (data?.toolName !== "ScheduleWakeup" || payload.status === "failed") continue;
        const result = payloadOf({ ...activity, payload: data.result });
        if (result?.is_error === true || result?.isError === true) continue;
        wakeInput = data.input;
      }
      const input = payloadOf({ ...activity, payload: wakeInput });
      if (input?.stop === true) {
        wakeupScheduledFor = null;
        continue;
      }
      const delaySeconds = typeof input?.delaySeconds === "number" ? input.delaySeconds : null;
      if (
        delaySeconds === null ||
        !Number.isFinite(delaySeconds) ||
        (revokedAtMs !== undefined && Date.parse(activity.createdAt) <= revokedAtMs)
      )
        continue;
      const at =
        Date.parse(activity.createdAt) + Math.min(3_600, Math.max(60, delaySeconds)) * 1_000;
      wakeupScheduledFor = at > nowMs ? DateTime.formatIso(DateTime.makeUnsafe(at)) : null;
    }
  }
  return {
    tasks: [...open.values()],
    otherTasks: [...other.values()].filter((entry) => !monitors.has(entry.taskId)),
    mcpMonitors: [...monitors.values()].filter((entry) => !open.has(entry.taskId)),
    wakeupScheduledFor,
  };
}

export function orphanedWorkText(work: OrphanedBackgroundWork): string {
  const parts: string[] = [];
  if (work.tasks.length > 0) {
    const names = work.tasks
      .map((task) => `${task.title ?? "제목 없음"} (${task.taskId}, 기록된 시작 ${task.startedAt})`)
      .join(", ");
    parts.push(
      `백그라운드 감시 ${work.tasks.length}개(${names || "제목 없음"})는 서버와 함께 종료되었습니다. 기존 지시와 대상 상태를 확인하고 아직 필요한 감시는 직접 복구하세요.`,
    );
  }
  if (work.wakeupScheduledFor !== null) {
    parts.push(
      `예약해 둔 자동 깨어남(ScheduleWakeup)도 사라졌습니다. 원래 예정 시각은 ${work.wakeupScheduledFor}입니다. 기존 조건과 기한이 유효하다면 직접 복구하세요.`,
    );
  }
  if (work.mcpMonitors.length > 0) {
    const entries = work.mcpMonitors
      .map((item) => `${item.taskId} (기한 ${item.expiresAt})`)
      .join(", ");
    parts.push(
      `이전 MCP Monitor ${entries}의 종료 여부는 기록만으로 확정할 수 없습니다. 기존 지시, 기한과 대상의 현재 상태 및 종료·실패 여부를 확인하세요. 확인되지 않거나 종료·실패·기한 만료된 감시는 다시 시작하지 마세요.`,
    );
  }
  return parts.join(" ");
}
