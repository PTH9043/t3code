// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  type EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  RuntimeTaskId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { redactToolActivityText } from "@t3tools/shared/toolActivity";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

const PROVIDER = ProviderDriverKind.make("gemini");

const BACKGROUND_TASK_ID_PATTERN =
  /(?:Tool is running as a background task with task id:\s*|running in the background[^:\r\n]*task id\s*[:=]\s*|background task id\s*[:=]\s*)([A-Za-z0-9/_:-]{4,160})/iu;
const TASK_LOG_URL_PATTERN = /Task logs are available at:\s*file:\/\/\/([^\r\n]+)/iu;
const SCHEDULE_TASK_ID_PATTERN = /(?:task id|schedule id|job id)[:\s]+([A-Za-z0-9/_:-]{4,160})/iu;
const SUBAGENT_CONVERSATION_ID_PATTERN =
  /conversationId["'\s:=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu;
const EXIT_CODE_PATTERN = /Command exited with code (-?\d{1,9})\.?/iu;
const TERMINAL_COMPLETED_PATTERN =
  /\b(?:status\s*[:=]\s*(?:DONE|COMPLETED)|task\s+id\s+["']?[^"'\r\n]+["']?\s+(?:finished|completed)|workflow\s+["']?[^"'\r\n]+["']?\s+completed)\b/iu;
const TERMINAL_FAILED_PATTERN =
  /\b(?:status\s*[:=]\s*(?:FAILED|ERROR)|task\s+id\s+["']?[^"'\r\n]+["']?\s+failed|workflow\s+["']?[^"'\r\n]+["']?\s+failed)\b/iu;
const TERMINAL_STOPPED_PATTERN =
  /\b(?:status\s*[:=]\s*(?:CANCELLED|CANCELED|KILLED|STOPPED)|task\s+id\s+["']?[^"'\r\n]+["']?\s+(?:killed|cancelled|canceled|stopped))\b/iu;
const NO_RUNNING_TASKS_PATTERN = /\b(?:no running tasks|0 running tasks|running tasks:\s*0)\b/iu;
const SAFE_TASK_PATH_SEGMENT = /^[A-Za-z0-9_-]{3,128}$/u;

const MAX_CONCURRENT_TASKS = 12;
const MAX_TASK_AGE_MS = 30 * 60 * 1_000;
const BLIND_STATUS_IDLE_TTL_MS = 90_000;
/**
 * Antigravity `.system_generated/tasks/*.log` files capture raw stdout/stderr and
 * usually omit `Command exited with code N`. If a task log file has not been modified
 * for this long (both on discovery and during polling), treat the task as finished so
 * historical or completed jobs never linger as perpetual "60s+ stalled" zombies.
 */
const LOG_STALE_COMPLETE_MS = 90_000;
const SCHEDULE_EXPIRY_GRACE_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_TAIL_BYTES = 2_048;

interface EventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

interface TrackedBackgroundTask {
  readonly taskId: string;
  readonly taskType: "local_bash" | "local_agent" | "monitor";
  readonly agentKind: "background" | "agent";
  readonly title: string;
  readonly role?: string;
  readonly model?: string;
  outputFile?: string;
  readonly turnId: TurnId | undefined;
  readonly startedAtMs: number;
  lastActivityAtMs: number;
  lastFileMtimeMs?: number;
  readonly expiresAtMs?: number;
  /** True when discovered solely from a `rawOutput: null` `manage_task(status)` call without a log file. */
  inferredFromBlindStatus: boolean;
  /** True for foreground long-running tools (e.g. run_workflow) that settle with the turn. */
  readonly turnBound: boolean;
  lastSize: number;
  lastLine: string;
  completed: boolean;
}

export interface GeminiBackgroundTaskTrackerOptions<E = never> {
  readonly threadId: ThreadId;
  readonly makeEventStamp: () => Effect.Effect<EventStamp, E>;
  readonly emitEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, never>;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly profileDirectories?: ReadonlyArray<string>;
  readonly resolveTaskLogPath?: (taskId: string) => string | undefined;
  readonly readLogTail?: (
    filePath: string,
    lastSize: number,
  ) => {
    readonly size: number;
    readonly text: string;
    readonly mtimeMs?: number;
  } | null;
  readonly readLogStat?: (filePath: string) => {
    readonly size: number;
    readonly mtimeMs: number;
  } | null;
}

export interface GeminiBackgroundTaskTracker {
  readonly observeToolCall: (
    toolCall: AcpToolCallState,
    turnId: TurnId | undefined,
    model?: string,
  ) => Effect.Effect<void, never>;
  readonly onTurnEnded: (
    turnId: TurnId | undefined,
    outcome?: "completed" | "failed" | "stopped",
  ) => Effect.Effect<void, never>;
  readonly pollOnce: () => Effect.Effect<void, never>;
  readonly dispose: () => void;
  readonly activeCount: () => number;
  readonly nonDaemonActiveCount: () => number;
  readonly cancelAll: (outcome?: "stopped" | "failed") => Effect.Effect<void, never>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Decodes a `file:///...` log URI from Antigravity and enforces a strict
 * directory allowlist (`/.system_generated/tasks/`) so the tail reader can
 * never read arbitrary files outside Antigravity's task log folder.
 */
export function normalizeWhitelistedAntigravityLogPath(rawUriPath: string): string | undefined {
  let decoded = rawUriPath.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep raw path if URI decoding fails.
  }
  const normalizedSlashes = decoded.replaceAll("\\", "/");
  if (!normalizedSlashes.toLowerCase().includes("/.system_generated/tasks/")) {
    return undefined;
  }
  if (normalizedSlashes.includes("..")) {
    return undefined;
  }
  // Convert `/C:/Users/...` to `C:/Users/...` on Windows while preserving POSIX roots.
  const withoutLeadingSlash = /^\/[A-Za-z]:\//.test(normalizedSlashes)
    ? normalizedSlashes.slice(1)
    : normalizedSlashes;
  return /^[A-Za-z]:\//.test(withoutLeadingSlash)
    ? withoutLeadingSlash.replaceAll("/", "\\")
    : withoutLeadingSlash;
}

/**
 * Resolves `<convId>/<taskName>` Antigravity task IDs to their real `.log` file
 * inside `<profileDir>/brain/<convId>/.system_generated/tasks/<taskName>.log`.
 * Strictly validates both segments to prevent path traversal.
 */
export function resolveAntigravityTaskLogPath(
  taskId: string,
  profileDirectories?: ReadonlyArray<string>,
): string | undefined {
  const parts = taskId.trim().split("/");
  if (parts.length !== 2) return undefined;
  const [convId, taskName] = parts;
  if (!convId || !taskName) return undefined;
  if (!SAFE_TASK_PATH_SEGMENT.test(convId) || !SAFE_TASK_PATH_SEGMENT.test(taskName)) {
    return undefined;
  }
  const candidates = [
    ...(profileDirectories ?? []),
    NodePath.join(NodeOS.homedir(), ".gemini", "antigravity-cli"),
    NodePath.join(NodeOS.homedir(), ".gemini", "antigravity"),
  ];
  const seen = new Set<string>();
  for (const dir of candidates) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const resolvedDir = NodePath.resolve(trimmed);
    const key = resolvedDir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = NodePath.join(
      resolvedDir,
      "brain",
      convId,
      ".system_generated",
      "tasks",
      `${taskName}.log`,
    );
    try {
      if (NodeFS.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore missing file
    }
  }
  return undefined;
}

function classifyTerminalOutputText(text: string): "completed" | "failed" | "stopped" | null {
  if (!text) return null;
  const exitMatch = EXIT_CODE_PATTERN.exec(text);
  if (exitMatch?.[1] !== undefined) {
    return Number(exitMatch[1]) === 0 ? "completed" : "failed";
  }
  if (TERMINAL_STOPPED_PATTERN.test(text)) return "stopped";
  if (TERMINAL_FAILED_PATTERN.test(text)) return "failed";
  if (TERMINAL_COMPLETED_PATTERN.test(text)) return "completed";
  return null;
}

function defaultReadLogStat(
  filePath: string,
): { readonly size: number; readonly mtimeMs: number } | null {
  try {
    const stat = NodeFS.statSync(filePath);
    if (!stat.isFile()) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function defaultReadLogTail(
  filePath: string,
  lastSize: number,
): { readonly size: number; readonly text: string; readonly mtimeMs: number } | null {
  try {
    const stat = NodeFS.statSync(filePath);
    if (!stat.isFile() || stat.size <= lastSize) {
      return null;
    }
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const length = Math.min(stat.size - start, MAX_TAIL_BYTES);
    if (length <= 0) return null;
    const fd = NodeFS.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const bytesRead = NodeFS.readSync(fd, buffer, 0, length, start);
      return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        text: buffer.subarray(0, bytesRead).toString("utf8"),
      };
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function extractLatestMeaningfulLogLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/u);
  for (let i = lines.length - 1; i >= 0; i--) {
    const cleaned = lines[i]!.replace(/\s+/gu, " ").trim();
    if (
      !cleaned ||
      cleaned === "```" ||
      /^Created At:/iu.test(cleaned) ||
      /^Completed At:/iu.test(cleaned)
    ) {
      continue;
    }
    return redactToolActivityText(cleaned, 180);
  }
  return undefined;
}

function extractContentBlocksText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (typeof rec.text === "string" && rec.text.trim()) {
      chunks.push(rec.text);
      continue;
    }
    const nested = asRecord(rec.content);
    if (nested && typeof nested.text === "string" && nested.text.trim()) {
      chunks.push(nested.text);
    }
  }
  return chunks.join("\n");
}

