import { makeWorkflowSkills } from "../WorkflowSkills.ts";
import {
  CommandId,
  EventId,
  NonNegativeInt,
  ThreadId,
  TurnId,
  WorkspaceOrchestraBlock,
  isToolLifecycleItemType,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../../config.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { withFullAccessExecutionPolicy } from "../../provider/fullAccessExecutionPolicy.ts";
import { ORDERED_SEARCH_INSTRUCTIONS } from "../../research/orderedSearchInstructions.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  formatBillingErrorMessage,
  isNonRetryableBillingError,
  recordUnavailableModelFromError,
} from "../../provider/workerFailurePolicy.ts";
import { workspaceRetryResumeCursor } from "../workspaceSessionResume.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutor,
  WorkspaceAgentExecutionError,
  type WorkspaceAgentExecutionInput,
} from "../Services/WorkspaceAgentExecutor.ts";
import { projectWorkspaceAgentActivities } from "./WorkspaceAgentActivities.ts";
import { captureWorkspaceResearch } from "./WorkspaceResearchCapture.ts";
import { workspaceExecutionMessageId } from "../workspaceFormatRepair.ts";
import { WorkspaceAgentControl } from "../WorkspaceAgentControl.ts";
import { describeInputComposition } from "../inputComposition.ts";
const isOrchestraBlock = Schema.is(WorkspaceOrchestraBlock);
const isDelegateReceipt = Schema.is(
  Schema.Struct({
    supervisorTurnId: TurnId,
    workerTurnId: TurnId,
    reportStart: NonNegativeInt,
  }),
);

