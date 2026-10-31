import {
  MessageId,
  EventId,
  RuntimeRequestId,
  type ProviderRuntimeEvent,
  ProjectId,
  ProviderDriverKind,
  WorkspaceOrchestraBlock,
  ProviderExecutionId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, PubSub, Schema, Stream } from "effect";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { withFullAccessExecutionPolicy } from "../../provider/fullAccessExecutionPolicy.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutor,
  type WorkspaceAgentExecutionInput,
} from "../Services/WorkspaceAgentExecutor.ts";
import { WorkspaceAgentControl } from "../WorkspaceAgentControl.ts";
import { WorkspaceAgentExecutorLive } from "./WorkspaceAgentExecutor.ts";

const isOrchestraBlock = Schema.is(WorkspaceOrchestraBlock);
const at = "2026-09-13T06:00:00.000Z";
const owner = ThreadId.make("onchain-owner");
const projectId = ProjectId.make("onchain");
const execution: WorkspaceAgentExecutionInput = {
  orchestraPhase: "task",
  execution: {
    executionId: ProviderExecutionId.make("orchestra:run:node:1"),
    ownerThreadId: owner,
    runId: WorkspaceCollaborationRunId.make("run"),
    nodeId: WorkspaceTaskNodeId.make("node"),
    attempt: 1,
  },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "D:/isolated-test",
  prompt: "wallet verification",
  title: "wallet",
  displayName: "Codex",
  role: "implementer",
  kind: "implementation",
  startedAt: at,
};

