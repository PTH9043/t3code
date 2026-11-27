// @effect-diagnostics nodeBuiltinImport:off - Locate the worker in source and bundled deployments.
import { fileURLToPath } from "node:url";
import {
  ThreadId,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ServerSettings,
  type WorkspaceAgentControlError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ServerConfig } from "../config.ts";
import {
  confirmActiveWatchdogMcpRecovery,
  restoreActiveWatchdogMcpCredential,
  revokeActiveMcpThread,
} from "../mcp/McpSessionRegistry.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutionError,
  type WorkspaceAgentExecutionInput,
} from "./Services/WorkspaceAgentExecutor.ts";
import { WATCHDOG_PROJECTION_CONSUMER, type WatchdogJournal } from "./WatchdogJournal.ts";
import { launchWatchdogExecution } from "./WatchdogLaunch.ts";
import {
  beginWatchdogProjection,
  drainWatchdogProjection,
  type ProjectionInput,
} from "./Layers/WatchdogEventProjection.ts";
import { workspaceExecutionMessageId } from "./workspaceFormatRepair.ts";

export { WATCHDOG_PROJECTION_CONSUMER } from "./WatchdogJournal.ts";

export const watchdogWorkerEntrypoint = () =>
  fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./watchdog-worker.ts" : "./watchdog-worker.mjs",
      import.meta.url,
    ),
  );

/** Reattach only after a fresh worker proof; never re-submit the model turn. */
export const resumeDetachedWatchdog = Effect.fn("resumeDetachedWatchdog")(function* (
  input: ProjectionInput & {
    readonly activate: Effect.Effect<void, WorkspaceAgentControlError>;
    readonly deactivate: Effect.Effect<void, never>;
    readonly restore?: typeof restoreActiveWatchdogMcpCredential;
    readonly revoke?: typeof revokeActiveMcpThread;
    readonly beforeRead?: Effect.Effect<void>;
  },
) {
  const identity = yield* Effect.sync(() => input.journal.executionProvider(input.jobId));
  if (
    !identity ||
    identity.provider !== input.provider ||
    identity.providerInstanceId !== input.providerInstanceId
  )
    throw new Error("Watchdog recovery provider does not match its recorded execution.");
  let attached = false;
  let challenge: ReturnType<WatchdogJournal["challengeWorker"]>;
  yield* beginWatchdogProjection(input);
  return yield* Effect.gen(function* () {
    while (true) {
      if (input.beforeRead) yield* input.beforeRead;
      const job = yield* Effect.sync(() => input.journal.get(input.jobId));
      if (!job) throw new Error("Watchdog execution disappeared during recovery.");
      let justAttached = false;
      if (!attached && job.state === "running") {
        challenge ??= yield* Effect.sync(() => input.journal.challengeWorker(input.jobId));
        if (
          challenge &&
          (yield* (input.restore ?? restoreActiveWatchdogMcpCredential)({
            journal: input.journal,
            jobId: input.jobId,
            challenge,
          }))
        ) {
          const activation = yield* Effect.exit(input.activate);
          if (activation._tag === "Failure") {
            yield* (input.revoke ?? revokeActiveMcpThread)(
              ThreadId.make(input.worker.execution.executionId),
            );
            return yield* Effect.failCause(activation.cause);
          }
          yield* confirmActiveWatchdogMcpRecovery(
            ThreadId.make(input.worker.execution.executionId),
          );
          attached = true;
          justAttached = true;
        }
      }
      // Restore the live worker's tool authority before replaying a potentially
      // large backlog. Until the challenge is answered, process at most one
      // event per pass so a long stream cannot starve the handshake.
      const progress = yield* drainWatchdogProjection(
        input,
        !attached && job.state === "running" ? 1 : 100,
      );
      if (progress.status !== "open") return progress;
      if (progress.applied === 0 && !justAttached) yield* Effect.sleep("250 millis");
    }
  }).pipe(Effect.ensuring(Effect.suspend(() => (attached ? input.deactivate : Effect.void))));
});