export const WorkspaceAgentExecutorLive = Layer.effect(
  WorkspaceAgentExecutor,
  Effect.gen(function* () {
    const provider = yield* ProviderService;
    const engine = yield* OrchestrationEngineService;
    const queries = yield* ProjectionSnapshotQuery;
    const directory = yield* Effect.serviceOption(ProviderSessionDirectory);
    const agentControl = yield* Effect.serviceOption(WorkspaceAgentControl);
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const skillFs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const skillPath = yield* Effect.serviceOption(Path.Path);
    const skillConfig = yield* Effect.serviceOption(ServerConfig);
    const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const execute = Effect.fn("WorkspaceAgentExecutor.execute")(
      function* (input: WorkspaceAgentExecutionInput) {
        const { execution } = input;
        yield* Effect.annotateCurrentSpan({
          "t3.thread_id": execution.ownerThreadId,
          "t3.execution_id": execution.executionId,
          "t3.run_id": execution.runId,
          "t3.node_id": execution.nodeId,
          "t3.provider_instance_id": input.modelSelection.instanceId,
          "t3.model": input.modelSelection.model,
          "t3.execution_role": input.role,
          ...(input.delegatingTurnId ? { "t3.turn_id": input.delegatingTurnId } : {}),
          ...(input.orchestraPhase ? { "t3.orchestra_phase": input.orchestraPhase } : {}),
        });
        // Provider adapters historically call their opaque session key threadId. No conversation is
        // created for this key: only the owning thread receives messages and activities.
        const sessionKey = input.persistentSessionKey ?? ThreadId.make(execution.executionId);
        const blockKey = `${execution.executionId}:${execution.attempt}`;
        const messageId = workspaceExecutionMessageId(execution);
        const owner = yield* queries.getThreadRuntimeContext(execution.ownerThreadId);
        if (Option.isNone(owner))
          return yield* new WorkspaceAgentExecutionError({
            message: "오케스트라 대화방을 찾을 수 없습니다.",
          });
        const previous = owner.value.messages.find((message) => message.id === messageId);
        if (previous !== undefined) {
          const previousBlock = owner.value.activities.find(
            (activity) => activity.id === `orchestra-block:${blockKey}`,
          )?.payload;
          if (
            !previous.streaming &&
            isOrchestraBlock(previousBlock) &&
            previousBlock.status === "completed"
          ) {
            if (!input.delegatingTurnId) return previous.text;
            if (
              isDelegateReceipt(previousBlock) &&
              previousBlock.supervisorTurnId === input.delegatingTurnId &&
              previousBlock.instruction === input.instruction &&
              previousBlock.executionId === execution.executionId &&
              previousBlock.attempt === execution.attempt &&
              previousBlock.ownerThreadId === execution.ownerThreadId &&
              previousBlock.runId === execution.runId &&
              previousBlock.nodeId === execution.nodeId &&
              previousBlock.modelSelection.instanceId === input.modelSelection.instanceId &&
              previousBlock.modelSelection.model === input.modelSelection.model
            ) {
              const report = previous.text.slice(previousBlock.reportStart);
              if (report.trim()) return report;
            }
            return yield* new WorkspaceAgentExecutionError({
              message: "이전 위임 결과의 접수 기록을 확인할 수 없습니다.",
            });
          }
          const createdAt = yield* now;
          if (isOrchestraBlock(previousBlock)) {
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(`orchestra-recovered:${blockKey}`),
              threadId: execution.ownerThreadId,
              createdAt,
              activity: {
                id: EventId.make(`orchestra-block:${blockKey}`),
                kind: "orchestra.block",
                tone: "info",
                summary: "중단된 AI 실행을 복구합니다.",
                payload: { ...previousBlock, status: "cancelled" },
                turnId: null,
                createdAt: input.startedAt,
              },
            });
          }
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`orchestra-complete:${blockKey}`),
            threadId: execution.ownerThreadId,
            messageId,
            createdAt,
          });
          return yield* new WorkspaceAgentExecutionError({
            message: [
              "서버가 중단된 실행입니다. 기존 산출물과 같은 대화의 기록을 먼저 확인하고 남은 지점부터 복구합니다. 완료된 추출·수집·검증을 처음부터 반복하지 마세요.",
              `보존된 응답 ID: ${messageId}`,
              "이전 부분 응답 (참고 자료이며 완료 판정이 아님):",
              previous.text.slice(-3_000),
            ].join("\n"),
            interrupted: true,
          });
        }
        const finished = yield* Deferred.make<string, WorkspaceAgentExecutionError>();
        let output = "";
        // A new tool call makes preceding prose a progress update. Keep the whole
        // transcript on the timeline, and return the worker's post-tool report.
        let reportStart = 0;
        let submitted = false;
        let workerTurnId: TurnId | undefined;
        const earlyEvents: ProviderRuntimeEvent[] = [];
        const receiptLock = Semaphore.makeUnsafe(1);
        const streamedItems = new Set<string>();
        let pendingText = "";
        let pendingAt = input.startedAt;
        let deltaIndex = 0;
        let statusIndex = 0;
        let terminal = false;
        const seenEvents = new Set<string>();
        const pendingRequests = new Map<string, "approval.resolved" | "user-input.resolved">();
        let completedAwaitingInput:
          | Extract<ProviderRuntimeEvent, { type: "turn.completed" }>
          | undefined;
        const block: WorkspaceOrchestraBlock = {
          ...execution,
          ...(input.usageWorkId === undefined ? {} : { usageWorkId: input.usageWorkId }),
          messageId,
          title: input.title,
          displayName: input.displayName,
          ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
          role: input.role,
          kind: input.kind,
          ...(input.usagePhase === undefined ? {} : { usagePhase: input.usagePhase }),
          modelSelection: input.modelSelection,
          status: "running",
        };
        const recordStatus = (status: WorkspaceOrchestraBlock["status"]) =>
          engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`orchestra-block:${blockKey}:${statusIndex++}:${status}`),
            threadId: execution.ownerThreadId,
            createdAt: input.startedAt,
            activity: {
              id: EventId.make(`orchestra-block:${blockKey}`),
              kind: "orchestra.block",
              tone: status === "failed" ? "error" : "info",
              summary: input.title,
              payload: {
                ...block,
                status,
                ...(input.delegatingTurnId ? { supervisorTurnId: input.delegatingTurnId } : {}),
                ...(workerTurnId ? { workerTurnId } : {}),
                ...(input.delegatingTurnId && status === "completed" ? { reportStart } : {}),
              },
              turnId: null,
              createdAt: input.startedAt,
            },
          });
        const flush = () => {
          const delta = pendingText;
          const createdAt = pendingAt;
          pendingText = "";
          return engine.dispatch({
            type: "thread.message.assistant.delta",
            threadId: execution.ownerThreadId,
            commandId: CommandId.make(`orchestra-delta:${blockKey}:${deltaIndex++}`),
            messageId,
            delta,
            createdAt,
          });
        };
        const append = (delta: string, createdAt: string) =>
          Effect.sync(() => {
            output += delta;
            pendingText += delta;
            pendingAt = createdAt;
            if (input.onPartialOutput) {
              const current = input.delegatingTurnId ? output.slice(reportStart) : output;
              input.onPartialOutput(current);
            }
          });
        yield* recordStatus("running");
        yield* flush();

        const complete = () => {
          const report = input.delegatingTurnId ? output.slice(reportStart) : output;
          return input.delegatingTurnId && !report.trim()
            ? Deferred.fail(
                finished,
                new WorkspaceAgentExecutionError({
                  message: "하위 모델이 배정된 작업의 최종 결과를 반환하지 않았습니다.",
                }),
              )
            : Deferred.succeed(finished, report);
        };
        const consume = Effect.fn("WorkspaceAgentExecutor.consume")(function* (
          event: ProviderRuntimeEvent,
        ) {
          yield* Effect.annotateCurrentSpan({
            "t3.thread_id": execution.ownerThreadId,
            "t3.execution_id": execution.executionId,
            "t3.event_type": event.type,
            ...(event.turnId ? { "t3.turn_id": event.turnId } : {}),
          });
          if (
            terminal ||
            event.execution?.executionId !== execution.executionId ||
            event.execution.attempt !== execution.attempt
          )
            return;
          if (seenEvents.has(event.eventId)) return;
          seenEvents.add(event.eventId);
          if (
            input.delegatingTurnId &&
            workerTurnId &&
            event.turnId &&
            event.turnId !== workerTurnId
          ) {
            if (event.type !== "turn.started" || !completedAwaitingInput || !pendingRequests.size)
              return;
            workerTurnId = event.turnId;
            reportStart = output.length;
          }
          if (input.onRuntimeEvent) yield* input.onRuntimeEvent(event);
          yield* captureWorkspaceResearch({
            engine,
            projectId: owner.value.projectId,
            execution,
            title: input.title,
            modelSelection: input.modelSelection,
            event,
          });
          if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
            if (input.delegatingTurnId && event.itemId && event.payload.delta)
              streamedItems.add(event.itemId);
            yield* append(event.payload.delta, event.createdAt);
          }
          if (
            input.delegatingTurnId &&
            event.type === "item.started" &&
            isToolLifecycleItemType(event.payload.itemType)
          ) {
            reportStart = output.length;
          }
          if (
            event.type === "item.completed" &&
            event.payload.itemType === "assistant_message" &&
            (input.delegatingTurnId && event.itemId
              ? !streamedItems.has(event.itemId)
              : output.length === reportStart) &&
            (!input.delegatingTurnId ||
              event.payload.status === undefined ||
              event.payload.status === "completed") &&
            event.payload.detail !== undefined
          ) {
            if (input.delegatingTurnId && event.itemId) streamedItems.add(event.itemId);
            yield* append(event.payload.detail, event.createdAt);
          }
          // Reuse the request/activity translation used by ordinary chat, with a unique request key.
          const requestId = event.requestId;
          if (requestId !== undefined) {
            if (event.type === "request.opened" && event.payload.requestType !== "tool_user_input")
              pendingRequests.set(requestId, "approval.resolved");
            if (event.type === "user-input.requested")
              pendingRequests.set(requestId, "user-input.resolved");
            if (event.type === "request.resolved" || event.type === "user-input.resolved")
              pendingRequests.delete(requestId);
          }
          yield* projectWorkspaceAgentActivities({ engine, execution, messageId, event });
          if (event.type === "request.opened" || event.type === "user-input.requested")
            yield* recordStatus("awaiting-user");
          if (event.type === "request.resolved" || event.type === "user-input.resolved")
            yield* recordStatus("running");
          if (event.type === "turn.started") completedAwaitingInput = undefined;
          if (
            event.type === "user-input.resolved" &&
            pendingRequests.size === 0 &&
            completedAwaitingInput
          ) {
            if (event.payload.reason) {
              terminal = true;
              yield* Deferred.fail(
                finished,
                new WorkspaceAgentExecutionError({
                  message: "사용자 답변 전에 질문이 닫혔습니다.",
                  interrupted: true,
                }),
              );
            } else if (event.turnId === completedAwaitingInput.turnId) {
              terminal = true;
              yield* complete();
            }
          }
          if (event.type === "turn.completed") {
            if (event.payload.state === "completed" && pendingRequests.size > 0) {
              completedAwaitingInput = event;
              yield* recordStatus("awaiting-user");
              return;
            }
            terminal = true;
            if (event.payload.state === "completed") yield* complete();
            else
              yield* Deferred.fail(
                finished,
                new WorkspaceAgentExecutionError({
                  message:
                    event.payload.errorMessage ??
                    `AI 실행이 ${event.payload.state} 상태로 종료되었습니다.`,
                  interrupted: event.payload.state === "interrupted",
                }),
              );
          }
          if (
            event.type === "turn.aborted" ||
            event.type === "session.exited" ||
            event.type === "runtime.error"
          ) {
            terminal = true;
            yield* Deferred.fail(
              finished,
              new WorkspaceAgentExecutionError({
                message:
                  event.type === "runtime.error"
                    ? event.payload.message
                    : event.type === "session.exited" && event.payload.reason
                      ? event.payload.reason
                      : "AI 실행이 결과를 전달하기 전에 종료되었습니다.",
                interrupted: event.type !== "runtime.error",
              }),
            );
          }
        });
        const routeEvent = (event: ProviderRuntimeEvent) => {
          if (!input.delegatingTurnId) return consume(event);
          const source = event.execution;
          if (
            source?.executionId !== execution.executionId ||
            source.attempt !== execution.attempt ||
            source.ownerThreadId !== execution.ownerThreadId ||
            source.runId !== execution.runId ||
            source.nodeId !== execution.nodeId ||
            event.threadId !== execution.ownerThreadId ||
            event.providerInstanceId !== input.modelSelection.instanceId
          )
            return Effect.void;
          return receiptLock.withPermit(
            Effect.suspend(() => {
              // Failures and approval requests must remain actionable even when submit is blocked.
              const immediate =
                event.type === "session.exited" ||
                event.type === "runtime.error" ||
                event.type === "turn.aborted" ||
                (event.type === "turn.completed" && event.payload.state !== "completed");
              if (immediate) return consume(event);
              if (!submitted) return Effect.void;
              const request =
                event.type === "request.opened" ||
                event.type === "request.resolved" ||
                event.type === "user-input.requested" ||
                event.type === "user-input.resolved";
              if (!workerTurnId && !request) {
                earlyEvents.push(event);
                return Effect.void;
              }
              return consume(event);
            }),
          );
        };
        yield* forkParked(
          Stream.runForEach(provider.streamEvents, (event) =>
            routeEvent(event).pipe(
              Effect.catchCause((cause) =>
                Deferred.fail(
                  finished,
                  new WorkspaceAgentExecutionError({ message: Cause.pretty(cause) }),
                ),
              ),
            ),
          ).pipe(
            Effect.onExit(() =>
              terminal
                ? Effect.void
                : Deferred.fail(
                    finished,
                    new WorkspaceAgentExecutionError({
                      message:
                        "AI 실행 이벤트 연결이 종료되어 결과를 기다릴 수 없습니다. 남은 작업을 복구합니다.",
                      interrupted: true,
                    }),
                  ),
            ),
            Effect.catchCause(() => Effect.void),
          ),
          { startImmediately: true },
        );
        yield* forkParked(
          Effect.forever(
            Effect.sleep("50 millis").pipe(
              Effect.andThen(() => (!terminal && pendingText.length > 0 ? flush() : Effect.void)),
            ),
          ).pipe(
            Effect.catchCause((cause) =>
              Deferred.fail(
                finished,
                new WorkspaceAgentExecutionError({ message: Cause.pretty(cause) }),
              ),
            ),
          ),
        );
        yield* forkParked(
          Stream.runForEach(engine.streamDomainEvents, (event) => {
            const cancelled =
              (event.type === "project.collaboration-run-control-requested" &&
                event.payload.action === "cancel" &&
                event.payload.runId === execution.runId) ||
              (event.type === "project.collaboration-run-cancel-requested" &&
                event.payload.runId === execution.runId) ||
              (event.type === "project.collaboration-run-upserted" &&
                event.payload.run.id === execution.runId &&
                (event.payload.run.status === "cancel-requested" ||
                  event.payload.run.status === "cancelled" ||
                  event.payload.run.graph?.nodes.some(
                    (node) => node.id === execution.nodeId && node.status === "cancelled",
                  )));
            return cancelled
              ? Deferred.fail(
                  finished,
                  new WorkspaceAgentExecutionError({
                    message: "사용자가 실행을 중단했습니다.",
                    interrupted: true,
                  }),
                )
              : Effect.void;
          }),
          { startImmediately: true },
        );
        let prepared:
          | Awaited<Effect.Success<ReturnType<WorkspaceAgentControl["Service"]["prepare"]>>>
          | undefined;
        const run = Effect.gen(function* () {
          const pinnedSkills = input.skills?.length
            ? yield* Effect.gen(function* () {
                if (
                  Option.isNone(skillFs) ||
                  Option.isNone(skillPath) ||
                  Option.isNone(skillConfig) ||
                  !input.skillDriver
                )
                  return yield* new WorkspaceAgentExecutionError({
                    message: "스킬 실행 자원을 확인할 수 없습니다.",
                  });
                const loader = yield* makeWorkflowSkills.pipe(
                  Effect.provideService(FileSystem.FileSystem, skillFs.value),
                  Effect.provideService(Path.Path, skillPath.value),
                  Effect.provideService(ServerConfig, skillConfig.value),
                );
                return yield* loader
                  .materialize(input.skills ?? [], input.skillDriver, {
                    runtimeMode: input.runtimeMode,
                    model: input.modelSelection.model,
                    allowAdditionalWorkers: input.allowAdditionalSkillWorkers === true,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new WorkspaceAgentExecutionError({ message: error.message }),
                    ),
                  );
              })
            : { native: [], plugins: [], instructions: "" };
          const hasSearchModels = Option.isSome(settings)
            ? yield* settings.value.getSettings.pipe(
                Effect.map((value) => value.searchModels.length > 0),
                Effect.orElseSucceed(() => false),
              )
            : false;
          const taskPrompt = withFullAccessExecutionPolicy(
            [
              input.prompt,
              pinnedSkills.instructions,
              hasSearchModels && ORDERED_SEARCH_INSTRUCTIONS,
            ]
              .filter(Boolean)
              .join("\n\n"),
            input.runtimeMode,
            input.interactionMode,
          );
          if (Option.isSome(agentControl) && input.orchestraPhase === "task") {
            prepared = yield* agentControl.value
              .prepare({
                projectId: owner.value.projectId,
                runId: execution.runId,
                nodeId: execution.nodeId,
                executionId: execution.executionId,
                prompt: taskPrompt,
                model: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
              })
              .pipe(
                Effect.mapError(
                  (error) => new WorkspaceAgentExecutionError({ message: error.message }),
                ),
              );
          }
          const prompt = prepared?.prompt ?? taskPrompt;
          const predecessor =
            input.resumeFromSessionKey !== undefined && Option.isSome(directory)
              ? yield* directory.value
                  .getBinding(input.resumeFromSessionKey)
                  .pipe(Effect.orElseSucceed(() => Option.none()))
              : Option.none();
          const resumeCursor = workspaceRetryResumeCursor(
            Option.getOrUndefined(predecessor),
            input,
          );
          const session = yield* provider.startSession(sessionKey, {
            threadId: sessionKey,
            execution,
            providerInstanceId: input.modelSelection.instanceId,
            modelSelection: input.modelSelection,
            cwd: input.cwd,
            runtimeMode: input.runtimeMode,
            ...(pinnedSkills.plugins.length ? { workflowSkillPlugins: pinnedSkills.plugins } : {}),
            ...(resumeCursor === undefined ? {} : { resumeCursor }),
          });
          if (input.onSessionStarted) yield* input.onSessionStarted(session);
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`cache-session:${blockKey}`),
            threadId: execution.ownerThreadId,
            createdAt: input.startedAt,
            activity: {
              id: EventId.make(`cache-session:${blockKey}`),
              kind: "cache.session.prepared",
              tone: "info",
              summary:
                session.continuity === "resumed"
                  ? "이전 AI 작업 세션 이어쓰기"
                  : session.continuity === "resume-fallback"
                    ? "AI 세션 복원 실패: 전체 작업 문맥으로 새 세션 시작"
                    : "새 AI 작업 세션 시작",
              payload: {
                executionId: execution.executionId,
                attempt: execution.attempt,
                continuity: session.continuity ?? "unknown",
                cacheHit: "unconfirmed",
              },
              turnId: null,
              createdAt: input.startedAt,
            },
          });
          const composition = describeInputComposition({
            prompt,
            path: "orchestra",
            parts: [{ kind: "assignment", chars: prompt.length }],
          });
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`input-composition:${blockKey}`),
            threadId: execution.ownerThreadId,
            createdAt: input.startedAt,
            activity: {
              id: EventId.make(`input-composition:${blockKey}`),
              kind: "input.composition.prepared",
              tone: "info",
              summary: `AI 입력 준비: ${composition.promptChars.toLocaleString()}자 · 실제 토큰 미계측`,
              payload: {
                ...composition,
                executionId: execution.executionId,
                attempt: execution.attempt,
                messageId,
              },
              turnId: null,
              createdAt: input.startedAt,
            },
          });
          if (input.onBeforeSubmit) yield* input.onBeforeSubmit;
          const submit = provider
            .sendTurn({
              threadId: sessionKey,
              input: prompt,
              ...(pinnedSkills.native.length ? { workflowSkills: pinnedSkills.native } : {}),
              modelSelection: input.modelSelection,
              interactionMode: input.interactionMode,
            })
            .pipe(
              Effect.mapError(
                (error) => new WorkspaceAgentExecutionError({ message: error.message }),
              ),
            );
          const submission = Effect.suspend(() => {
            submitted = true;
            return submit;
          });
          const receipt = yield* input.submitWithGate
            ? input.submitWithGate(submission)
            : submission;
          if (input.delegatingTurnId && receipt.threadId !== sessionKey)
            return yield* new WorkspaceAgentExecutionError({
              message: "다른 작업 세션의 접수 응답입니다.",
            });
          if (prepared && Option.isSome(agentControl))
            yield* agentControl.value
              .settleInput(prepared, true)
              .pipe(
                Effect.mapError(
                  (error) => new WorkspaceAgentExecutionError({ message: error.message }),
                ),
              );
          if (input.onInputAccepted) yield* input.onInputAccepted(receipt);
          if (input.delegatingTurnId)
            yield* receiptLock.withPermit(
              Effect.gen(function* () {
                workerTurnId = receipt.turnId;
                yield* recordStatus(pendingRequests.size ? "awaiting-user" : "running");
                for (const event of earlyEvents) yield* consume(event);
                earlyEvents.length = 0;
              }),
            );
          return yield* Deferred.await(finished);
        });
        return yield* run.pipe(
          Effect.raceFirst(
            input.delegatingTurnId
              ? Deferred.await(finished).pipe(Effect.andThen(Effect.never))
              : Deferred.await(finished),
          ),
          Effect.tap(() => recordStatus("completed")),
          Effect.onError((cause) =>
            Effect.gen(function* () {
              const error = Cause.squash(cause);
              const isTimeout =
                error instanceof WorkspaceAgentExecutionError && error.timedOut === true;
              const cancelled =
                !isTimeout &&
                (Cause.hasInterruptsOnly(cause) ||
                  (error instanceof WorkspaceAgentExecutionError && error.interrupted === true));
              yield* recordStatus(cancelled ? "cancelled" : "failed");
              const rawReason =
                error instanceof WorkspaceAgentExecutionError
                  ? error.message
                  : Cause.hasInterruptsOnly(cause)
                    ? "사용자가 실행을 중단했습니다."
                    : Cause.pretty(cause);
              const reason = isNonRetryableBillingError(rawReason)
                ? formatBillingErrorMessage(rawReason)
                : rawReason;
              recordUnavailableModelFromError({
                providerInstanceId: input.modelSelection.instanceId,
                model: input.modelSelection.model,
                errorMessage: rawReason,
              });
              yield* append(
                `\n\n${isTimeout ? "실행 시간 초과" : cancelled ? "실행 중단" : "실행 오류"}: ${reason}`,
                yield* now,
              );
            }).pipe(Effect.orDie),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              terminal = true;
              if (prepared && Option.isSome(agentControl))
                yield* agentControl.value.settleInput(prepared, false).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Agent input receipt could not settle", {
                      cause: Cause.pretty(cause),
                    }),
                  ),
                );
              if (pendingText.length > 0) yield* flush();
              let stopConfirmed = false;
              yield* provider.stopSession({ threadId: sessionKey }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    stopConfirmed = true;
                  }),
                ),
                Effect.timeout("10 seconds"),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Orchestra session cleanup failed", {
                    executionId: execution.executionId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
              if (input.onSessionStopped) yield* input.onSessionStopped(stopConfirmed);
              for (const [requestId, kind] of pendingRequests) {
                const createdAt = yield* now;
                yield* engine.dispatch({
                  type: "thread.activity.append",
                  commandId: CommandId.make(`orchestra-request-closed:${blockKey}:${requestId}`),
                  threadId: execution.ownerThreadId,
                  createdAt,
                  activity: {
                    id: EventId.make(`orchestra-request-closed:${blockKey}:${requestId}`),
                    kind,
                    tone: "info",
                    summary: "AI 실행 종료로 요청을 닫았습니다.",
                    turnId: null,
                    createdAt,
                    payload: {
                      requestId: `${execution.executionId}:${requestId}`,
                      executionId: execution.executionId,
                      providerRequestId: requestId,
                      messageId,
                      decision: "cancel",
                      answers: {},
                    },
                  },
                });
              }
              yield* engine.dispatch({
                type: "thread.message.assistant.complete",
                commandId: CommandId.make(`orchestra-complete:${blockKey}`),
                threadId: execution.ownerThreadId,
                messageId,
                createdAt: yield* now,
              });
            }).pipe(Effect.orDie),
          ),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            const partial = (input.delegatingTurnId ? output.slice(reportStart) : output).trim();
            if (error instanceof WorkspaceAgentExecutionError) {
              const isBilling = isNonRetryableBillingError(error.message);
              return Effect.fail(
                new WorkspaceAgentExecutionError({
                  message: isBilling ? formatBillingErrorMessage(error.message) : error.message,
                  ...(error.interrupted !== undefined ? { interrupted: error.interrupted } : {}),
                  ...(error.timedOut !== undefined ? { timedOut: error.timedOut } : {}),
                  ...((error.partialOutput ?? (partial ? partial : undefined))
                    ? { partialOutput: error.partialOutput ?? partial }
                    : {}),
                  ...(isBilling || error.nonRetryable ? { nonRetryable: true } : {}),
                  ...(error.errorCategory
                    ? { errorCategory: error.errorCategory }
                    : isBilling
                      ? { errorCategory: "billing" as const }
                      : {}),
                }),
              );
            }
            const rawMessage = Cause.pretty(cause);
            const isBilling = isNonRetryableBillingError(rawMessage);
            return Effect.fail(
              new WorkspaceAgentExecutionError({
                message: isBilling ? formatBillingErrorMessage(rawMessage) : rawMessage,
                interrupted: Cause.hasInterruptsOnly(cause),
                ...(partial ? { partialOutput: partial } : {}),
                ...(isBilling ? { nonRetryable: true, errorCategory: "billing" as const } : {}),
              }),
            );
          }),
        );
      },
      Effect.scoped,
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        return Effect.fail(
          error instanceof WorkspaceAgentExecutionError
            ? error
            : new WorkspaceAgentExecutionError({
                message: Cause.pretty(cause),
                interrupted: Cause.hasInterruptsOnly(cause),
              }),
        );
      }),
    );

    return { execute };
  }),
);