for (const previousStatus of ["running", "completed"] as const) {
  it.effect(`recovery preserves a ${previousStatus} attempt and closes only stale streaming`, () =>
    Effect.gen(function* () {
      const commands: OrchestrationCommand[] = [];
      const messageId = MessageId.make("orchestra-message:orchestra:run:node:1:1");
      const layer = WorkspaceAgentExecutorLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderService)({}),
            Layer.mock(ProjectionSnapshotQuery)({
              getThreadRuntimeContext: () =>
                Effect.succeed(
                  Option.some({
                    id: owner,
                    projectId,
                    messages: [
                      {
                        id: messageId,
                        streaming: previousStatus === "running",
                        text: "Preserved output",
                      },
                    ],
                    activities: [
                      {
                        id: "orchestra-block:orchestra:run:node:1:1",
                        payload: {
                          ...execution.execution,
                          messageId,
                          title: execution.title,
                          displayName: execution.displayName,
                          role: execution.role,
                          kind: execution.kind,
                          modelSelection: execution.modelSelection,
                          status: previousStatus,
                        },
                      },
                    ],
                  } as unknown as OrchestrationThread),
                ),
            }),
            Layer.mock(OrchestrationEngineService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: commands.length };
                }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const executor = yield* WorkspaceAgentExecutor;
        const result = yield* executor.execute(execution).pipe(Effect.result);
        if (previousStatus === "completed") {
          expect(result).toMatchObject({ _tag: "Success", success: "Preserved output" });
          expect(commands).toEqual([]);
        } else {
          expect(result).toMatchObject({ _tag: "Failure", failure: { interrupted: true } });
          if (result._tag === "Failure")
            expect(result.failure.message).toContain("Preserved output");
          expect(commands[0]).toMatchObject({
            type: "thread.activity.append",
            threadId: owner,
            activity: { payload: { status: "cancelled", messageId } },
          });
          expect(commands.at(-1)).toMatchObject({
            type: "thread.message.assistant.complete",
            messageId,
          });
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
}
for (const [phase, trigger] of [
  ["start", "cancel"],
  ["send", "cancel"],
  ["send", "session-exit"],
  ["send", "stream-end"],
  ["send", "stream-error"],
] as const) {
  it.effect(`${trigger} settles and cleans up while provider ${phase} is still blocked`, () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const disconnected = yield* Deferred.make<void>();
      const commands: OrchestrationCommand[] = [];
      const stopped: ThreadId[] = [];
      const block = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      );
      const layer = WorkspaceAgentExecutorLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderService)({
              startSession: (threadId) =>
                phase === "start"
                  ? block
                  : Effect.succeed({
                      threadId,
                      provider: ProviderDriverKind.make("codex"),
                      status: "ready",
                      runtimeMode: "full-access",
                      createdAt: at,
                      updatedAt: at,
                    }),
              sendTurn: () => block,
              stopSession: ({ threadId }) =>
                Effect.sync(() => {
                  stopped.push(threadId);
                }),
              streamEvents:
                trigger === "stream-end" || trigger === "stream-error"
                  ? Stream.fromEffect(Deferred.await(disconnected)).pipe(
                      Stream.flatMap(() =>
                        trigger === "stream-error"
                          ? Stream.die("event connection lost")
                          : Stream.empty,
                      ),
                    )
                  : Stream.fromPubSub(runtimeEvents),
            }),
            Layer.mock(ProjectionSnapshotQuery)({
              getThreadRuntimeContext: () =>
                Effect.succeed(
                  Option.some({
                    id: owner,
                    projectId,
                    messages: [],
                    activities: [],
                  } as unknown as OrchestrationThread),
                ),
            }),
            Layer.mock(OrchestrationEngineService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: commands.length };
                }),
              streamDomainEvents: Stream.fromPubSub(events),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const executor = yield* WorkspaceAgentExecutor;
        const fiber = yield* executor.execute(execution).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        if (trigger === "session-exit") {
          yield* PubSub.publish(runtimeEvents, {
            type: "session.exited",
            eventId: EventId.make("external-session-exit"),
            provider: ProviderDriverKind.make("codex"),
            threadId: owner,
            execution: execution.execution,
            createdAt: at,
            payload: { exitKind: "graceful" },
          });
        } else if (trigger === "stream-end" || trigger === "stream-error") {
          yield* Deferred.succeed(disconnected, undefined);
        } else {
          yield* PubSub.publish(events, {
            type: "project.collaboration-run-cancel-requested",
            payload: { projectId, runId: execution.execution.runId, cancelledAt: at },
          } as OrchestrationEvent);
        }
        const result = yield* Fiber.join(fiber);
        expect(result).toMatchObject({ _tag: "Failure", failure: { interrupted: true } });
        yield* Deferred.await(interrupted);
        expect(stopped).toEqual([execution.execution.executionId]);
        expect(
          commands.some(
            (command) =>
              command.type === "thread.activity.append" &&
              command.activity.kind === "orchestra.block" &&
              isOrchestraBlock(command.activity.payload) &&
              command.activity.payload.status === "cancelled",
          ),
        ).toBe(true);
        expect(commands.at(-1)).toMatchObject({
          type: "thread.message.assistant.complete",
          threadId: owner,
          messageId: MessageId.make("orchestra-message:orchestra:run:node:1:1"),
        });
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
}

