import {
  MessageId,
  EventId,
  RuntimeRequestId,
  RuntimeItemId,
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
import { ProviderValidationError } from "../../provider/Errors.ts";
import { withFullAccessExecutionPolicy } from "../../provider/fullAccessExecutionPolicy.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutor,
  WorkspaceAgentExecutionError,
  type WorkspaceAgentExecutionInput,
} from "../Services/WorkspaceAgentExecutor.ts";
import { WorkspaceAgentControl } from "../WorkspaceAgentControl.ts";
import { WorkspaceAgentExecutorLive } from "./WorkspaceAgentExecutor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ORDERED_SEARCH_INSTRUCTIONS } from "../../research/orderedSearchInstructions.ts";

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

for (const outcome of [
  "research",
  "snapshot",
  "no-report",
  "wrong-session",
  "send-failed",
  "receipt-rejected",
] as const) {
  it.effect(`ordinary-chat delegate verifies the submission and worker report (${outcome})`, () =>
    Effect.gen(function* () {
      const submitted = yield* Deferred.make<void>();
      const eventsProcessed = yield* Deferred.make<void>();
      const commands: OrchestrationCommand[] = [];
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencode-fixture"),
        model: "research-fixture",
      };
      const worker = ThreadId.make(execution.execution.executionId);
      const turnId = TurnId.make("native-worker-turn");
      const delegatingTurnId = TurnId.make("native-supervisor-turn");
      const report = "The two fixture records agree.";
      const input: WorkspaceAgentExecutionInput = {
        ...execution,
        delegatingTurnId,
        modelSelection,
        runtimeMode: "approval-required",
        role: "researcher",
        kind: "research",
        instruction: "Compare two fixture records.",
        prompt: "Compare two fixture records.",
        cwd: "C:/fixture",
      };
      const base = {
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: modelSelection.instanceId,
        execution: input.execution,
        threadId: owner,
        turnId,
        createdAt: at,
      };
      const delta = (
        id: string,
        text: string,
      ): Extract<ProviderRuntimeEvent, { type: "content.delta" }> => ({
        ...base,
        eventId: EventId.make(id),
        itemId: RuntimeItemId.make(id),
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: text },
      });
      const events: ProviderRuntimeEvent[] = [
        delta("progress", "Checking the records."),
        {
          ...base,
          type: "item.started",
          eventId: EventId.make("tool"),
          payload: { itemType: "web_search", title: "Search fixture" },
        },
        {
          ...base,
          type: "item.completed",
          eventId: EventId.make("tool-done"),
          payload: { itemType: "web_search", title: "Search fixture", status: "completed" },
        },
        {
          ...delta("other-account", "foreign account"),
          providerInstanceId: ProviderInstanceId.make("other"),
        },
        { ...delta("other-run", "foreign attempt"), execution: { ...base.execution, attempt: 2 } },
        {
          ...delta("other-node", "foreign node"),
          execution: { ...base.execution, nodeId: WorkspaceTaskNodeId.make("other") },
        },
        { ...delta("other-owner", "foreign thread"), threadId: ThreadId.make("other-owner") },
        { ...delta("other-turn", "foreign turn"), turnId: delegatingTurnId },
        {
          ...delta("tool-output", ""),
          payload: { streamKind: "command_output", delta: "Tool result alone." },
        },
      ];
      if (outcome !== "no-report") {
        if (outcome !== "snapshot") events.push(delta("final", report));
        events.push({
          ...base,
          type: "item.completed",
          eventId: EventId.make("final-snapshot"),
          itemId: RuntimeItemId.make("final"),
          payload: { itemType: "assistant_message", status: "completed", detail: report },
        });
      }
      events.push({
        ...base,
        type: "turn.completed",
        eventId: EventId.make("done"),
        payload: { state: "completed" },
      });
      let snapshot = {
        id: owner,
        projectId,
        messages: [],
        activities: [],
      } as unknown as OrchestrationThread;
      const layer = WorkspaceAgentExecutorLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionSnapshotQuery)({
              getThreadRuntimeContext: () => Effect.succeed(Option.some(snapshot)),
            }),
            Layer.mock(OrchestrationEngineService)({
              streamDomainEvents: Stream.never,
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: commands.length };
                }),
            }),
            Layer.mock(ProviderService)({
              startSession: (threadId, options) =>
                Effect.sync(() => {
                  expect(threadId).toBe(worker);
                  expect(options).toMatchObject({
                    execution: base.execution,
                    modelSelection,
                    runtimeMode: "approval-required",
                    cwd: input.cwd,
                  });
                  return {
                    threadId,
                    provider: base.provider,
                    status: "ready" as const,
                    runtimeMode: input.runtimeMode,
                    createdAt: at,
                    updatedAt: at,
                  };
                }),
              sendTurn: (request) =>
                Effect.gen(function* () {
                  expect(request).toMatchObject({
                    threadId: worker,
                    modelSelection,
                    interactionMode: input.interactionMode,
                  });
                  expect(request.input).toContain(input.prompt);
                  yield* Deferred.succeed(submitted, undefined);
                  yield* Deferred.await(eventsProcessed);
                  if (outcome === "send-failed")
                    return yield* new ProviderValidationError({
                      operation: "sendTurn",
                      issue: "Fixture send failed.",
                    });
                  return { threadId: outcome === "wrong-session" ? owner : worker, turnId };
                }),
              streamEvents: Stream.fromEffect(Deferred.await(submitted)).pipe(
                Stream.flatMap(() => Stream.fromIterable(events)),
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(eventsProcessed, undefined)).pipe(
                    Stream.drain,
                  ),
                ),
                Stream.concat(Stream.never),
              ),
              stopSession: () => Effect.void,
            }),
          ),
        ),
      );
      const result = yield* WorkspaceAgentExecutor.use((executor) =>
        executor.execute({
          ...input,
          onInputAccepted: () =>
            outcome === "receipt-rejected"
              ? Effect.fail(
                  new WorkspaceAgentExecutionError({ message: "Fixture receipt rejected." }),
                )
              : Effect.void,
        }),
      ).pipe(Effect.result, Effect.provide(layer), Effect.scoped);
      const success = outcome === "research" || outcome === "snapshot";
      if (success) expect(result).toMatchObject({ _tag: "Success", success: report });
      else expect(result._tag).toBe("Failure");
      const blocks = commands.flatMap((command) =>
        command.type === "thread.activity.append" && command.activity.kind === "orchestra.block"
          ? [command.activity.payload]
          : [],
      );
      expect(blocks.at(-1)).toMatchObject({
        supervisorTurnId: delegatingTurnId,
        instruction: input.instruction,
        modelSelection,
        status: success ? "completed" : "failed",
        ...(success ? { workerTurnId: turnId } : {}),
      });
      if (!success)
        expect(blocks).not.toContainEqual(expect.objectContaining({ status: "completed" }));
      const transcript = commands
        .flatMap((command) =>
          command.type === "thread.message.assistant.delta" ? [command.delta] : [],
        )
        .join("");
      expect(transcript).not.toContain("foreign");
      if (outcome === "research") {
        expect(blocks).toContainEqual(
          expect.objectContaining({
            status: "running",
            supervisorTurnId: delegatingTurnId,
            workerTurnId: turnId,
          }),
        );
        const key = `${input.execution.executionId}:${input.execution.attempt}`;
        snapshot = {
          ...snapshot,
          messages: [
            {
              id: MessageId.make(`orchestra-message:${key}`),
              text: transcript,
              role: "assistant",
              turnId: null,
              streaming: false,
              createdAt: at,
              updatedAt: at,
            },
          ],
          activities: [
            {
              id: EventId.make(`orchestra-block:${key}`),
              payload: blocks.at(-1),
              kind: "orchestra.block",
              tone: "info",
              summary: input.title,
              turnId: null,
              createdAt: at,
            },
          ],
        };
        const replay = (assignment: WorkspaceAgentExecutionInput) =>
          WorkspaceAgentExecutor.use((executor) => executor.execute(assignment)).pipe(
            Effect.result,
            Effect.provide(layer),
            Effect.scoped,
          );
        expect(yield* replay(input)).toMatchObject({ _tag: "Success", success: report });
        expect((yield* replay({ ...input, instruction: "A different assignment." }))._tag).toBe(
          "Failure",
        );
      }
    }),
  );
}

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
              ServerSettingsService.layerTest({
                searchModels: [{ provider: "openai", model: "fixture" }],
              }),
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
            withFullAccessExecutionPolicy(
              `${execution.prompt}\n\n${ORDERED_SEARCH_INSTRUCTIONS}`,
              execution.runtimeMode,
            ) + "\n보존된 메시지",
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
