import {
  WorkspaceMeetingParticipantId,
  WorkspaceTaskNodeId,
  type WorkspaceMeetingParticipant,
  type WorkspaceTaskNode,
  type WorkspaceTaskNodeStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parkedQuestionNodes,
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