for (const questionOrder of [undefined, "answer-first", "completion-first"] as const) {
  it.effect(
    questionOrder
      ? `waits for an async question answer (${questionOrder}) before completing the step`
      : "submits the preserved assignment and records acceptance before reporting completion",
    () =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
        const accepted = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        let awaitingCount = 0;
        const received: string[] = [];
        const settled: boolean[] = [];
        const layer = WorkspaceAgentExecutorLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(WorkspaceAgentControl)({
                prepare: (input) =>
                  Effect.succeed({
                    prompt: input.prompt + "\n보존된 메시지",
                    recordIds: ["input"],
                    executionId: input.executionId,
                    lookup: { projectId, runId: input.runId },
                  }),
                settleInput: (_input, success) =>
                  Effect.sync(() => {
                    settled.push(success);
                  }),
              }),
              Layer.mock(ProjectionSnapshotQuery)({
                getThreadRuntimeContext: () =>
                  Effect.succeed(
                    Option.some({
                      id: owner,
                      projectId,
                      messages: [],
                      activities: [],
                    } as unknown as OrchestrationThread),
                  ),
              }),
              Layer.mock(OrchestrationEngineService)({
                dispatch: (command) =>
                  Effect.gen(function* () {
                    if (
                      command.type === "thread.activity.append" &&
                      (command.activity.payload as { status?: string })?.status ===
                        "awaiting-user" &&
                      ++awaitingCount === 2
                    ) {
                      yield* Deferred.succeed(waiting, undefined);
                    }
                    return { sequence: 1 };
                  }),
                streamDomainEvents: Stream.never,
              }),
              Layer.mock(ProviderService)({
                startSession: (threadId) =>
                  Effect.succeed({
                    threadId,
                    provider: ProviderDriverKind.make("codex"),
                    status: "ready",
                    runtimeMode: "full-access",
                    createdAt: at,
                    updatedAt: at,
                  }),
                sendTurn: (input) =>
                  Effect.sync(() => {
                    received.push(input.input ?? "");
                    return { threadId: input.threadId, turnId: TurnId.make("accepted") };
                  }),
                stopSession: () => Effect.void,
                streamEvents: Stream.fromPubSub(events),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const executor = yield* WorkspaceAgentExecutor;
          const fiber = yield* executor
            .execute({
              ...execution,
              onInputAccepted: () => Deferred.succeed(accepted, undefined).pipe(Effect.asVoid),
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(accepted);
          expect(received).toEqual([
            withFullAccessExecutionPolicy(execution.prompt, execution.runtimeMode) +
              "\n보존된 메시지",
          ]);
          expect(settled).toEqual([true]);
          const requestId = RuntimeRequestId.make("async:native-question");
          const base = {
            provider: ProviderDriverKind.make("codex"),
            threadId: ThreadId.make(execution.execution.executionId),
            execution: execution.execution,
            createdAt: at,
          };
          if (questionOrder) {
            yield* PubSub.publish(events, {
              ...base,
              type: "user-input.requested",
              eventId: EventId.make("question"),
              requestId,
              turnId: TurnId.make("question-turn"),
              payload: {
                questions: [
                  {
                    id: "question_1",
                    header: "Question",
                    question: "Which project?",
                    options: [],
                  },
                ],
              },
            });
            yield* PubSub.publish(events, {
              ...base,
              type: "turn.completed",
              eventId: EventId.make("question-turn-done"),
              turnId: TurnId.make("question-turn"),
              payload: { state: "completed" },
            });
            yield* Deferred.await(waiting);
            expect(fiber.pollUnsafe()).toBeUndefined();
            yield* PubSub.publish(events, {
              ...base,
              type: "turn.started",
              eventId: EventId.make("answer-turn-started"),
              turnId: TurnId.make("answer-turn"),
              payload: {},
            });
            if (questionOrder === "completion-first") {
              yield* PubSub.publish(events, {
                ...base,
                type: "turn.completed",
                eventId: EventId.make("answer-completed-before-resolution"),
                turnId: TurnId.make("answer-turn"),
                payload: { state: "completed" },
              });
            }
            yield* PubSub.publish(events, {
              ...base,
              type: "user-input.resolved",
              eventId: EventId.make("answered"),
              requestId,
              turnId: TurnId.make("answer-turn"),
              payload: { answers: { question_1: ["Project A"] } },
            });
          }
          yield* PubSub.publish(events, {
            type: "turn.completed",
            eventId: EventId.make("done"),
            provider: ProviderDriverKind.make("codex"),
            threadId: ThreadId.make(execution.execution.executionId),
            execution: execution.execution,
            createdAt: at,
            ...(questionOrder ? { turnId: TurnId.make("answer-turn") } : {}),
            payload: { state: "completed" },
          });
          yield* Fiber.join(fiber);
          expect(settled).toEqual([true, false]);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
  );
}
