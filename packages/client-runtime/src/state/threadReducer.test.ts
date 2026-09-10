import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

describe("applyThreadDetailEvent", () => {
  describe("project events", () => {
    it("returns unchanged for project.created", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        type: "project.created",
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "T3 Code",
          workspaceRoot: "/repo",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
          deletedAt: null,
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.created", () => {
    it("creates a fresh thread", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-2"),
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-2"),
          projectId: ProjectId.make("project-1"),
          title: "New Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.id).toBe("thread-2");
        expect(result.thread.title).toBe("New Thread");
        expect(result.thread.branch).toBe("main");
        expect(result.thread.messages).toEqual([]);
        expect(result.thread.session).toBeNull();
      }
    });
  });

  describe("thread.deleted", () => {
    it("returns deleted signal", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: "2026-04-01T02:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.deleted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          deletedAt: "2026-04-01T02:00:00.000Z",
        },
      });
      expect(result.kind).toBe("deleted");
    });
  });

  describe("thread.archived / thread.unarchived", () => {
    it("sets archivedAt and clears title regeneration", () => {
      const regeneratingThread: OrchestrationThread = {
        ...baseThread,
        titleRegeneration: {
          requestId: CommandId.make("regenerate-title"),
          startedAt: "2026-04-01T02:00:00.000Z",
        },
      };
      const result = applyThreadDetailEvent(regeneratingThread, {
        ...baseEventFields,
        sequence: 3,
        occurredAt: "2026-04-01T03:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.archived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          archivedAt: "2026-04-01T03:00:00.000Z",
          updatedAt: "2026-04-01T03:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBe("2026-04-01T03:00:00.000Z");
        expect(result.thread.titleRegeneration).toBeNull();
      }
    });

    it("clears archivedAt", () => {
      const archivedThread = { ...baseThread, archivedAt: "2026-04-01T03:00:00.000Z" };
      const result = applyThreadDetailEvent(archivedThread, {
        ...baseEventFields,
        sequence: 4,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unarchived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          updatedAt: "2026-04-01T04:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBeNull();
      }
    });
  });

  describe("thread.settled / thread.unsettled", () => {
    it("sets the settled override and timestamp", () => {
      const settledAt = "2026-04-01T05:00:00.000Z";
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: settledAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.settled",
        payload: {
          threadId: ThreadId.make("thread-1"),
          settledAt,
          updatedAt: settledAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.settledOverride).toBe("settled");
        expect(result.thread.settledAt).toBe(settledAt);
      }
    });

    it.each([
      ["user", "active"],
      ["activity", null],
    ] as const)("unsettles for %s with override %s", (reason, settledOverride) => {
      const settledThread: OrchestrationThread = {
        ...baseThread,
        settledOverride: "settled",
        settledAt: "2026-04-01T05:00:00.000Z",
      };
      const updatedAt = "2026-04-01T06:00:00.000Z";
      const result = applyThreadDetailEvent(settledThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: updatedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unsettled",
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason,
          updatedAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.settledOverride).toBe(settledOverride);
        expect(result.thread.settledAt).toBeNull();
      }
    });
  });

  describe("thread.pinned / thread.unpinned", () => {
    it("sets pinnedAt", () => {
      const pinnedAt = "2026-04-01T05:00:00.000Z";
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: pinnedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.pinned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          pinnedAt,
          updatedAt: pinnedAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.pinnedAt).toBe(pinnedAt);
      }
    });

    it("clears pinnedAt", () => {
      const pinnedThread: OrchestrationThread = {
        ...baseThread,
        pinnedAt: "2026-04-01T05:00:00.000Z",
      };
      const updatedAt = "2026-04-01T06:00:00.000Z";
      const result = applyThreadDetailEvent(pinnedThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: updatedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unpinned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          updatedAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.pinnedAt).toBeNull();
      }
    });
  });

  describe("thread.meta-updated", () => {
    it("applies opt-in and reversal without changing the selected model", () => {
      let thread = baseThread;
      for (const handoffMode of ["compact", "standard"] as const) {
        const result = applyThreadDetailEvent(thread, {
          ...baseEventFields,
          sequence: 5,
          occurredAt: "2026-04-01T05:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: thread.id,
          type: "thread.meta-updated",
          payload: { threadId: thread.id, handoffMode, updatedAt: "2026-04-01T05:00:00.000Z" },
        });
        expect(result.kind).toBe("updated");
        if (result.kind === "updated") thread = result.thread;
        expect(thread.handoffMode).toBe(handoffMode);
        expect(thread.modelSelection).toEqual(baseThread.modelSelection);
      }
    });
    it("patches title and branch", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: "2026-04-01T05:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          title: "Updated Title",
          branch: "feature/demo",
          updatedAt: "2026-04-01T05:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.title).toBe("Updated Title");
        expect(result.thread.branch).toBe("feature/demo");
        // Model selection should be unchanged since it wasn't in the payload
        expect(result.thread.modelSelection).toEqual(baseThread.modelSelection);
      }
    });
  });

  describe("thread.message-sent", () => {
    it("appends a new message", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: "2026-04-01T06:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-1"),
          role: "user",
          text: "Hello, world!",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("appends text for streaming messages", () => {
      const threadWithMessage: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithMessage, {
        ...baseEventFields,
        sequence: 7,
        occurredAt: "2026-04-01T06:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: ", world!",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("caps retained message rows so an ever-appending thread stays bounded", () => {
      const existingMessages = Array.from({ length: 1000 }, (_, index) => ({
        id: MessageId.make(`bulk-${index}`),
        role: "assistant" as const,
        text: `report ${index}`,
        turnId: TurnId.make("turn-1"),
        streaming: false,
        createdAt: "2026-04-01T06:00:00.000Z",
        updatedAt: "2026-04-01T06:00:00.000Z",
      }));

      const result = applyThreadDetailEvent(
        { ...baseThread, messages: existingMessages },
        {
          ...baseEventFields,
          sequence: 7,
          occurredAt: "2026-04-01T06:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.message-sent",
          payload: {
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("bulk-1000"),
            role: "assistant",
            text: "report 1000",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T06:01:00.000Z",
            updatedAt: "2026-04-01T06:01:00.000Z",
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1000);
        // Oldest row evicted, newest appended row kept.
        expect(result.thread.messages[0]?.id).toBe("bulk-1");
        expect(result.thread.messages[999]?.id).toBe("bulk-1000");
      }
    });

    it("updates latestTurn for assistant messages with a turn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Done.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.assistantMessageId).toBe("msg-3");
      }
    });

    it("keeps latestTurn running for interim assistant messages while the session runs the turn", () => {
      const threadWithRunningSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningSession, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Interim commentary between tool calls.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("running");
        expect(result.thread.latestTurn?.completedAt).toBeNull();
      }
    });
  });

  describe("thread.session-set", () => {
    it("settles a running latestTurn when the session leaves the running status", () => {
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T07:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-3"),
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.completedAt).toBe("2026-04-01T08:00:00.000Z");
      }
    });

    it("updates session and latestTurn for a running session", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("running");
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("running");
      }
    });
  });

  describe("thread.session-stop-requested", () => {
    it("marks session as stopped", () => {
      const threadWithSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T08:00:00.000Z",
        },
      };

      const result = applyThreadDetailEvent(threadWithSession, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("stopped");
        expect(result.thread.session?.activeTurnId).toBeNull();
      }
    });

    it("returns unchanged when no session exists", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.proposed-plan-upserted", () => {
    it("adds a proposed plan", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 11,
        occurredAt: "2026-04-01T10:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          proposedPlan: {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "## Plan\n- Do stuff",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-01T10:00:00.000Z",
            updatedAt: "2026-04-01T10:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.proposedPlans).toHaveLength(1);
        expect(result.thread.proposedPlans[0]?.id).toBe("plan-1");
      }
    });
  });

  describe("thread.activity-appended", () => {
    it("adds an activity", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 12,
        occurredAt: "2026-04-01T11:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "tool",
            kind: "file-edit",
            summary: "Edited src/index.ts",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-04-01T11:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(1);
        expect(result.thread.activities[0]?.kind).toBe("file-edit");
      }
    });

    it("preserves the complete activity history when live events arrive", () => {
      const existingActivities = Array.from({ length: 129 }, (_, index) => ({
        id: EventId.make(`activity-${index}`),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran command ${index}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence: index,
        createdAt: "2026-04-01T11:00:00.000Z",
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 130,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-129"),
              tone: "tool",
              kind: "command",
              summary: "Ran command 129",
              payload: {},
              turnId: TurnId.make("turn-1"),
              sequence: 129,
              createdAt: "2026-04-01T11:01:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(130);
        expect(result.thread.activities[0]?.id).toBe("activity-0");
      }
    });

    it("compacts heavy payloads of activities older than the retention window while keeping rows, summaries, and routing markers", () => {
      // 350 existing rows so appending pushes the oldest well past the 300-row
      // payload-retention window. Each carries a heavy body plus routing markers.
      const heavy = (index: number) => ({
        data: { rawOutput: { content: "x".repeat(5000) }, item: { big: "y".repeat(5000) } },
        detail: "z".repeat(5000),
        agentId: `agent-${index}`,
        timelineBypass: true,
        taskId: `task-${index}`,
      });
      const existingActivities = Array.from({ length: 350 }, (_, index) => ({
        id: EventId.make(`activity-${index}`),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran command ${index}`,
        payload: heavy(index),
        turnId: TurnId.make("turn-1"),
        sequence: index,
        createdAt: "2026-04-01T11:00:00.000Z",
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 350,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-350"),
              tone: "tool",
              kind: "command",
              summary: "Ran command 350",
              payload: heavy(350),
              turnId: TurnId.make("turn-1"),
              sequence: 350,
              createdAt: "2026-04-01T11:01:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind !== "updated") return;
      const rows = result.thread.activities;
      // No rows dropped — the row and its summary survive.
      expect(rows).toHaveLength(351);
      expect(rows[0]?.id).toBe("activity-0");
      expect(rows[0]?.summary).toBe("Ran command 0");
      // Oldest row: heavy body blanked, routing markers kept.
      const oldest = rows[0]?.payload as Record<string, unknown>;
      expect(oldest.data).toBeUndefined();
      expect(oldest.detail).toBeUndefined();
      expect(oldest.agentId).toBe("agent-0");
      expect(oldest.timelineBypass).toBe(true);
      expect(oldest.taskId).toBe("task-0");
      // Newest rows (inside the window) keep the full heavy payload.
      const newest = rows[350]?.payload as Record<string, unknown>;
      expect((newest.data as Record<string, unknown>)?.rawOutput).toBeDefined();
      expect(newest.detail).toBe("z".repeat(5000));
    });

    it("pools one shared frozen payload for compacted rows that have no markers", () => {
      const existingActivities = Array.from({ length: 350 }, (_, index) => ({
        id: EventId.make(`plain-${index}`),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran command ${index}`,
        payload: { data: { rawOutput: { content: "x".repeat(4000) } } },
        turnId: TurnId.make("turn-1"),
        sequence: index,
        createdAt: "2026-04-01T11:00:00.000Z",
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 350,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("plain-350"),
              tone: "tool",
              kind: "command",
              summary: "Ran command 350",
              payload: { data: { rawOutput: { content: "x".repeat(4000) } } },
              turnId: TurnId.make("turn-1"),
              sequence: 350,
              createdAt: "2026-04-01T11:01:00.000Z",
            },
          },
        },
      );
      expect(result.kind).toBe("updated");
      if (result.kind !== "updated") return;
      const rows = result.thread.activities;
      // Two different old rows must share the SAME payload object (pooled).
      expect(rows[0]?.payload).toBe(rows[1]?.payload);
      expect(Object.isFrozen(rows[0]?.payload)).toBe(true);
    });

    it("caps retained activity rows while keeping the most recent resolvable context-window past the cap", () => {
      // One resolvable context-window row up front, then enough plain rows to
      // push it far past the 2000-row cap.
      const rows = [
        {
          id: EventId.make("cw-old"),
          tone: "info" as const,
          kind: "context-window.updated",
          summary: "ctx",
          payload: { usedTokens: 4242, maxTokens: 200000 },
          turnId: TurnId.make("turn-0"),
          sequence: 0,
          createdAt: "2026-04-01T10:00:00.000Z",
        },
        ...Array.from({ length: 2100 }, (_, index) => ({
          id: EventId.make(`row-${index}`),
          tone: "tool" as const,
          kind: "command",
          summary: `cmd ${index}`,
          payload: {},
          turnId: TurnId.make("turn-1"),
          sequence: index + 1,
          createdAt: "2026-04-01T11:00:00.000Z",
        })),
      ];
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: rows },
        {
          ...baseEventFields,
          sequence: 2200,
          occurredAt: "2026-04-01T11:05:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("row-2100"),
              tone: "tool",
              kind: "command",
              summary: "cmd 2100",
              payload: {},
              turnId: TurnId.make("turn-1"),
              sequence: 2102,
              createdAt: "2026-04-01T11:05:00.000Z",
            },
          },
        },
      );
      expect(result.kind).toBe("updated");
      if (result.kind !== "updated") return;
      const kept = result.thread.activities;
      // Cap holds (2000 tail + the preserved context-window survivor).
      expect(kept.length).toBeLessThanOrEqual(2000 + 1);
      expect(kept.length).toBeGreaterThan(1900);
      const cw = kept.find((a) => a.kind === "context-window.updated");
      expect(cw?.id).toBe("cw-old");
      expect((cw?.payload as Record<string, unknown> | undefined)?.usedTokens).toBe(4242);
      // Oldest plain rows were evicted.
      expect(kept.some((a) => a.id === "row-0")).toBe(false);
      expect(kept.some((a) => a.id === "row-2100")).toBe(true);
    });

    it("never compacts context-window.updated payloads so resolution keeps working", () => {
      const existingActivities = Array.from({ length: 350 }, (_, index) => ({
        id: EventId.make(`cw-${index}`),
        tone: "info" as const,
        kind: "context-window.updated",
        summary: `context ${index}`,
        payload: { usedTokens: 1000 + index, maxTokens: 200000 },
        turnId: TurnId.make("turn-1"),
        sequence: index,
        createdAt: "2026-04-01T11:00:00.000Z",
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 350,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("cw-350"),
              tone: "info",
              kind: "context-window.updated",
              summary: "context 350",
              payload: { usedTokens: 1350, maxTokens: 200000 },
              turnId: TurnId.make("turn-1"),
              sequence: 350,
              createdAt: "2026-04-01T11:01:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind !== "updated") return;
      // The append supersedes earlier resolvable context-window rows for the
      // same turn, leaving one; it must retain its real usedTokens (never blanked).
      const cw = result.thread.activities.filter((a) => a.kind === "context-window.updated");
      expect(cw.length).toBeGreaterThanOrEqual(1);
      const latest = cw[cw.length - 1]?.payload as Record<string, unknown>;
      expect(latest.usedTokens).toBe(1350);
    });

    it("appends an in-order row without touching earlier rows, and re-sorts a late one", () => {
      const row = (id: string, sequence: number) => ({
        id: EventId.make(id),
        tone: "tool" as const,
        kind: "command",
        summary: id,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence,
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const existing = [row("a", 1), row("b", 2)];
      const append = (activity: ReturnType<typeof row>, activities = existing) =>
        applyThreadDetailEvent(
          { ...baseThread, activities },
          {
            ...baseEventFields,
            sequence: 50,
            occurredAt: "2026-04-01T11:01:00.000Z",
            aggregateKind: "thread",
            aggregateId: ThreadId.make("thread-1"),
            type: "thread.activity-appended",
            payload: { threadId: ThreadId.make("thread-1"), activity },
          },
        );

      const inOrder = append(row("c", 3));
      expect(inOrder.kind).toBe("updated");
      if (inOrder.kind === "updated") {
        expect(inOrder.thread.activities.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
        // Earlier rows keep their identity: downstream caches key on it.
        expect(inOrder.thread.activities[0]).toBe(existing[0]);
        expect(inOrder.thread.activities[1]).toBe(existing[1]);
      }

      const late = append(row("early", 0));
      expect(late.kind).toBe("updated");
      if (late.kind === "updated") {
        expect(late.thread.activities.map((entry) => entry.id)).toEqual(["early", "a", "b"]);
      }
    });

    it("replaces earlier resolvable context-window updates for the same turn", () => {
      const contextWindowActivity = (id: string, sequence: number, usedTokens: unknown) => ({
        id: EventId.make(id),
        tone: "info" as const,
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens },
        turnId: TurnId.make("turn-1"),
        sequence,
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const otherTurnActivity = contextWindowActivity("activity-other-turn", 2, 500);
      const existingActivities = [
        contextWindowActivity("activity-cw-1", 1, 1_000),
        { ...otherTurnActivity, turnId: TurnId.make("turn-0") },
        // Malformed row (no usedTokens): must survive, and must not be
        // treated as the latest value by consumers.
        contextWindowActivity("activity-cw-malformed", 3, undefined),
        contextWindowActivity("activity-cw-2", 4, 2_000),
      ];

      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 20,
          occurredAt: "2026-04-01T11:02:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: contextWindowActivity("activity-cw-3", 5, 3_000),
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        const ids = result.thread.activities.map((activity) => activity.id);
        // Same-turn resolvable rows collapse to the newest; the other turn's
        // row and the malformed row are untouched.
        expect(ids).toEqual(["activity-other-turn", "activity-cw-malformed", "activity-cw-3"]);
      }
    });

    it("does not collapse context-window history for a malformed update", () => {
      const resolvable = {
        id: EventId.make("activity-cw-resolvable"),
        tone: "info" as const,
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens: 1_000 },
        turnId: TurnId.make("turn-1"),
        sequence: 1,
        createdAt: "2026-04-01T11:00:00.000Z",
      };

      const result = applyThreadDetailEvent(
        { ...baseThread, activities: [resolvable] },
        {
          ...baseEventFields,
          sequence: 21,
          occurredAt: "2026-04-01T11:03:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              ...resolvable,
              id: EventId.make("activity-cw-broken"),
              payload: { usedTokens: Number.NaN },
              sequence: 2,
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        // The resolvable row must survive so consumers can still derive a
        // usage value by walking backwards past the malformed row.
        const ids = result.thread.activities.map((activity) => activity.id);
        expect(ids).toEqual(["activity-cw-resolvable", "activity-cw-broken"]);
      }
    });
  });

  describe("thread.turn-diff-completed", () => {
    it("adds a checkpoint and updates latestTurn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 13,
        occurredAt: "2026-04-01T12:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("ref-1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("msg-3"),
          completedAt: "2026-04-01T12:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
      }
    });
  });

  describe("thread.reverted", () => {
    it("filters entities to retained turns", () => {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "user",
            text: "First",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Response 1",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            id: MessageId.make("msg-3"),
            role: "assistant",
            text: "Response 2",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T03:00:00.000Z",
            updatedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-2"),
            completedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            turnId: TurnId.make("turn-2"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-3"),
            completedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 14,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.reverted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnCount: 1,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        // turn-2 checkpoint is filtered out (turnCount 2 > revert target 1)
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.checkpoints[0]?.turnId).toBe("turn-1");
        // msg-3 (turn-2) is filtered, msg-1 (no turn) and msg-2 (turn-1) remain
        expect(result.thread.messages).toHaveLength(2);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
      }
    });
  });

  describe("no-op events", () => {
    it("returns unchanged for approval-response-requested", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 15,
        occurredAt: "2026-04-01T13:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.approval-response-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          requestId: "req-1",
          decision: "approve",
          createdAt: "2026-04-01T13:00:00.000Z",
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("row caps and paginated history", () => {
    const MESSAGE_ROW_CAP = 1000;
    const ACTIVITY_ROW_CAP = 2000;

    const messageAt = (index: number): OrchestrationThread["messages"][number] => ({
      id: MessageId.make(`old-msg-${index}`),
      role: "assistant",
      text: `line ${index}`,
      turnId: null,
      streaming: false,
      createdAt: `2026-04-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      updatedAt: `2026-04-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    });
    const activityAt = (index: number): OrchestrationThread["activities"][number] => ({
      id: EventId.make(`old-activity-${index}`),
      kind: "tool.completed",
      tone: "info",
      summary: "old",
      payload: { output: "verbose" },
      turnId: null,
      createdAt: `2026-04-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    });
    const messageSent = {
      ...baseEventFields,
      sequence: 9999,
      occurredAt: "2026-04-01T09:00:00.000Z",
      aggregateKind: "thread" as const,
      aggregateId: ThreadId.make("thread-1"),
      type: "thread.message-sent" as const,
      payload: {
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("fresh-msg"),
        role: "user" as const,
        text: "newest",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T09:00:00.000Z",
        updatedAt: "2026-04-01T09:00:00.000Z",
      },
    };
    const activityAppended = {
      ...baseEventFields,
      sequence: 9998,
      occurredAt: "2026-04-01T09:00:00.000Z",
      aggregateKind: "thread" as const,
      aggregateId: ThreadId.make("thread-1"),
      type: "thread.activity-appended" as const,
      payload: {
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("fresh-activity"),
          kind: "tool.completed",
          tone: "info" as const,
          summary: "newest",
          payload: { output: "fresh" },
          turnId: null,
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      },
    };

    it("caps messages by default, dropping the oldest", () => {
      const thread = {
        ...baseThread,
        messages: Array.from({ length: MESSAGE_ROW_CAP }, (_, index) => messageAt(index)),
      };
      const result = applyThreadDetailEvent(thread, messageSent as never);
      expect(result.kind).toBe("updated");
      if (result.kind !== "updated") return;
      expect(result.thread.messages).toHaveLength(MESSAGE_ROW_CAP);
      expect(result.thread.messages.some((m) => m.id === "old-msg-0")).toBe(false);
    });

    it("keeps loaded history when capRows is false (older page merged)", () => {
      const thread = {
        ...baseThread,
        messages: Array.from({ length: MESSAGE_ROW_CAP }, (_, index) => messageAt(index)),
      };
      const result = applyThreadDetailEvent(thread, messageSent as never, { capRows: false });
      expect(result.kind).toBe("updated");
      if (result.kind !== "updated") return;
      // The just-loaded older page (old-msg-0) survives the new message instead
      // of being trimmed into an unreachable gap.
      expect(result.thread.messages).toHaveLength(MESSAGE_ROW_CAP + 1);
      expect(result.thread.messages.some((m) => m.id === "old-msg-0")).toBe(true);
    });

    it("caps activities by default but retains them with capRows false", () => {
      const thread = {
        ...baseThread,
        activities: Array.from({ length: ACTIVITY_ROW_CAP }, (_, index) => activityAt(index)),
      };
      const capped = applyThreadDetailEvent(thread, activityAppended as never);
      const kept = applyThreadDetailEvent(thread, activityAppended as never, { capRows: false });
      expect(capped.kind === "updated" && capped.thread.activities.length).toBe(ACTIVITY_ROW_CAP);
      expect(kept.kind === "updated" && kept.thread.activities.length).toBe(ACTIVITY_ROW_CAP + 1);
      if (kept.kind === "updated") {
        expect(kept.thread.activities.some((a) => a.id === "old-activity-0")).toBe(true);
      }
    });
  });
});
