import {
  ThreadId,
  WorkspaceMeetingParticipantId,
  WorkspaceTaskNodeId,
  type WorkspaceMeetingParticipant,
  type WorkspaceTaskNode,
  type WorkspaceTaskNodeStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parkedQuestionNodes,
  runKeptWorktreeCount,
  runsAwaitingPerson,
  seatLookupFrom,
  summarizeTaskGraphNodes,
} from "./taskGraphPresentation";

function taskNode(
  id: string,
  status: WorkspaceTaskNodeStatus,
  parkedQuestion: WorkspaceTaskNode["parkedQuestion"] = null,
): WorkspaceTaskNode {
  return {
    id: WorkspaceTaskNodeId.make(id),
    order: 0,
    kind: "research",
    agent: "grok",
    role: "researcher",
    participantId: null,
    threadId: null,
    parkedQuestion,
    worktreePath: null,
    branch: null,
    title: id,
    handoff: {
      task: id,
      goal: id,
      context: "",
      input: "",
      constraints: [],
      expectedOutput: "",
      successCriteria: [],
    },
    dependsOn: [],
    validationTargetId: null,
    priority: 0,
    status,
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

describe("summarizeTaskGraphNodes", () => {
  it("counts nodes parked on the person apart from ones merely waiting", () => {
    const counts = summarizeTaskGraphNodes([
      taskNode("a", "running"),
      taskNode("b", "awaiting-validation"),
      taskNode("c", "awaiting-user"),
      taskNode("d", "awaiting-user"),
      taskNode("e", "queued"),
      taskNode("f", "completed"),
      taskNode("g", "failed"),
      taskNode("h", "blocked"),
    ]);

    expect(counts).toEqual({
      total: 8,
      active: 2,
      completed: 1,
      failedOrBlocked: 2,
      waiting: 1,
      awaitingUser: 2,
    });
  });

  it("reports an empty graph as all zeroes rather than throwing", () => {
    expect(summarizeTaskGraphNodes([])).toEqual({
      total: 0,
      active: 0,
      completed: 0,
      failedOrBlocked: 0,
      waiting: 0,
      awaitingUser: 0,
    });
  });
});

describe("seatLookupFrom", () => {
  it("maps seat ids to the names the person gave them", () => {
    const lookup = seatLookupFrom([seat("seat-claude", "설계"), seat("seat-codex", "구현")]);
    expect(lookup.get("seat-claude")).toBe("설계");
    expect(lookup.get("seat-codex")).toBe("구현");
  });

  it("is empty for a role-bound run, which has no roster", () => {
    expect(seatLookupFrom(undefined).size).toBe(0);
  });
});

describe("parkedQuestionNodes", () => {
  it("returns only the nodes holding a question behind the live one", () => {
    const parked = {
      question: "이 파일을 지워도 됩니까?",
      options: ["예", "아니오"],
      context: "",
      intervention: false,
      raisedAt: "2026-09-07T00:00:00.000Z",
    } as WorkspaceTaskNode["parkedQuestion"];

    const nodes = parkedQuestionNodes([
      taskNode("a", "running"),
      taskNode("b", "awaiting-user", parked),
      taskNode("c", "awaiting-user"),
    ]);

    expect(nodes.map((node) => String(node.id))).toEqual(["b"]);
  });
});

describe("runsAwaitingPerson", () => {
  const run = (input: {
    readonly id: string;
    readonly status: string;
    readonly question?: string | null;
    readonly nodes?: ReadonlyArray<WorkspaceTaskNode>;
  }) => ({
    id: input.id,
    status: input.status,
    task: `task ${input.id}`,
    meeting: input.question ? { pendingQuestion: { question: input.question } } : null,
    graph: input.nodes ? { nodes: input.nodes } : null,
  });

  const parked = {
    question: "계속할까요?",
    options: [],
    context: "",
    intervention: false,
    raisedAt: "2026-09-07T00:00:00.000Z",
  } as WorkspaceTaskNode["parkedQuestion"];

  it("counts the questions queued behind the live one so answering once does not look final", () => {
    const items = runsAwaitingPerson([
      run({
        id: "r1",
        status: "running",
        question: "alpha를 지울까요?",
        nodes: [
          taskNode("a", "awaiting-user"),
          taskNode("b", "awaiting-user", parked),
          taskNode("c", "running"),
        ],
      }),
    ]);

    expect(items).toEqual([
      {
        runId: "r1",
        task: "task r1",
        liveQuestion: "alpha를 지울까요?",
        queuedQuestions: 1,
        awaitingUser: 2,
        blockedNodeThreads: 0,
      },
    ]);
  });

  it("surfaces a run whose only signal is a node conversation blocked on provider input", () => {
    const blockedNode = {
      ...taskNode("a", "running"),
      threadId: ThreadId.make("thread-blocked"),
    };
    const items = runsAwaitingPerson(
      [run({ id: "r1", status: "running", nodes: [blockedNode, taskNode("b", "running")] })],
      new Set(["thread-blocked"]),
    );
    expect(items).toEqual([
      {
        runId: "r1",
        task: "task r1",
        liveQuestion: null,
        queuedQuestions: 0,
        awaitingUser: 0,
        blockedNodeThreads: 1,
      },
    ]);
  });

  it("ignores runs that are not live, whose questions are history", () => {
    const items = runsAwaitingPerson([
      run({ id: "done", status: "completed", question: "이미 끝난 질문" }),
      run({ id: "cancelled", status: "cancelled", question: "취소된 질문" }),
    ]);
    expect(items).toEqual([]);
  });

  it("skips a live run that is simply working", () => {
    const items = runsAwaitingPerson([
      run({ id: "busy", status: "running", nodes: [taskNode("a", "running")] }),
    ]);
    expect(items).toEqual([]);
  });
});

describe("runKeptWorktreeCount", () => {
  it("counts distinct chain worktrees, not the nodes sharing them", () => {
    const chainA1 = { ...taskNode("a1", "completed"), worktreePath: "E:/worktrees/chain-a" };
    const chainA2 = { ...taskNode("a2", "completed"), worktreePath: "E:/worktrees/chain-a" };
    const chainB = { ...taskNode("b", "failed"), worktreePath: "E:/worktrees/chain-b" };
    expect(
      runKeptWorktreeCount({ nodes: [chainA1, chainA2, chainB, taskNode("r", "completed")] }),
    ).toBe(2);
    expect(runKeptWorktreeCount(null)).toBe(0);
  });
});
