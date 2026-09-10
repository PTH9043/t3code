import {
  CommandId,
  EventId,
  MessageId,
  RuntimeRequestId,
  ThreadId,
  WorkspaceKnowledgeItemId,
  WorkspaceOrchestraBlock,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutor,
  WorkspaceAgentExecutionError,
  type WorkspaceAgentExecutionInput,
} from "../Services/WorkspaceAgentExecutor.ts";
import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";
import {
  knowledgeContentDigest,
  redactConversationRagSensitiveData,
} from "../workspaceConversationRag.ts";
const isOrchestraBlock = Schema.is(WorkspaceOrchestraBlock);
const encodeResearchData = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const WorkspaceAgentExecutorLive = Layer.effect(
  WorkspaceAgentExecutor,
  Effect.gen(function* () {
    const provider = yield* ProviderService;
    const engine = yield* OrchestrationEngineService;
    const queries = yield* ProjectionSnapshotQuery;
    const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const execute = Effect.fn("WorkspaceAgentExecutor.execute")(
      function* (input: WorkspaceAgentExecutionInput) {
        const { execution } = input;
        // Provider adapters historically call their opaque session key threadId. No conversation is
        // created for this key: only the owning thread receives messages and activities.
        const sessionKey = ThreadId.make(execution.executionId);
        const blockKey = `${execution.executionId}:${execution.attempt}`;
        const messageId = MessageId.make(`orchestra-message:${blockKey}`);
        const owner = yield* queries.getThreadDetailById(execution.ownerThreadId);
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
          )
            return previous.text;
          return yield* new WorkspaceAgentExecutionError({
            message: "서버가 중단된 실행입니다. 새 시도로 복구합니다.",
            interrupted: true,
          });
        }
        const finished = yield* Deferred.make<string, WorkspaceAgentExecutionError>();
        let output = "";
        let pendingText = "";
        let pendingAt = input.startedAt;
        let deltaIndex = 0;
        let statusIndex = 0;
        let terminal = false;
        const seenEvents = new Set<string>();
        const pendingRequests = new Map<string, "approval.resolved" | "user-input.resolved">();
        const block: WorkspaceOrchestraBlock = {
          ...execution,
          messageId,
          title: input.title,
          displayName: input.displayName,
          ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
          role: input.role,
          kind: input.kind,
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
              payload: { ...block, status },
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
          });
        yield* recordStatus("running");
        yield* flush();

        const consume = Effect.fn("WorkspaceAgentExecutor.consume")(function* (
          event: ProviderRuntimeEvent,
        ) {
          if (
            terminal ||
            event.execution?.executionId !== execution.executionId ||
            event.execution.attempt !== execution.attempt
          )
            return;
          if (seenEvents.has(event.eventId)) return;
          seenEvents.add(event.eventId);
          if (event.type === "item.completed" && event.payload.itemType === "web_search") {
            const dataText =
              event.payload.data === undefined
                ? undefined
                : yield* encodeResearchData(event.payload.data);
            const detail = redactConversationRagSensitiveData(
              [event.payload.title, event.payload.detail, dataText].filter(Boolean).join("\n"),
            ).content.slice(0, 80_000);
            if (detail.length > 0)
              yield* engine
                .dispatch({
                  type: "project.knowledge.item.upsert",
                  commandId: CommandId.make(`orchestra-research:${blockKey}:${event.eventId}`),
                  projectId: owner.value.projectId,
                  itemId: WorkspaceKnowledgeItemId.make(
                    `research-${knowledgeContentDigest(`${blockKey}:${event.eventId}`, 32)}`,
                  ),
                  kind: "long-term-memory",
                  title: `${input.title}: ${event.payload.title ?? "검색 기록"}`.slice(0, 200),
                  content: detail,
                  status: "active",
                  origin: "agent",
                  scope: "project",
                  appliesToFolder: null,
                  relativeFolder: "research",
                  tags: ["research", "unverified", "orchestra"],
                  research: {
                    query: redactConversationRagSensitiveData(event.payload.title ?? input.title)
                      .content,
                    sources: [
                      ...new Set(
                        (detail.match(/https?:\/\/[^\s<>"\\]+/g) ?? []).map((url) =>
                          url.replace(/[),.;\]}]+$/g, ""),
                        ),
                      ),
                    ].slice(0, 40),
                    capturedAt: event.createdAt,
                    verification: "unverified",
                  },
                  createdAt: event.createdAt,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Orchestra research capture failed", {
                      executionId: execution.executionId,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                );
          }
          if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
            yield* append(event.payload.delta, event.createdAt);
          }
          if (
            event.type === "item.completed" &&
            event.payload.itemType === "assistant_message" &&
            output.length === 0 &&
            event.payload.detail !== undefined
          ) {
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
          const scopedEvent =
            requestId === undefined
              ? event
              : {
                  ...event,
                  requestId: RuntimeRequestId.make(`${execution.executionId}:${requestId}`),
                };
          for (const activity of runtimeEventToActivities(scopedEvent)) {
            const payload =
              activity.payload !== null && typeof activity.payload === "object"
                ? activity.payload
                : {};
            yield* engine.dispatch({
              type: "thread.activity.append",
              threadId: execution.ownerThreadId,
              commandId: CommandId.make(`orchestra-activity:${blockKey}:${activity.id}`),
              createdAt: event.createdAt,
              activity: {
                ...activity,
                id: EventId.make(`orchestra:${blockKey}:${activity.id}`),
                turnId: null,
                payload: {
                  ...payload,
                  executionId: execution.executionId,
                  providerRequestId: requestId,
                  messageId,
                },
              },
            });
          }
          if (event.type === "request.opened" || event.type === "user-input.requested")
            yield* recordStatus("awaiting-user");
          if (event.type === "request.resolved" || event.type === "user-input.resolved")
            yield* recordStatus("running");
          if (event.type === "turn.completed") {
            terminal = true;
            if (event.payload.state === "completed") yield* Deferred.succeed(finished, output);
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
                    : "AI 실행이 결과를 전달하기 전에 종료되었습니다.",
              }),
            );
          }
        });
        yield* forkParked(
          Stream.runForEach(provider.streamEvents, (event) =>
            consume(event).pipe(
              Effect.catchCause((cause) =>
                Deferred.fail(
                  finished,
                  new WorkspaceAgentExecutionError({ message: Cause.pretty(cause) }),
                ),
              ),
            ),
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
        const run = Effect.gen(function* () {
          yield* provider.startSession(sessionKey, {
            threadId: sessionKey,
            execution,
            providerInstanceId: input.modelSelection.instanceId,
            modelSelection: input.modelSelection,
            cwd: input.cwd,
            runtimeMode: input.runtimeMode,
          });
          yield* provider.sendTurn({
            threadId: sessionKey,
            input: input.prompt,
            modelSelection: input.modelSelection,
            interactionMode: input.interactionMode,
          });
          return yield* Deferred.await(finished);
        });
        return yield* run.pipe(
          Effect.tap(() => recordStatus("completed")),
          Effect.onError((cause) =>
            Effect.gen(function* () {
              const error = Cause.squash(cause);
              const cancelled =
                Cause.hasInterruptsOnly(cause) ||
                (error instanceof WorkspaceAgentExecutionError && error.interrupted === true);
              yield* recordStatus(cancelled ? "cancelled" : "failed");
              yield* append(
                `\n\n${cancelled ? "실행 중단" : "실행 오류"}: ${error instanceof WorkspaceAgentExecutionError ? error.message : Cause.pretty(cause)}`,
                yield* now,
              );
            }).pipe(Effect.orDie),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              terminal = true;
              if (pendingText.length > 0) yield* flush();
              yield* provider.stopSession({ threadId: sessionKey }).pipe(
                Effect.timeout("10 seconds"),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Orchestra session cleanup failed", {
                    executionId: execution.executionId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
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
