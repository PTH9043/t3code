import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceMeetingParticipantId,
  WorkspaceTaskNodeId,
  type OrchestrationEvent,
  type WorkspaceMeetingSetup,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-17T00:00:00.000Z";
const projectId = ProjectId.make("workspace-a");
const threadId = ThreadId.make("thread-a");

function asSingleEvent(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  const event = Array.isArray(result) ? result[0] : result;
  if (!event) throw new Error("Expected one orchestration event");
  return event;
}

const meetingSetup = (setupThreadId?: ThreadId): WorkspaceMeetingSetup => ({
  mode: "fixed-rounds",
  participants: [
    {
      id: WorkspaceMeetingParticipantId.make("p1"),
      displayName: "Claude",
      modelSelection: { instanceId: ProviderInstanceId.make("claude-a"), model: "claude-fable" },
    },
    {
      id: WorkspaceMeetingParticipantId.make("p2"),
      displayName: "Codex",
      modelSelection: { instanceId: ProviderInstanceId.make("codex-a"), model: "gpt-5" },
    },
  ],
  chairParticipantId: null,
  maxRounds: 1,
  userInLoop: false,
  ...(setupThreadId !== undefined ? { threadId: setupThreadId } : {}),
});

const requestCommand = (setupThreadId?: ThreadId) =>
  ({
    type: "project.collaboration.run.request",
    commandId: CommandId.make("request-meeting"),
    runId: WorkspaceCollaborationRunId.make("run-a"),
    projectId,
    task: "서버 기능 구현",
    meeting: meetingSetup(setupThreadId),
    createdAt: now,
  }) as const;

function seedReadModel() {
  return Effect.gen(function* () {
    let readModel = createEmptyReadModel(now);
    const created = asSingleEvent(
      yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("create-workspace-a"),
          projectId,
          title: "Workspace A",
          workspaceRoot: "D:/work/workspace-a",
          createdAt: now,
        },
        readModel,
      }),
    );
    readModel = yield* projectEvent(readModel, { ...created, sequence: 1 } as OrchestrationEvent);
    const threadCreated = asSingleEvent(
      yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("create-thread-a"),
          threadId,
          projectId,
          title: "내 원래 대화",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude-a"),
            model: "claude-fable",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        readModel,
      }),
    );
    return yield* projectEvent(readModel, {
      ...threadCreated,
      sequence: 2,
    } as OrchestrationEvent);
  });
}

it.layer(NodeServices.layer)("Meeting thread decider", (it) => {
  it.effect("retains a node attempt's usage context on its durable turn request", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel();
      const usageContext = {
        workId: "run-a",
        nodeId: "node-a",
        phase: "verification" as const,
        attempt: 2,
      };
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("node-attempt"),
          threadId,
          message: {
            messageId: MessageId.make("attempt-message"),
            role: "user",
            text: "verify",
            attachments: [],
          },
          usageContext,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      const requested = events.find((event) => event.type === "thread.turn-start-requested");
      expect(requested?.payload.usageContext).toEqual(usageContext);
    }),
  );

  it.effect("accepts worktree isolation for meeting and role-bound requests", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel();
      for (const withMeeting of [true, false]) {
        const { meeting, ...base } = requestCommand();
        const accepted = asSingleEvent(
          yield* decideOrchestrationCommand({
            command: {
              ...base,
              ...(withMeeting ? { meeting } : {}),
              orchestra: { maxParallel: 2, isolateWorktrees: true },
            },
            readModel,
          }),
        );
        expect(accepted.type).toBe("project.collaboration-run-requested");
        expect(
          accepted.type === "project.collaboration-run-requested"
            ? accepted.payload.run.orchestra
            : null,
        ).toEqual({ maxParallel: 2, isolateWorktrees: true });
      }
    }),
  );

  it.effect("carries the displayed question identity into the durable answer event", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel();
      const questionRef = { nodeId: WorkspaceTaskNodeId.make("node-a"), askedAt: now };
      const event = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.collaboration.run.answer",
            commandId: CommandId.make("answer-1"),
            runId: WorkspaceCollaborationRunId.make("run-a"),
            projectId,
            question: "계속할까요?",
            questionRef,
            answer: "계속",
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(event.type).toBe("project.collaboration-run-answered");
      if (event.type === "project.collaboration-run-answered") {
        expect(event.payload.questionRef).toEqual(questionRef);
      }
    }),
  );

  it.effect("seeds the meeting with the conversation the person sent it from", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel();
      const event = asSingleEvent(
        yield* decideOrchestrationCommand({ command: requestCommand(threadId), readModel }),
      );

      expect(event.type).toBe("project.collaboration-run-requested");
      if (event.type !== "project.collaboration-run-requested") return;
      expect(event.payload.run.meeting?.threadId).toBe(threadId);
    }),
  );

  it.effect("still opens a fresh thread when the request names none", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel();
      const event = asSingleEvent(
        yield* decideOrchestrationCommand({ command: requestCommand(), readModel }),
      );

      expect(event.type).toBe("project.collaboration-run-requested");
      if (event.type !== "project.collaboration-run-requested") return;
      expect(event.payload.run.meeting?.threadId).toBeNull();
    }),
  );

  it.effect("turns an interjection into its event verbatim", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel();
      const event = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.collaboration.run.interject",
            commandId: CommandId.make("interject-1"),
            runId: WorkspaceCollaborationRunId.make("run-a"),
            projectId,
            text: "예산은 무료 티어로 한정해줘",
            createdAt: now,
          },
          readModel,
        }),
      );

      expect(event.type).toBe("project.collaboration-run-interjected");
      if (event.type !== "project.collaboration-run-interjected") return;
      expect(event.payload).toMatchObject({
        runId: "run-a",
        text: "예산은 무료 티어로 한정해줘",
        interjectedAt: now,
      });
    }),
  );

  it.effect("rejects a meeting aimed at a conversation that does not exist", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel();
      const error = yield* decideOrchestrationCommand({
        command: requestCommand(ThreadId.make("thread-missing")),
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a meeting aimed at another project's conversation", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel();
      const otherProjectId = ProjectId.make("workspace-b");
      const otherCreated = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("create-workspace-b"),
            projectId: otherProjectId,
            title: "Workspace B",
            workspaceRoot: "D:/work/workspace-b",
            createdAt: now,
          },
          readModel,
        }),
      );
      readModel = yield* projectEvent(readModel, {
        ...otherCreated,
        sequence: 3,
      } as OrchestrationEvent);

      const error = yield* decideOrchestrationCommand({
        command: {
          ...requestCommand(threadId),
          projectId: otherProjectId,
          runId: WorkspaceCollaborationRunId.make("run-b"),
        },
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
