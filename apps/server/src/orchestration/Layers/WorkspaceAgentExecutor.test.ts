import { expect, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationEvent,
  OrchestrationThread,
  ProjectId,
  ProviderExecutionId,
  ProviderInstanceId,
  ProviderDriverKind,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  type OrchestrationCommand,
  type ProviderExecutionContext,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutor,
  type WorkspaceAgentExecutionInput,
} from "../Services/WorkspaceAgentExecutor.ts";
import { WorkspaceAgentExecutorLive } from "./WorkspaceAgentExecutor.ts";

const at = "2026-09-11T00:00:00.000Z";
const decodeEvent = (input: unknown) => decodeEventEffect(input).pipe(Effect.orDie);
const decodeEventEffect = Schema.decodeUnknownEffect(OrchestrationEvent);
const encodeCapture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ownerId = ThreadId.make("one-conversation");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const owner = Schema.decodeUnknownSync(OrchestrationThread)({
  id: ownerId,
  projectId: ProjectId.make("project"),
  title: "Orchestra",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  activities: [],
  checkpoints: [],
  session: null,
});
function input(nodeId: string, attempt = 1): WorkspaceAgentExecutionInput {
  return {
    execution: {
      executionId: ProviderExecutionId.make(`execution:${nodeId}:${attempt}`),
      ownerThreadId: ownerId,
      runId: WorkspaceCollaborationRunId.make("run"),
      nodeId: WorkspaceTaskNodeId.make(nodeId),
      attempt,
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: "D:/isolated",
    prompt: `Work ${nodeId}`,
    title: nodeId,
    displayName: "Worker",
    role: "researcher",
    kind: "research",
    startedAt: at,
  };
}

const harness = (mode: "parallel" | "failure" | "retry" | "research" | "cancel") =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const bothStarted = yield* Deferred.make<void>();
    const started = new Map<ThreadId, ProviderExecutionContext>();
    const stopped: ThreadId[] = [];
    const commands: OrchestrationCommand[] = [];
    let sequence = 0;
    const eventBase = (execution: ProviderExecutionContext, suffix: string) => ({
      execution,
      threadId: ownerId,
      provider: ProviderDriverKind.make("codex"),
      eventId: EventId.make(`${execution.executionId}:${suffix}`),
      createdAt: at,
    });
    const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event);
    const layer = WorkspaceAgentExecutorLive.pipe(
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () => Effect.succeed(Option.some(owner)),
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: ++sequence };
            }),
          streamDomainEvents: Stream.fromPubSub(domainEvents),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderService)({
          streamEvents: Stream.fromPubSub(events),
          startSession: (threadId, request) =>
            Effect.gen(function* () {
              expect(request.execution).toBeDefined();
              expect(threadId).not.toBe(ownerId);
              started.set(threadId, request.execution!);
              if (started.size === 2) yield* Deferred.succeed(bothStarted, undefined);
              return {
                threadId,
                provider: ProviderDriverKind.make("codex"),
                status: "running" as const,
                runtimeMode: request.runtimeMode,
                createdAt: at,
                updatedAt: at,
              };
            }),
          sendTurn: ({ threadId }) =>
            Effect.gen(function* () {
              const execution = started.get(threadId)!;
              if (mode === "research")
                yield* emit({
                  ...eventBase(execution, "search"),
                  type: "item.completed",
                  payload: {
                    itemType: "web_search",
                    title: "Routing documentation sk-test123456789012345678901234567890",
                    detail:
                      "Verified locally against https://example.com/routing. api_key=sk-test123456789012345678901234567890",
                  },
                });
              if (mode === "parallel") yield* Deferred.await(bothStarted);
              if (mode === "retry" && execution.attempt === 2) {
                const old = input(execution.nodeId, 1).execution;
                yield* emit({
                  ...eventBase(old, "late"),
                  type: "content.delta",
                  payload: { streamKind: "assistant_text", delta: "STALE OUTPUT" },
                });
              }
              const delta: ProviderRuntimeEvent = {
                ...eventBase(execution, "delta"),
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta: `Result ${execution.nodeId}` },
              };
              yield* emit(delta);
              yield* emit(delta);
              yield* emit({
                ...eventBase(execution, "request"),
                type: "request.opened",
                requestId: RuntimeRequestId.make("same-request"),
                payload: { requestType: "command_execution_approval", detail: "Check files" },
              });
              if (mode === "cancel") {
                yield* PubSub.publish(
                  domainEvents,
                  yield* decodeEvent({
                    sequence: 100,
                    type: "project.collaboration-run-cancel-requested",
                    eventId: "cancel-event",
                    aggregateKind: "project",
                    aggregateId: "project",
                    occurredAt: at,
                    commandId: "cancel-command",
                    causationEventId: null,
                    correlationId: null,
                    metadata: {},
                    payload: { projectId: "project", runId: "run", cancelledAt: at },
                  }),
                );
                return { threadId, turnId: TurnId.make(`turn:${execution.executionId}`) };
              }
              yield* emit({
                ...eventBase(execution, "complete"),
                type: "turn.completed",
                payload:
                  mode === "failure"
                    ? { state: "failed", errorMessage: "Provider failed" }
                    : { state: "completed" },
              });
              return { threadId, turnId: TurnId.make(`turn:${execution.executionId}`) };
            }),
          stopSession: ({ threadId }) =>
            Effect.sync(() => {
              stopped.push(threadId);
            }),
        }),
      ),
    );
    return { layer, commands, started, stopped };
  });