function extractRawOutputText(toolCall: AcpToolCallState): string {
  const data = asRecord(toolCall.data);
  const parts: string[] = [];
  const rawOutput = asRecord(data?.rawOutput);
  if (rawOutput) {
    for (const key of ["output", "content", "stdout", "text", "result", "message"] as const) {
      if (typeof rawOutput[key] === "string" && rawOutput[key].trim().length > 0) {
        parts.push(rawOutput[key]);
      }
    }
  } else if (typeof data?.rawOutput === "string" && data.rawOutput.trim().length > 0) {
    parts.push(data.rawOutput);
  }
  const contentText = extractContentBlocksText(data?.content);
  if (contentText.length > 0 && !parts.includes(contentText)) {
    parts.push(contentText);
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  return toolCall.detail ?? "";
}

function resolveToolName(toolCall: AcpToolCallState): string {
  const data = asRecord(toolCall.data);
  const candidate =
    asTrimmedString(data?.toolName) ??
    asTrimmedString(data?.name) ??
    asTrimmedString(toolCall.title) ??
    "";
  return candidate.replace(/^run\s+/iu, "").toLowerCase();
}

export function createGeminiBackgroundTaskTracker<E = never>(
  options: GeminiBackgroundTaskTrackerOptions<E>,
): GeminiBackgroundTaskTracker {
  const tasks = new Map<string, TrackedBackgroundTask>();
  const currentTimeMs: Effect.Effect<number> = options.now
    ? Effect.sync(options.now)
    : Clock.currentTimeMillis;
  const readLogTail = options.readLogTail ?? defaultReadLogTail;
  const readLogStat =
    options.readLogStat ?? (options.readLogTail ? () => null : defaultReadLogStat);
  const resolveTaskLog =
    options.resolveTaskLogPath ??
    ((taskId: string) => resolveAntigravityTaskLogPath(taskId, options.profileDirectories));
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const stopTimerIfIdle = () => {
    const hasActive = Array.from(tasks.values()).some((task) => !task.completed);
    if (!hasActive && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const emitSafely = (
    build: (stamp: EventStamp) => ProviderRuntimeEvent,
  ): Effect.Effect<void, never> =>
    disposed
      ? Effect.void
      : options.makeEventStamp().pipe(
          Effect.flatMap((stamp) => options.emitEvent(build(stamp))),
          Effect.catch(() => Effect.void),
        );

  const completeTask = (
    task: TrackedBackgroundTask,
    status: "completed" | "failed" | "stopped",
    summary: string,
  ): Effect.Effect<void, never> => {
    if (task.completed) return Effect.void;
    task.completed = true;
    tasks.delete(task.taskId);
    stopTimerIfIdle();
    const safeSummary = redactToolActivityText(summary, 180) || task.title;
    return emitSafely((stamp) => ({
      type: "task.completed",
      ...stamp,
      provider: PROVIDER,
      threadId: options.threadId,
      turnId: task.turnId,
      payload: {
        taskId: RuntimeTaskId.make(task.taskId),
        status,
        summary: safeSummary,
        taskType: task.taskType,
        agentKind: task.agentKind,
        title: task.title,
        ...(task.role ? { role: task.role } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.outputFile ? { outputFile: task.outputFile } : {}),
      },
    }));
  };

  const pollOnce = (): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (disposed || tasks.size === 0) {
        stopTimerIfIdle();
        return;
      }
      const currentMs = yield* currentTimeMs;
      for (const task of Array.from(tasks.values())) {
        if (task.completed) continue;
        if (task.expiresAtMs !== undefined && currentMs >= task.expiresAtMs) {
          yield* completeTask(task, "completed", `${task.title} · 예약 대기 만료`);
          continue;
        }
        if (currentMs - task.startedAtMs > MAX_TASK_AGE_MS) {
          yield* completeTask(task, "stopped", `${task.title} · 추적 시간 상한(30분) 도달`);
          continue;
        }
        if (!task.outputFile) {
          const discoveredLog = resolveTaskLog(task.taskId);
          if (discoveredLog) {
            task.outputFile = discoveredLog;
            task.inferredFromBlindStatus = false;
          }
        }
        if (!task.outputFile) {
          if (
            task.inferredFromBlindStatus &&
            currentMs - task.lastActivityAtMs >= BLIND_STATUS_IDLE_TTL_MS
          ) {
            yield* completeTask(
              task,
              "completed",
              `${task.title} · 추가 상태 보고 없음으로 자동 정리`,
            );
          }
          continue;
        }
        const tail = readLogTail(task.outputFile, task.lastSize);
        if (!tail) {
          const stat = readLogStat(task.outputFile);
          const effectiveMtimeMs = stat?.mtimeMs ?? task.lastFileMtimeMs;
          if (stat?.mtimeMs !== undefined) {
            task.lastFileMtimeMs = stat.mtimeMs;
          }
          if (
            effectiveMtimeMs !== undefined &&
            currentMs - effectiveMtimeMs >= LOG_STALE_COMPLETE_MS &&
            currentMs - task.lastActivityAtMs >= LOG_STALE_COMPLETE_MS
          ) {
            yield* completeTask(
              task,
              "completed",
              task.lastLine || `${task.title} · 로그 출력 종료로 자동 완료`,
            );
          }
          continue;
        }
        task.lastSize = tail.size;
        if (tail.mtimeMs !== undefined) {
          task.lastFileMtimeMs = tail.mtimeMs;
        }
        task.lastActivityAtMs = currentMs;
        const terminalStatus = classifyTerminalOutputText(tail.text);
        const latestLine = extractLatestMeaningfulLogLine(tail.text);
        if (terminalStatus !== null) {
          yield* completeTask(
            task,
            terminalStatus,
            latestLine ??
              (terminalStatus === "failed"
                ? `${task.title} 실패`
                : terminalStatus === "stopped"
                  ? `${task.title} 중지됨`
                  : `${task.title} 완료`),
          );
          continue;
        }
        if (tail.mtimeMs !== undefined && currentMs - tail.mtimeMs >= LOG_STALE_COMPLETE_MS) {
          yield* completeTask(
            task,
            "completed",
            latestLine ?? `${task.title} · 로그 출력 종료로 자동 완료`,
          );
          continue;
        }
        if (latestLine && latestLine !== task.lastLine) {
          task.lastLine = latestLine;
          yield* emitSafely((stamp) => ({
            type: "task.progress",
            ...stamp,
            provider: PROVIDER,
            threadId: options.threadId,
            turnId: task.turnId,
            payload: {
              taskId: RuntimeTaskId.make(task.taskId),
              description: latestLine,
              summary: latestLine,
              taskType: task.taskType,
              agentKind: task.agentKind,
              title: task.title,
              lastToolName: "run_command",
              status: "running",
              ...(task.role ? { role: task.role } : {}),
              ...(task.model ? { model: task.model } : {}),
              ...(task.outputFile ? { outputFile: task.outputFile } : {}),
            },
          }));
        }
      }
      stopTimerIfIdle();
    });

  const ensureTimer = () => {
    if (disposed || timer !== null || pollIntervalMs <= 0) return;
    timer = setInterval(() => {
      void Effect.runPromise(pollOnce()).catch(() => {});
    }, pollIntervalMs);
    timer.unref?.();
  };

  const registerTask = (task: TrackedBackgroundTask): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (disposed || tasks.has(task.taskId)) return;
      if (tasks.size >= MAX_CONCURRENT_TASKS) {
        const oldestKey = tasks.keys().next().value;
        const oldestTask = oldestKey !== undefined ? tasks.get(oldestKey) : undefined;
        if (oldestTask) {
          yield* completeTask(
            oldestTask,
            "stopped",
            `${oldestTask.title} · 동시 추적 상한(${MAX_CONCURRENT_TASKS}건) 초과로 정리`,
          );
        }
      }
      tasks.set(task.taskId, task);
      ensureTimer();
      yield* emitSafely((stamp) => ({
        type: "task.started",
        ...stamp,
        provider: PROVIDER,
        threadId: options.threadId,
        turnId: task.turnId,
        payload: {
          taskId: RuntimeTaskId.make(task.taskId),
          description: task.title,
          taskType: task.taskType,
          agentKind: task.agentKind,
          title: task.title,
          ...(task.role ? { role: task.role } : {}),
          ...(task.model ? { model: task.model } : {}),
          ...(task.outputFile ? { outputFile: task.outputFile } : {}),
        },
      }));
    });

  const observeToolCall: GeminiBackgroundTaskTracker["observeToolCall"] = (
    toolCall,
    turnId,
    model,
  ) =>
    Effect.gen(function* () {
      if (disposed) return;
      const data = asRecord(toolCall.data);
      const rawInput = asRecord(data?.rawInput);
      const outputText = extractRawOutputText(toolCall);
      const toolName = resolveToolName(toolCall);
      const isInProgress = toolCall.status === "inProgress" || toolCall.status === "pending";
      const isTerminal = toolCall.status === "completed" || toolCall.status === "failed";

      // 1. Background task explicitly reported in output text (run_command / run_workflow)
      const bgTaskMatch = BACKGROUND_TASK_ID_PATTERN.exec(outputText);
      if (bgTaskMatch?.[1]) {
        const taskId = bgTaskMatch[1].trim().replace(/[.,;:'")\]}]+$/u, "");
        const logMatch = TASK_LOG_URL_PATTERN.exec(outputText);
        const outputFile = logMatch?.[1]
          ? normalizeWhitelistedAntigravityLogPath(logMatch[1])
          : undefined;
        const isWorkflow =
          toolName.includes("run_workflow") ||
          rawInput?.Script !== undefined ||
          rawInput?.ScriptPath !== undefined;
        const rawTitle =
          asTrimmedString(rawInput?.Description) ??
          asTrimmedString(rawInput?.toolSummary) ??
          asTrimmedString(data?.intent) ??
          asTrimmedString(rawInput?.CommandLine) ??
          asTrimmedString(toolCall.command) ??
          (isWorkflow ? "백그라운드 워크플로우 실행" : "백그라운드 명령 실행");
        const title = redactToolActivityText(rawTitle.replace(/\s+/gu, " "), 120);
        // Promote any temporary workflow/daemon handle for the same toolCallId into the real taskId.
        const tempWorkflowTask = tasks.get(`workflow:${toolCall.toolCallId}`);
        if (tempWorkflowTask) {
          tasks.delete(tempWorkflowTask.taskId);
        }
        const tempDaemonTask = tasks.get(`daemon:${toolCall.toolCallId}`);
        if (tempDaemonTask) {
          tasks.delete(tempDaemonTask.taskId);
        }
        const startedAtMs = yield* currentTimeMs;
        const resolvedOutputFile = outputFile ?? resolveTaskLog(taskId);
        yield* registerTask({
          taskId,
          taskType: isWorkflow ? "local_agent" : "local_bash",
          agentKind: isWorkflow ? "agent" : "background",
          title,
          ...(model ? { model } : {}),
          ...(resolvedOutputFile ? { outputFile: resolvedOutputFile } : {}),
          turnId,
          startedAtMs,
          lastActivityAtMs: startedAtMs,
          inferredFromBlindStatus: false,
          turnBound: false,
          lastSize: 0,
          lastLine: "",
          completed: false,
        });
        return;
      }

      // 2. `run_workflow` live execution tracking (Antigravity ACP frequently sends rawOutput: null)
      const isRunWorkflow =
        toolName.includes("run_workflow") ||
        (rawInput !== undefined &&
          (rawInput.Script !== undefined || rawInput.ScriptPath !== undefined));
      if (isRunWorkflow) {
        const workflowTaskId = `workflow:${toolCall.toolCallId}`;
        const existing = tasks.get(workflowTaskId);
        if (isInProgress) {
          const rawTitle =
            asTrimmedString(rawInput?.Description) ??
            asTrimmedString(rawInput?.ScriptPath) ??
            "워크플로우 실행";
          const title = redactToolActivityText(rawTitle.replace(/\s+/gu, " "), 120);
          const wfStartedAtMs = yield* currentTimeMs;
          yield* registerTask({
            taskId: workflowTaskId,
            taskType: "local_agent",
            agentKind: "agent",
            title,
            ...(model ? { model } : {}),
            turnId,
            startedAtMs: wfStartedAtMs,
            lastActivityAtMs: wfStartedAtMs,
            inferredFromBlindStatus: false,
            turnBound: true,
            lastSize: 0,
            lastLine: "",
            completed: false,
          });
          return;
        }
        if (isTerminal && existing) {
          const latestLine = extractLatestMeaningfulLogLine(outputText);
          yield* completeTask(
            existing,
            toolCall.status === "failed" ? "failed" : "completed",
            latestLine ??
              (toolCall.status === "failed" ? `${existing.title} 실패` : `${existing.title} 완료`),
          );
        }
        return;
      }

      // 3. Daemon `run_command` (`IsDaemon: true`) where Antigravity omits or delays task id output
      if (rawInput?.IsDaemon === true) {
        const daemonTaskId = `daemon:${toolCall.toolCallId}`;
        const existing = tasks.get(daemonTaskId);
        const exitMatch = EXIT_CODE_PATTERN.exec(outputText);
        if (exitMatch?.[1] !== undefined || toolCall.status === "failed") {
          if (existing) {
            const code = exitMatch?.[1] !== undefined ? Number(exitMatch[1]) : 1;
            yield* completeTask(
              existing,
              code === 0 ? "completed" : "failed",
              extractLatestMeaningfulLogLine(outputText) ?? `종료 코드 ${code}`,
            );
          }
          return;
        }
        const rawTitle =
          asTrimmedString(rawInput.toolSummary) ??
          asTrimmedString(rawInput.CommandLine) ??
          asTrimmedString(toolCall.command) ??
          "백그라운드 데몬 실행";
        const daemonStartedAtMs = yield* currentTimeMs;
        yield* registerTask({
          taskId: daemonTaskId,
          taskType: "local_bash",
          agentKind: "background",
          title: redactToolActivityText(rawTitle.replace(/\s+/gu, " "), 120),
          ...(model ? { model } : {}),
          turnId,
          startedAtMs: daemonStartedAtMs,
          lastActivityAtMs: daemonStartedAtMs,
          inferredFromBlindStatus: false,
          turnBound: false,
          lastSize: 0,
          lastLine: "",
          completed: false,
        });
        return;
      }

      // 4. Subagent launched via `invoke_subagent`
      const role = asTrimmedString(rawInput?.Role);
      const subagentType = asTrimmedString(rawInput?.TypeName);
      if (role || subagentType || toolName.includes("invoke_subagent")) {
        const fallbackId = `subagent:${toolCall.toolCallId}`;
        if (toolCall.status === "failed") {
          const existing = tasks.get(fallbackId);
          if (existing) {
            yield* completeTask(
              existing,
              "failed",
              extractLatestMeaningfulLogLine(outputText) ?? `${existing.title} 실행 실패`,
            );
          }
          return;
        }
        const convMatch = SUBAGENT_CONVERSATION_ID_PATTERN.exec(outputText);
        const subagentId = convMatch?.[1] ?? fallbackId;
        if (convMatch?.[1] && tasks.has(fallbackId)) {
          tasks.delete(fallbackId);
        }
        const title = redactToolActivityText(role ?? subagentType ?? "하위 에이전트 작업", 120);
        const subStartedAtMs = yield* currentTimeMs;
        yield* registerTask({
          taskId: subagentId,
          taskType: "local_agent",
          agentKind: "agent",
          title,
          ...(role ? { role } : {}),
          ...(model ? { model } : {}),
          turnId,
          startedAtMs: subStartedAtMs,
          lastActivityAtMs: subStartedAtMs,
          inferredFromBlindStatus: false,
          turnBound: false,
          lastSize: 0,
          lastLine: "",
          completed: false,
        });
        return;
      }

      // 5. Swarm workers managed via `swarm` (`action: "add" | "kill"`)
      if (toolName.includes("swarm") && rawInput) {
        const swarmAction = asTrimmedString(rawInput.action)?.toLowerCase();
        const workerName = asTrimmedString(rawInput.name);
        if (swarmAction === "add") {
          const swarmTaskId = `swarm:${workerName ?? toolCall.toolCallId}`;
          if (toolCall.status === "failed") {
            const existing = tasks.get(swarmTaskId);
            if (existing) {
              yield* completeTask(existing, "failed", `${existing.title} 시작 실패`);
            }
            return;
          }
          const brief = asTrimmedString(rawInput.brief);
          const label = workerName ? `Swarm · ${workerName}` : "Swarm 워커";
          const swarmStartedAtMs = yield* currentTimeMs;
          yield* registerTask({
            taskId: swarmTaskId,
            taskType: "local_agent",
            agentKind: "agent",
            title: redactToolActivityText(brief ? `${label}: ${brief}` : label, 120),
            ...(workerName ? { role: workerName } : {}),
            ...(model ? { model } : {}),
            turnId,
            startedAtMs: swarmStartedAtMs,
            lastActivityAtMs: swarmStartedAtMs,
            inferredFromBlindStatus: false,
            turnBound: false,
            lastSize: 0,
            lastLine: "",
            completed: false,
          });
          return;
        }
        if (swarmAction === "kill" && workerName) {
          const tracked = tasks.get(`swarm:${workerName}`);
          if (tracked) {
            yield* completeTask(tracked, "stopped", `${tracked.title} · 워커 종료됨`);
          }
          return;
        }
      }

      // 6. Scheduled timer / monitor via `schedule`
      if (
        toolName.includes("schedule") ||
        (rawInput !== undefined &&
          (rawInput.DurationSeconds !== undefined || rawInput.CronExpression !== undefined))
      ) {
        if (rawInput?.DurationSeconds === undefined && rawInput?.CronExpression === undefined) {
          return;
        }
        const schedMatch = SCHEDULE_TASK_ID_PATTERN.exec(outputText);
        const schedTaskId = schedMatch?.[1]?.trim() || `schedule:${toolCall.toolCallId}`;
        if (toolCall.status === "failed") {
          const existing = tasks.get(schedTaskId);
          if (existing) {
            yield* completeTask(existing, "failed", `${existing.title} 예약 실패`);
          }
          return;
        }
        const promptTitle = asTrimmedString(rawInput.Prompt) ?? "예약 작업 대기";
        const schedStartedAtMs = yield* currentTimeMs;
        const durationSec =
          typeof rawInput.DurationSeconds === "number" &&
          Number.isFinite(rawInput.DurationSeconds) &&
          rawInput.DurationSeconds > 0
            ? rawInput.DurationSeconds
            : undefined;
        const isOneShotTimer = durationSec !== undefined && rawInput.CronExpression === undefined;
        yield* registerTask({
          taskId: schedTaskId,
          taskType: "monitor",
          agentKind: "background",
          title: redactToolActivityText(promptTitle.replace(/\s+/gu, " "), 120),
          ...(model ? { model } : {}),
          turnId,
          startedAtMs: schedStartedAtMs,
          lastActivityAtMs: schedStartedAtMs,
          ...(isOneShotTimer
            ? {
                expiresAtMs:
                  schedStartedAtMs + Math.ceil(durationSec * 1_000) + SCHEDULE_EXPIRY_GRACE_MS,
              }
            : {}),
          inferredFromBlindStatus: false,
          turnBound: false,
          lastSize: 0,
          lastLine: "",
          completed: false,
        });
        return;
      }

      // 7. `manage_task` status / send_input / list / kill updates
      const manageAction = asTrimmedString(rawInput?.Action)?.toLowerCase();
      const targetTaskId = asTrimmedString(rawInput?.TaskId);
      if (manageAction === "list" && toolName.includes("manage_task")) {
        if (outputText && NO_RUNNING_TASKS_PATTERN.test(outputText)) {
          for (const task of Array.from(tasks.values())) {
            if (!task.turnBound && task.agentKind === "background") {
              yield* completeTask(task, "completed", `${task.title} · 실행 중인 작업 없음 확인`);
            }
          }
        }
        return;
      }
      if (manageAction && targetTaskId) {
        let tracked = tasks.get(targetTaskId);
        if (manageAction === "kill") {
          if (tracked) {
            yield* completeTask(tracked, "stopped", `${tracked.title} · 작업 중지됨`);
          }
          return;
        }
        const nowMs = yield* currentTimeMs;
        const resolvedLog = tracked?.outputFile ?? resolveTaskLog(targetTaskId);
        const diskStat = resolvedLog ? readLogStat(resolvedLog) : null;
        const diskTail = resolvedLog ? readLogTail(resolvedLog, tracked?.lastSize ?? 0) : null;
        const diskMtimeMs = diskTail?.mtimeMs ?? diskStat?.mtimeMs ?? tracked?.lastFileMtimeMs;
        const diskTerminal = diskTail ? classifyTerminalOutputText(diskTail.text) : null;
        const diskLatestLine = diskTail ? extractLatestMeaningfulLogLine(diskTail.text) : undefined;
        const diskLogIsStaleHistorical =
          diskMtimeMs !== undefined && nowMs - diskMtimeMs >= LOG_STALE_COMPLETE_MS;

        const exitMatch = outputText ? EXIT_CODE_PATTERN.exec(outputText) : null;
        const latestLine =
          (outputText ? extractLatestMeaningfulLogLine(outputText) : undefined) ?? diskLatestLine;
        const outputTerminal = classifyTerminalOutputText(outputText);
        const terminalStatus =
          outputTerminal ?? diskTerminal ?? (diskLogIsStaleHistorical ? "completed" : null);

        // If the task is already finished (either in ACP output, via exit marker on disk, or
        // because its on-disk .log file has been untouched for >= 90s), complete any existing
        // entry and NEVER register a zombie entry for a historical/finished task!
        if (terminalStatus !== null) {
          if (tracked) {
            yield* completeTask(
              tracked,
              terminalStatus,
              latestLine ??
                (terminalStatus === "failed"
                  ? `${tracked.title} 실패`
                  : terminalStatus === "stopped"
                    ? `${tracked.title} 취소됨`
                    : `${tracked.title} 완료`),
            );
          }
          return;
        }

        // Antigravity ACP often omits rawOutput on the original launcher call (`run_workflow` /
        // backgrounded `run_command`), so `manage_task(status/send_input)` is frequently the first
        // place the real taskId appears. Auto-discover and attach its on-disk .log file when available.
        if (!tracked && (manageAction === "status" || manageAction === "send_input")) {
          const shortId = targetTaskId.includes("/")
            ? (targetTaskId.split("/").at(-1) ?? targetTaskId)
            : targetTaskId;
          const discovered: TrackedBackgroundTask = {
            taskId: targetTaskId,
            taskType: "local_bash",
            agentKind: "background",
            title: redactToolActivityText(`백그라운드 작업 (${shortId})`, 120),
            ...(model ? { model } : {}),
            ...(resolvedLog ? { outputFile: resolvedLog } : {}),
            turnId,
            startedAtMs: nowMs,
            lastActivityAtMs: nowMs,
            ...(diskMtimeMs !== undefined ? { lastFileMtimeMs: diskMtimeMs } : {}),
            inferredFromBlindStatus: resolvedLog === undefined,
            turnBound: false,
            lastSize: diskTail?.size ?? diskStat?.size ?? 0,
            lastLine: diskLatestLine ?? "",
            completed: false,
          };
          yield* registerTask(discovered);
          tracked = tasks.get(targetTaskId);
          if (!tracked) return;
        }

        if (!tracked) return;

        tracked.lastActivityAtMs = nowMs;
        if (diskMtimeMs !== undefined) {
          tracked.lastFileMtimeMs = diskMtimeMs;
        }
        if (!tracked.outputFile && resolvedLog) {
          tracked.outputFile = resolvedLog;
          tracked.inferredFromBlindStatus = false;
        }
        if (diskTail) {
          tracked.lastSize = diskTail.size;
        }

        if (manageAction === "status" && (outputText || diskLatestLine)) {
          if (exitMatch?.[1] !== undefined) {
            const exitCode = Number(exitMatch[1]);
            yield* completeTask(
              tracked,
              exitCode === 0 ? "completed" : "failed",
              latestLine ?? `종료 코드 ${exitCode}`,
            );
            return;
          }
          if (latestLine && latestLine !== tracked.lastLine) {
            tracked.lastLine = latestLine;
            yield* emitSafely((stamp) => ({
              type: "task.progress",
              ...stamp,
              provider: PROVIDER,
              threadId: options.threadId,
              turnId: tracked.turnId,
              payload: {
                taskId: RuntimeTaskId.make(tracked.taskId),
                description: latestLine,
                summary: latestLine,
                taskType: tracked.taskType,
                agentKind: tracked.agentKind,
                title: tracked.title,
                lastToolName: "manage_task",
                status: "running",
                ...(tracked.model ? { model: tracked.model } : {}),
                ...(tracked.outputFile ? { outputFile: tracked.outputFile } : {}),
              },
            }));
          }
          return;
        }

        if (manageAction === "status" || manageAction === "send_input") {
          // Heartbeat progress even when ACP omits rawOutput so liveness doesn't go STALLED.
          yield* emitSafely((stamp) => ({
            type: "task.progress",
            ...stamp,
            provider: PROVIDER,
            threadId: options.threadId,
            turnId: tracked.turnId,
            payload: {
              taskId: RuntimeTaskId.make(tracked.taskId),
              description: tracked.lastLine || `${tracked.title} 상태 확인 중`,
              summary: tracked.lastLine || `${tracked.title} 상태 확인 중`,
              taskType: tracked.taskType,
              agentKind: tracked.agentKind,
              title: tracked.title,
              lastToolName: "manage_task",
              status: "running",
              ...(tracked.model ? { model: tracked.model } : {}),
              ...(tracked.outputFile ? { outputFile: tracked.outputFile } : {}),
            },
          }));
        }
        return;
      }

      // 8. `manage_subagents` kill / kill_all
      if (manageAction === "kill_all" && toolName.includes("manage_subagents")) {
        for (const task of Array.from(tasks.values())) {
          if (task.agentKind === "agent") {
            yield* completeTask(task, "stopped", `${task.title} · 하위 에이전트 종료됨`);
          }
        }
        return;
      }
      if (manageAction === "kill" && Array.isArray(rawInput?.ConversationIds)) {
        for (const id of rawInput.ConversationIds) {
          if (typeof id !== "string") continue;
          const tracked = tasks.get(id.trim());
          if (tracked) {
            yield* completeTask(tracked, "stopped", `${tracked.title} · 하위 에이전트 종료됨`);
          }
        }
      }
    });

  const onTurnEnded: GeminiBackgroundTaskTracker["onTurnEnded"] = (turnId, outcome = "completed") =>
    Effect.gen(function* () {
      if (disposed || tasks.size === 0) return;
      const nowMs = yield* currentTimeMs;
      for (const task of Array.from(tasks.values())) {
        if (task.completed) continue;
        // One-shot scheduled timer created in a prior turn that already woke or expired
        if (
          task.taskType === "monitor" &&
          task.expiresAtMs !== undefined &&
          (nowMs >= task.expiresAtMs ||
            (turnId !== undefined && task.turnId !== undefined && task.turnId !== turnId))
        ) {
          yield* completeTask(task, "completed", `${task.title} · 예약 대기 완료`);
          continue;
        }
        if (!task.turnBound) continue;
        if (turnId !== undefined && task.turnId !== undefined && task.turnId !== turnId) continue;
        yield* completeTask(
          task,
          outcome,
          outcome === "failed"
            ? `${task.title} 실패`
            : outcome === "stopped"
              ? `${task.title} 중지됨`
              : `${task.title} 완료`,
        );
      }
    });

  return {
    observeToolCall,
    onTurnEnded,
    pollOnce,
    dispose: () => {
      disposed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      tasks.clear();
    },
    activeCount: () => tasks.size,
    nonDaemonActiveCount: () =>
      Array.from(tasks.values()).filter(
        (task) =>
          !task.completed && task.taskType !== "monitor" && !task.taskId.startsWith("daemon:"),
      ).length,
    cancelAll: (outcome = "stopped") =>
      Effect.forEach(
        Array.from(tasks.values()),
        (task) => completeTask(task, outcome, `${task.title} · 사용자 정지`),
        { discard: true },
      ),
  };
}
