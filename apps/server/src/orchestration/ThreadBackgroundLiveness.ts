// @effect-diagnostics globalDate:off
/**
 * ThreadBackgroundLivenessService - in-memory per-thread background liveness
 * and unified multi-model ground-truth task registry (UnifiedBgTask).
 *
 * The turn can settle while native background work runs on (subagent fleets,
 * workflow runs, Monitor watch loops); the shell previously showed nothing.
 * Ingestion records task lifecycle transitions and the shell query reads the
 * derived state at mapping time — no persistence, no migration. After a
 * server restart the registry is empty until new task events arrive, which
 * matches reality: orphaned background work is not live.
 *
 * "monitoring" is reserved for watch loops (monitor tasks and background
 * shells) when they are the ONLY live work; any agent work presents as
 * "working".
 *
 * @module ThreadBackgroundLivenessService
 */
import {
  BG_TASK_STALLED_THRESHOLD_MS,
  INERT_TASK_TYPES,
  MONITOR_TASK_TYPES,
  type ForemanMonitorSnapshot,
  type UnifiedBgExecType,
  type UnifiedBgTask,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { evaluateForemanIndicators } from "./ForemanMonitor.ts";

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

interface TrackedBgTask {
  readonly taskId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly provider: string;
  readonly modelLabel?: string | undefined;
  readonly title: string;
  readonly execType: UnifiedBgExecType;
  readonly proofHandle: string;
  readonly startedAtMs: number;
  readonly lastProgressAtMs: number;
  readonly logTail?: string | undefined;
  readonly artifactCount?: number | undefined;
  readonly watcherArmed: boolean;
  readonly state: "RUNNING" | "FAILED";
}

interface ThreadLivenessState {
  readonly agents: Set<string>;
  readonly monitors: Set<string>;
  readonly tasks: Map<string, TrackedBgTask>;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

export interface RecordTaskLivenessInput {
  readonly threadId: string;
  readonly taskId: string;
  readonly taskType: string | undefined;
  readonly status: string | undefined;
  readonly kind: "started" | "progress" | "updated" | "completed";
  readonly agentId?: string | undefined;
  readonly provider?: string | undefined;
  readonly turnId?: string | null | undefined;
  readonly modelLabel?: string | undefined;
  readonly title?: string | undefined;
  readonly execType?: UnifiedBgExecType | undefined;
  readonly proofHandle?: string | undefined;
  readonly logTail?: string | undefined;
  readonly artifactCount?: number | undefined;
  readonly watcherArmed?: boolean | undefined;
  readonly nowMs?: number | undefined;
}

export class ThreadBackgroundLivenessService extends Context.Service<
  ThreadBackgroundLivenessService,
  {
    readonly recordTaskLiveness: (input: RecordTaskLivenessInput) => void;
    readonly clearThreadLiveness: (threadId: string) => void;
    readonly clearThreadNonMonitorLiveness: (threadId: string) => void;
    readonly getThreadBackgroundLiveness: (threadId: string) => ThreadBackgroundLiveness;
    readonly getThreadBackgroundTasks: (
      threadId: string,
      nowMs?: number,
    ) => ReadonlyArray<UnifiedBgTask>;
    readonly diagnoseThreadLiveness: (
      threadId: string,
      options?: {
        readonly nowMs?: number;
        readonly hasPendingUserQuestion?: boolean;
        readonly hasPendingHostApproval?: boolean;
      },
    ) => ForemanMonitorSnapshot;
  }
>()("t3/orchestration/ThreadBackgroundLiveness/ThreadBackgroundLivenessService") {}

export function make(): ThreadBackgroundLivenessService["Service"] {
  const stateByThreadId = new Map<string, ThreadLivenessState>();

  const stateFor = (threadId: string): ThreadLivenessState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created: ThreadLivenessState = {
      agents: new Set(),
      monitors: new Set(),
      tasks: new Map(),
    };
    stateByThreadId.set(threadId, created);
    return created;
  };

  const drop = (threadId: string, taskId: string) => {
    const state = stateByThreadId.get(threadId);
    if (!state) {
      return;
    }
    state.agents.delete(taskId);
    state.monitors.delete(taskId);
    state.tasks.delete(taskId);
    if (state.agents.size === 0 && state.monitors.size === 0 && state.tasks.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  return {
    recordTaskLiveness: (input) => {
      const taskType = input.taskType;
      if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
        drop(input.threadId, input.taskId);
        return;
      }
      if (
        input.agentId !== undefined &&
        (taskType === undefined || MONITOR_TASK_TYPES.has(taskType))
      ) {
        drop(input.threadId, input.taskId);
        return;
      }

      const terminal =
        input.kind === "completed" ||
        input.status === "idle" ||
        (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
      if (terminal) {
        drop(input.threadId, input.taskId);
        return;
      }

      const state = stateFor(input.threadId);
      const prev = state.tasks.get(input.taskId);
      state.agents.delete(input.taskId);
      state.monitors.delete(input.taskId);
      const bucket =
        taskType !== undefined && MONITOR_TASK_TYPES.has(taskType) ? state.monitors : state.agents;
      bucket.add(input.taskId);

      const nowMs = input.nowMs ?? Date.now();
      const provider = input.provider ?? prev?.provider ?? "unknown";
      const execType: UnifiedBgExecType =
        input.execType ??
        prev?.execType ??
        (provider === "codex" && input.taskId.startsWith("resp_") ? "REMOTE_JOB" : "LOCAL_PID");
      const tracked: TrackedBgTask = {
        taskId: input.taskId,
        threadId: input.threadId,
        turnId: input.turnId !== undefined ? input.turnId : (prev?.turnId ?? null),
        provider,
        ...(input.modelLabel !== undefined
          ? { modelLabel: input.modelLabel }
          : prev?.modelLabel !== undefined
            ? { modelLabel: prev.modelLabel }
            : {}),
        title: input.title?.trim() || prev?.title || input.taskId,
        execType,
        proofHandle: input.proofHandle?.trim() || prev?.proofHandle || `task:${input.taskId}`,
        startedAtMs: prev?.startedAtMs ?? nowMs,
        lastProgressAtMs: nowMs,
        ...(input.logTail !== undefined
          ? { logTail: input.logTail }
          : prev?.logTail !== undefined
            ? { logTail: prev.logTail }
            : {}),
        ...(input.artifactCount !== undefined
          ? { artifactCount: input.artifactCount }
          : prev?.artifactCount !== undefined
            ? { artifactCount: prev.artifactCount }
            : {}),
        watcherArmed:
          input.watcherArmed ??
          prev?.watcherArmed ??
          Boolean(taskType !== undefined && MONITOR_TASK_TYPES.has(taskType)),
        state: "RUNNING",
      };
      state.tasks.set(input.taskId, tracked);
    },

    clearThreadLiveness: (threadId) => {
      stateByThreadId.delete(threadId);
    },

    clearThreadNonMonitorLiveness: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) {
        return;
      }
      for (const taskId of [...state.agents]) {
        state.agents.delete(taskId);
        state.tasks.delete(taskId);
      }
      if (state.agents.size === 0 && state.monitors.size === 0 && state.tasks.size === 0) {
        stateByThreadId.delete(threadId);
      }
    },

    getThreadBackgroundLiveness: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) {
        return null;
      }
      if (state.agents.size > 0) {
        return "working";
      }
      if (state.monitors.size > 0) {
        return "monitoring";
      }
      return null;
    },

    getThreadBackgroundTasks: (threadId, nowMs = Date.now()) => {
      const state = stateByThreadId.get(threadId);
      if (!state || state.tasks.size === 0) {
        return [];
      }
      const list: UnifiedBgTask[] = [];
      for (const task of state.tasks.values()) {
        const stalled =
          task.state === "RUNNING" && nowMs - task.lastProgressAtMs >= BG_TASK_STALLED_THRESHOLD_MS;
        list.push({
          taskId: task.taskId,
          threadId: task.threadId,
          turnId: task.turnId,
          provider: task.provider,
          ...(task.modelLabel !== undefined ? { modelLabel: task.modelLabel } : {}),
          title: task.title,
          execType: task.execType,
          proofHandle: task.proofHandle,
          startedAtMs: task.startedAtMs,
          lastProgressAtMs: task.lastProgressAtMs,
          ...(task.logTail !== undefined ? { logTail: task.logTail } : {}),
          ...(task.artifactCount !== undefined ? { artifactCount: task.artifactCount } : {}),
          watcherArmed: task.watcherArmed,
          state: stalled ? "STALLED" : task.state,
        });
      }
      return list;
    },

    diagnoseThreadLiveness: (threadId, options) => {
      const nowMs = options?.nowMs ?? Date.now();
      const state = stateByThreadId.get(threadId);
      let latestProgressMs: number | null = null;
      if (state) {
        for (const task of state.tasks.values()) {
          if (latestProgressMs === null || task.lastProgressAtMs > latestProgressMs) {
            latestProgressMs = task.lastProgressAtMs;
          }
        }
      }
      return evaluateForemanIndicators({
        nowMs,
        lastEventAtMs: latestProgressMs,
        hasPendingUserQuestion: options?.hasPendingUserQuestion ?? false,
        hasPendingHostApproval: options?.hasPendingHostApproval ?? false,
        hasIncompleteWork: Boolean(state && state.tasks.size > 0),
        thresholds: {
          stallMinutes: BG_TASK_STALLED_THRESHOLD_MS / 60_000,
        },
      });
    },
  };
}

export const layer = Layer.effect(ThreadBackgroundLivenessService, Effect.sync(make));