it.live(
  "streams concurrent workers into distinct blocks in one conversation and routes approvals",
  () =>
    Effect.gen(function* () {
      const state = yield* harness("parallel");
      yield* Effect.gen(function* () {
        const executor = yield* WorkspaceAgentExecutor;
        const outputs = yield* Effect.all(
          [executor.execute(input("a")), executor.execute(input("b"))],
          { concurrency: "unbounded" },
        );
        expect(outputs).toEqual(["Result a", "Result b"]);
        expect(
          state.commands.every((command) => "threadId" in command && command.threadId === ownerId),
        ).toBe(true);
        expect(
          state.commands.some(
            (command) => command.type === "thread.create" || command.type === "thread.turn.start",
          ),
        ).toBe(false);
        const complete = state.commands.filter(
          (command) => command.type === "thread.message.assistant.complete",
        );
        expect(complete).toHaveLength(2);
        expect(new Set(complete.map((command) => command.messageId)).size).toBe(2);
        const requests = state.commands
          .filter((command) => command.type === "thread.activity.append")
          .filter((command) => command.activity.kind === "approval.requested");
        expect(requests).toHaveLength(2);
        expect(requests.map((command) => command.activity.payload)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              requestId: "execution:a:1:same-request",
              executionId: "execution:a:1",
              providerRequestId: "same-request",
            }),
            expect.objectContaining({
              requestId: "execution:b:1:same-request",
              executionId: "execution:b:1",
              providerRequestId: "same-request",
            }),
          ]),
        );
        expect(state.stopped).toHaveLength(2);
      }).pipe(Effect.provide(state.layer), Effect.scoped);
    }),
);

it.live("finalizes failed blocks and closes their sessions", () =>
  Effect.gen(function* () {
    const state = yield* harness("failure");
    yield* Effect.gen(function* () {
      const executor = yield* WorkspaceAgentExecutor;
      const error = yield* executor.execute(input("a")).pipe(Effect.flip);
      expect(error.message).toBe("Provider failed");
      expect(state.commands).toContainEqual(
        expect.objectContaining({ type: "thread.message.assistant.complete" }),
      );
      expect(state.commands).toContainEqual(
        expect.objectContaining({
          type: "thread.activity.append",
          activity: expect.objectContaining({
            payload: expect.objectContaining({ status: "failed" }),
          }),
        }),
      );
      expect(state.stopped).toHaveLength(1);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.live("appends a retry block and ignores late events from the previous attempt", () =>
  Effect.gen(function* () {
    const state = yield* harness("retry");
    yield* Effect.gen(function* () {
      const executor = yield* WorkspaceAgentExecutor;
      yield* executor.execute(input("a", 1));
      expect(yield* executor.execute(input("a", 2))).toBe("Result a");
      const completes = state.commands.filter(
        (command) => command.type === "thread.message.assistant.complete",
      );
      expect(new Set(completes.map((command) => command.messageId)).size).toBe(2);
      expect(state.stopped).toHaveLength(2);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.live("retains reported search evidence with source links and masked credentials", () =>
  Effect.gen(function* () {
    const state = yield* harness("research");
    yield* Effect.gen(function* () {
      const executor = yield* WorkspaceAgentExecutor;
      yield* executor.execute(input("research"));
      const captures = state.commands.filter(
        (command) => command.type === "project.knowledge.item.upsert",
      );
      expect(captures).toHaveLength(1);
      expect(captures[0]).toMatchObject({
        scope: "project",
        kind: "long-term-memory",
        research: { verification: "unverified" },
      });
      expect(captures[0]?.content).toContain("https://example.com/routing");
      expect(encodeCapture(captures[0])).not.toContain("sk-test123456789012345678901234567890");
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);

it.live("cancels a pending approval, finalizes the block, and stops the worker", () =>
  Effect.gen(function* () {
    const state = yield* harness("cancel");
    yield* Effect.gen(function* () {
      const executor = yield* WorkspaceAgentExecutor;
      const error = yield* executor.execute(input("a")).pipe(Effect.flip);
      expect(error.message).toBe("사용자가 실행을 중단했습니다.");
      expect(error.interrupted).toBe(true);
      const activities = state.commands.filter(
        (command) => command.type === "thread.activity.append",
      );
      expect(activities).toContainEqual(
        expect.objectContaining({
          activity: expect.objectContaining({
            kind: "orchestra.block",
            payload: expect.objectContaining({ status: "cancelled" }),
          }),
        }),
      );
      expect(activities).toContainEqual(
        expect.objectContaining({
          activity: expect.objectContaining({
            kind: "approval.resolved",
            payload: expect.objectContaining({
              requestId: "execution:a:1:same-request",
              decision: "cancel",
            }),
          }),
        }),
      );
      expect(state.commands).toContainEqual(
        expect.objectContaining({ type: "thread.message.assistant.complete" }),
      );
      expect(state.stopped).toHaveLength(1);
    }).pipe(Effect.provide(state.layer), Effect.scoped);
  }),
);
