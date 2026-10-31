import {
  ThreadId,
  WorkspaceMeetingParticipantId,
  WorkspaceTaskNodeId,
  type WorkspaceMeetingParticipant,
  type WorkspaceTaskNode,
  type WorkspaceTaskNodeStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { orchestraNodeConversations } from "./orchestraNodeConversations";

const OWNER = ThreadId.make("11111111-1111-4111-8111-111111111111");
const OTHER_OWNER = ThreadId.make("22222222-2222-4222-8222-222222222222");

function node(input: {
  readonly id: string;
  readonly order: number;
  readonly status: WorkspaceTaskNodeStatus;
  readonly threadId: ThreadId | null;
  readonly participantId?: string;
}): WorkspaceTaskNode {
  return {
    id: WorkspaceTaskNodeId.make(input.id),
    order: input.order,
    kind: "research",
    agent: "grok",
    role: "researcher",
    participantId:
      input.participantId === undefined
        ? null
        : WorkspaceMeetingParticipantId.make(input.participantId),
    threadId: input.threadId,
    parkedQuestion: null,
    worktreePath: null,
    branch: null,
    title: `title ${input.id}`,
    handoff: {
      task: input.id,
      goal: input.id,
      context: "",
      input: "",
      constraints: [],
      expectedOutput: "",
      successCriteria: [],
    },
    dependsOn: [],
    validationTargetId: null,
    priority: 0,
    status: input.status,
    maxAttempts: 1,
    attempts: [],
    output: null,
    error: null,
    failureClassification: null,
    confidence: null,
    validation: null,
    startedAt: null,
    completedAt: null,
  };
}

function seat(id: string, displayName: string): WorkspaceMeetingParticipant {
  return {
    id: WorkspaceMeetingParticipantId.make(id),
    displayName,
    modelSelection: { instanceId: "claudeAgent", model: "sonnet" } as never,
  };
}

const threadFor = (n: number) =>
  ThreadId.make(`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`);

describe("orchestraNodeConversations", () => {
  it("lists the node conversations of the runs this conversation convened", () => {
    const items = orchestraNodeConversations(
      [
        {
          status: "running",
          orchestra: { maxParallel: 3, isolateWorktrees: false },
          meeting: { threadId: OWNER, participants: [seat("s1", "클로드")] },
          graph: {
            nodes: [
              node({ id: "a", order: 0, status: "completed", threadId: threadFor(1) }),
              node({
                id: "b",
                order: 1,
                status: "running",
                threadId: threadFor(2),
                participantId: "s1",
              }),
            ],
          },
        },
      ],
      OWNER,
    );

    expect(items).toEqual([
      {
        threadId: threadFor(2),
        nodeId: "b",
        title: "title b",
        status: "running",
        seatLabel: "클로드",
        runIsLive: true,
      },
      {
        threadId: threadFor(1),
        nodeId: "a",
        title: "title a",
        status: "completed",
        seatLabel: null,
        runIsLive: true,
      },
    ]);
  });

  it("ignores runs another conversation convened and runs with no orchestra", () => {
    const items = orchestraNodeConversations(
      [
        {
          status: "running",
          orchestra: { maxParallel: 3, isolateWorktrees: false },
          meeting: { threadId: OTHER_OWNER },
          graph: {
            nodes: [node({ id: "a", order: 0, status: "running", threadId: threadFor(1) })],
          },
        },
        {
          status: "running",
          orchestra: null,
          meeting: { threadId: OWNER },
          graph: {
            nodes: [node({ id: "b", order: 0, status: "running", threadId: threadFor(2) })],
          },
        },
      ],
      OWNER,
    );

    expect(items).toEqual([]);
  });

  it("keeps a settled run's conversations and ranks live work above them", () => {
    const items = orchestraNodeConversations(
      [
        {
          status: "completed",
          orchestra: { maxParallel: 2, isolateWorktrees: false },
          meeting: { threadId: OWNER },
          graph: {
            nodes: [node({ id: "old", order: 0, status: "completed", threadId: threadFor(1) })],
          },
        },
        {
          status: "running",
          orchestra: { maxParallel: 2, isolateWorktrees: false },
          meeting: { threadId: OWNER },
          graph: {
            nodes: [node({ id: "new", order: 9, status: "queued", threadId: threadFor(2) })],
          },
        },
      ],
      OWNER,
    );

    expect(items.map((item) => item.nodeId)).toEqual(["new", "old"]);
  });

  it("puts a node parked on the person first and never lists the run's own conversation", () => {
    const items = orchestraNodeConversations(
      [
        {
          status: "running",
          orchestra: { maxParallel: 3, isolateWorktrees: false },
          meeting: { threadId: OWNER },
          graph: {
            nodes: [
              node({ id: "running", order: 0, status: "running", threadId: threadFor(1) }),
              node({ id: "parked", order: 5, status: "awaiting-user", threadId: threadFor(2) }),
              // A pre-orchestra node shares the run's conversation; it is this
              // conversation, not a hidden one, so it must not be listed.
              node({ id: "shared", order: 6, status: "running", threadId: OWNER }),
              node({ id: "unstarted", order: 7, status: "queued", threadId: null }),
            ],
          },
        },
      ],
      OWNER,
    );

    expect(items.map((item) => item.nodeId)).toEqual(["parked", "running"]);
  });

  it("lists a conversation once even when several runs reference it", () => {
    const shared = threadFor(3);
    const items = orchestraNodeConversations(
      [
        {
          status: "running",
          orchestra: { maxParallel: 2, isolateWorktrees: false },
          meeting: { threadId: OWNER },
          graph: { nodes: [node({ id: "a", order: 0, status: "running", threadId: shared })] },
        },
        {
          status: "completed",
          orchestra: { maxParallel: 2, isolateWorktrees: false },
          meeting: { threadId: OWNER },
          graph: { nodes: [node({ id: "b", order: 0, status: "completed", threadId: shared })] },
        },
      ],
      OWNER,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.nodeId).toBe("a");
  });
});