/** Run a selected watchdog outside the server; server interruption does not cancel the child. */
export const executeDetachedWatchdog = Effect.fn("executeDetachedWatchdog")(
  function* (input: {
    readonly journal: WatchdogJournal;
    readonly engine: OrchestrationEngineShape;
    readonly queries: Pick<ProjectionSnapshotQueryShape, "getThreadRuntimeContext">;
    readonly serverConfig: ServerConfig["Service"];
    readonly settings: ServerSettings;
    readonly instance: ProviderInstanceConfig;
    readonly provider: ProviderDriverKind;
    readonly worker: WorkspaceAgentExecutionInput;
    readonly entry?: string;
    readonly launch?: typeof launchWatchdogExecution;
  }) {
    const { execution, modelSelection } = input.worker;
    const unsettled = yield* Effect.sync(() =>
      input.journal.listUnsettledForRun(
        execution.ownerThreadId,
        execution.runId,
        WATCHDOG_PROJECTION_CONSUMER,
      ),
    );
    if (unsettled.length > 0)
      return yield* new WorkspaceAgentExecutionError({
        message:
          "이전 감시 실행의 결과 또는 반영 상태가 확인되지 않았습니다. 중복 실행하지 않고 기록을 보존합니다.",
        interrupted: true,
      });
    const jobId = String(execution.executionId);
    const sessionId = ThreadId.make(jobId);
    const projection = {
      engine: input.engine,
      queries: input.queries,
      journal: input.journal,
      jobId,
      consumer: WATCHDOG_PROJECTION_CONSUMER,
      provider: input.provider,
      providerInstanceId: modelSelection.instanceId,
      worker: input.worker,
    };
    const result = yield* (input.launch ?? launchWatchdogExecution)({
      journal: input.journal,
      jobId,
      entry: input.entry ?? watchdogWorkerEntrypoint(),
      signal: AbortSignal.timeout(10_000),
      serverConfig: input.serverConfig,
      settings: input.settings,
      instance: input.instance,
      providerInstanceId: modelSelection.instanceId,
      execution,
      start: {
        threadId: sessionId,
        execution,
        provider: input.provider,
        providerInstanceId: modelSelection.instanceId,
        cwd: input.worker.cwd,
        runtimeMode: input.worker.runtimeMode,
        modelSelection,
      },
      turn: {
        threadId: sessionId,
        input: input.worker.prompt,
        modelSelection,
        interactionMode: input.worker.interactionMode,
      },
      beforeSpawn: beginWatchdogProjection(projection).pipe(Effect.asVoid, Effect.orDie),
    });
    if (result.status === "unsettled")
      return yield* new WorkspaceAgentExecutionError({
        message: "이전 감시 실행의 결과 또는 반영 상태가 확인되지 않아 중복 실행을 막았습니다.",
        interrupted: true,
      });
    if (result.status === "not-started")
      return yield* new WorkspaceAgentExecutionError({
        message: "감시 실행을 시작하지 못했습니다. 선택한 모델과 도구 연결 상태를 확인하세요.",
      });
    while (true) {
      const state = yield* drainWatchdogProjection(projection);
      if (state.status === "unknown")
        return yield* new WorkspaceAgentExecutionError({
          message: `감시 실행의 처리 결과가 확인되지 않았습니다 (${state.outcome}). 중복 실행하지 않고 기록을 보존합니다.`,
          interrupted: true,
        });
      if (state.status === "finished") {
        const job = yield* Effect.sync(() => input.journal.get(jobId));
        if (job?.state !== "completed")
          return yield* new WorkspaceAgentExecutionError({
            message: `감시 실행이 ${job?.state ?? "unknown"} 상태로 종료됐습니다.`,
            interrupted: job?.state === "cancelled",
          });
        const owner = yield* input.queries.getThreadRuntimeContext(execution.ownerThreadId, {
          messages: true,
        });
        if (Option.isNone(owner))
          return yield* new WorkspaceAgentExecutionError({
            message: "감시 결과의 대화를 찾을 수 없습니다.",
          });
        const message = owner.value.messages.find(
          (item) => item.id === workspaceExecutionMessageId(execution),
        );
        if (!message || message.streaming)
          return yield* new WorkspaceAgentExecutionError({
            message: "감시 결과의 저장 완료를 확인할 수 없습니다.",
          });
        return message.text;
      }
      if (state.applied === 0) yield* Effect.sleep("250 millis");
    }
  },
  Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
    const error = Cause.squash(cause);
    return Effect.fail(
      error instanceof WorkspaceAgentExecutionError
        ? error
        : new WorkspaceAgentExecutionError({ message: Cause.pretty(cause) }),
    );
  }),
);
