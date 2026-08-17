import {
  ProjectId,
  ProviderInstanceId,
  WorkspaceMeetingParticipantId,
  type IsoDateTime,
  type WorkspaceMeeting,
  type WorkspaceMeetingRound,
  type WorkspaceMeetingStatement,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMeetingChairClosePrompt,
  buildMeetingPlanPrompt,
  buildMeetingStatementPrompt,
  nextMeetingStep,
  parseChairVerdict,
  parseMeetingQuestion,
  parseStatementRespondsTo,
  plannedSpeakers,
  renderMeetingTranscript,
  resolveChairParticipantId,
  resolveNodeAssignmentRoute,
  roundCheckInQuestion,
  WorkspaceMeetingError,
} from "./workspaceMeeting.ts";

const at = "2026-08-16T00:00:00.000Z" as IsoDateTime;
const seat = (id: string) => WorkspaceMeetingParticipantId.make(id);

function participant(id: string, displayName: string) {
  return {
    id: seat(id),
    displayName,
    modelSelection: { instanceId: ProviderInstanceId.make(`${id}_instance`), model: "model-x" },
  };
}

function statement(participantId: string, content: string): WorkspaceMeetingStatement {
  return {
    participantId: seat(participantId),
    content,
    respondsTo: [],
    threadId: null,
    recordedAt: at,
  };
}

function round(input: {
  readonly index: number;
  readonly spoke: ReadonlyArray<string>;
  readonly chairSummary?: string | null;
  readonly consensusReached?: boolean | null;
}): WorkspaceMeetingRound {
  return {
    index: input.index,
    // Content deliberately free of seat ids, so a test can assert the renderer
    // never leaks one into the prose the models read.
    statements: input.spoke.map((id, order) => statement(id, `${order + 1}번째 의견`)),
    chairSummary: input.chairSummary ?? null,
    consensusReached: input.consensusReached ?? null,
  };
}

function meeting(overrides: Partial<WorkspaceMeeting> = {}): WorkspaceMeeting {
  return {
    mode: "fixed-rounds",
    phase: "discussing",
    threadId: null,
    participants: [participant("p1", "Claude"), participant("p2", "Codex")],
    chairParticipantId: null,
    maxRounds: 2,
    userInLoop: false,
    rounds: [],
    pendingQuestion: null,
    answers: [],
    ...overrides,
  };
}

describe("resolveChairParticipantId", () => {
  it("elects the first seat when the person did not fix a chair", () => {
    expect(resolveChairParticipantId(meeting())).toBe(seat("p1"));
  });

  it("honours an explicit chair", () => {
    expect(resolveChairParticipantId(meeting({ chairParticipantId: seat("p2") }))).toBe(seat("p2"));
  });

  it("rejects a chair who is not seated", () => {
    expect(() => resolveChairParticipantId(meeting({ chairParticipantId: seat("ghost") }))).toThrow(
      WorkspaceMeetingError,
    );
  });
});

describe("nextMeetingStep", () => {
  it("opens the first round on a fresh meeting", () => {
    expect(nextMeetingStep(meeting())).toEqual({ kind: "open-round", roundIndex: 0 });
  });

  it("collects only the seats that still owe a statement", () => {
    const step = nextMeetingStep(meeting({ rounds: [round({ index: 0, spoke: ["p1"] })] }));
    expect(step).toEqual({ kind: "collect-statements", roundIndex: 0, speakers: [seat("p2")] });
  });

  it("closes the round once everyone has spoken", () => {
    const step = nextMeetingStep(meeting({ rounds: [round({ index: 0, spoke: ["p1", "p2"] })] }));
    expect(step).toEqual({ kind: "close-round", roundIndex: 0 });
  });

  it("parks on a pending question ahead of any other work", () => {
    const step = nextMeetingStep(
      meeting({
        rounds: [round({ index: 0, spoke: [] })],
        pendingQuestion: {
          askedByParticipantId: seat("p1"),
          question: "예산 상한이 있나요?",
          options: [],
          context: "",
          askedAt: at,
        },
      }),
    );
    expect(step).toEqual({ kind: "awaiting-user" });
  });

  it("hands off once discussion is over", () => {
    expect(nextMeetingStep(meeting({ phase: "executing" }))).toEqual({
      kind: "handoff",
      phase: "executing",
    });
  });

  describe("fixed-rounds", () => {
    it("runs exactly maxRounds and then plans", () => {
      const closed = { spoke: ["p1", "p2"], chairSummary: "정리" };
      const afterFirst = nextMeetingStep(meeting({ rounds: [round({ index: 0, ...closed })] }));
      expect(afterFirst).toEqual({ kind: "open-round", roundIndex: 1 });

      const afterSecond = nextMeetingStep(
        meeting({ rounds: [round({ index: 0, ...closed }), round({ index: 1, ...closed })] }),
      );
      expect(afterSecond).toEqual({ kind: "plan" });
    });

    it("ignores a consensus verdict, which is not its stopping rule", () => {
      const step = nextMeetingStep(
        meeting({
          rounds: [
            round({ index: 0, spoke: ["p1", "p2"], chairSummary: "정리", consensusReached: true }),
          ],
        }),
      );
      expect(step).toEqual({ kind: "open-round", roundIndex: 1 });
    });
  });

  describe("until-consensus", () => {
    it("stops early once the chair reports agreement", () => {
      const step = nextMeetingStep(
        meeting({
          mode: "until-consensus",
          maxRounds: 5,
          rounds: [
            round({ index: 0, spoke: ["p1", "p2"], chairSummary: "합의", consensusReached: true }),
          ],
        }),
      );
      expect(step).toEqual({ kind: "plan" });
    });

    it("keeps going while disagreement remains", () => {
      const step = nextMeetingStep(
        meeting({
          mode: "until-consensus",
          maxRounds: 5,
          rounds: [
            round({ index: 0, spoke: ["p1", "p2"], chairSummary: "이견", consensusReached: false }),
          ],
        }),
      );
      expect(step).toEqual({ kind: "open-round", roundIndex: 1 });
    });

    it("still stops at maxRounds when the seats never converge", () => {
      const unresolved = { spoke: ["p1", "p2"], chairSummary: "이견", consensusReached: false };
      const step = nextMeetingStep(
        meeting({
          mode: "until-consensus",
          maxRounds: 2,
          rounds: [round({ index: 0, ...unresolved }), round({ index: 1, ...unresolved })],
        }),
      );
      expect(step).toEqual({ kind: "plan" });
    });
  });

  describe("userInLoop", () => {
    it("raises the round check-in before opening the next round", () => {
      const step = nextMeetingStep(
        meeting({
          userInLoop: true,
          rounds: [round({ index: 0, spoke: ["p1", "p2"], chairSummary: "정리" })],
        }),
      );
      expect(step).toEqual({
        kind: "ask-round-check-in",
        roundIndex: 0,
        question: roundCheckInQuestion(0),
      });
    });

    it("moves on once that round's check-in is answered", () => {
      const step = nextMeetingStep(
        meeting({
          userInLoop: true,
          rounds: [round({ index: 0, spoke: ["p1", "p2"], chairSummary: "정리" })],
          answers: [{ question: roundCheckInQuestion(0), answer: "계속", answeredAt: at }],
        }),
      );
      expect(step).toEqual({ kind: "open-round", roundIndex: 1 });
    });

    it("does not count an agent's question as the round check-in", () => {
      const step = nextMeetingStep(
        meeting({
          userInLoop: true,
          rounds: [round({ index: 0, spoke: ["p1", "p2"], chairSummary: "정리" })],
          answers: [{ question: "예산 상한이 있나요?", answer: "없음", answeredAt: at }],
        }),
      );
      expect(step).toEqual({
        kind: "ask-round-check-in",
        roundIndex: 0,
        question: roundCheckInQuestion(0),
      });
    });

    it("asks again for the next round", () => {
      const step = nextMeetingStep(
        meeting({
          userInLoop: true,
          maxRounds: 3,
          rounds: [
            round({ index: 0, spoke: ["p1", "p2"], chairSummary: "정리" }),
            round({ index: 1, spoke: ["p1", "p2"], chairSummary: "정리" }),
          ],
          answers: [{ question: roundCheckInQuestion(0), answer: "계속", answeredAt: at }],
        }),
      );
      expect(step).toEqual({
        kind: "ask-round-check-in",
        roundIndex: 1,
        question: roundCheckInQuestion(1),
      });
    });
  });
});

describe("plannedSpeakers", () => {
  it("runs the whole table every round outside free-form", () => {
    expect(plannedSpeakers(meeting(), 1)).toEqual([seat("p1"), seat("p2")]);
  });

  it("opens free-form with everyone, since nobody can be nominated yet", () => {
    expect(plannedSpeakers(meeting({ mode: "free-form" }), 0)).toEqual([seat("p1"), seat("p2")]);
  });

  it("follows the chair's nomination after the opening round", () => {
    const speakers = plannedSpeakers(
      meeting({
        mode: "free-form",
        rounds: [
          round({
            index: 0,
            spoke: ["p1", "p2"],
            chairSummary: "정리 <t3_next_speaker>p2</t3_next_speaker>",
          }),
        ],
      }),
      1,
    );
    expect(speakers).toEqual([seat("p2")]);
  });

  it("falls back to round-robin when the chair nominates nobody", () => {
    const speakers = plannedSpeakers(
      meeting({
        mode: "free-form",
        rounds: [round({ index: 0, spoke: ["p1", "p2"], chairSummary: "정리" })],
      }),
      1,
    );
    expect(speakers).toEqual([seat("p1")]);
  });

  it("falls back when the chair nominates a seat that does not exist", () => {
    const speakers = plannedSpeakers(
      meeting({
        mode: "free-form",
        rounds: [
          round({
            index: 0,
            spoke: ["p1", "p2"],
            chairSummary: "정리 <t3_next_speaker>ghost</t3_next_speaker>",
          }),
        ],
      }),
      1,
    );
    expect(speakers).toEqual([seat("p1")]);
  });
});

describe("parseChairVerdict", () => {
  const wrap = (payload: unknown) =>
    `앞말 <t3_chair_verdict>${JSON.stringify(payload)}</t3_chair_verdict> 뒷말`;

  it("reads the summary, verdict, nomination and question", () => {
    const verdict = parseChairVerdict(
      wrap({
        summary: "두 안이 대립합니다.",
        consensusReached: false,
        nextSpeakerId: "p2",
        question: { question: "어느 쪽?", options: ["A안", "B안"], context: "근거" },
      }),
    );
    expect(verdict).toEqual({
      summary: "두 안이 대립합니다.",
      consensusReached: false,
      nextSpeakerId: seat("p2"),
      question: { question: "어느 쪽?", options: ["A안", "B안"], context: "근거" },
    });
  });

  it("reads a missing consensus verdict as not-yet-agreed rather than agreed", () => {
    const verdict = parseChairVerdict(wrap({ summary: "정리" }));
    expect(verdict.consensusReached).toBeNull();
    expect(verdict.nextSpeakerId).toBeNull();
    expect(verdict.question).toBeNull();
  });

  it("drops a nomination that could not be a seat id", () => {
    expect(
      parseChairVerdict(wrap({ summary: "정리", nextSpeakerId: "  " })).nextSpeakerId,
    ).toBeNull();
    expect(
      parseChairVerdict(wrap({ summary: "정리", nextSpeakerId: "not a seat!" })).nextSpeakerId,
    ).toBeNull();
  });

  it("throws when the payload is absent, empty or malformed", () => {
    expect(() => parseChairVerdict("정리만 했습니다.")).toThrow(WorkspaceMeetingError);
    expect(() => parseChairVerdict("<t3_chair_verdict></t3_chair_verdict>")).toThrow(
      WorkspaceMeetingError,
    );
    expect(() => parseChairVerdict("<t3_chair_verdict>{oops}</t3_chair_verdict>")).toThrow(
      WorkspaceMeetingError,
    );
    expect(() => parseChairVerdict(wrap({ summary: "" }))).toThrow(WorkspaceMeetingError);
    expect(() => parseChairVerdict(wrap({ consensusReached: true }))).toThrow(
      WorkspaceMeetingError,
    );
  });
});

describe("resolveNodeAssignmentRoute", () => {
  const binding = {
    projectId: ProjectId.make("workspace-a"),
    role: "implementer" as const,
    displayName: "코덱스",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-x" },
    runtimeMode: "approval-required" as const,
    interactionMode: "plan" as const,
    instructions: "구현만 담당",
    enabled: true,
    updatedAt: at,
  };

  it("routes a seated node through the roster, ignoring role bindings", () => {
    const route = resolveNodeAssignmentRoute({
      node: { participantId: seat("p2"), role: "implementer" },
      meeting: meeting(),
      bindings: [binding],
    });
    expect(route).toEqual({
      displayName: "Codex",
      modelSelection: { instanceId: ProviderInstanceId.make("p2_instance"), model: "model-x" },
      runtimeMode: "full-access",
      interactionMode: "default",
      instructions: "",
    });
  });

  it("routes an unseated node through the role bindings, as before meetings existed", () => {
    const route = resolveNodeAssignmentRoute({
      node: { participantId: null, role: "implementer" },
      meeting: null,
      bindings: [binding],
    });
    expect(route).toEqual({
      displayName: "코덱스",
      modelSelection: binding.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      instructions: "구현만 담당",
    });
  });

  it("returns null when no enabled binding covers the role", () => {
    expect(
      resolveNodeAssignmentRoute({
        node: { participantId: null, role: "researcher" },
        meeting: null,
        bindings: [binding],
      }),
    ).toBeNull();
    expect(
      resolveNodeAssignmentRoute({
        node: { participantId: null, role: "implementer" },
        meeting: null,
        bindings: [{ ...binding, enabled: false }],
      }),
    ).toBeNull();
  });

  it("returns null when a seated node has lost its meeting", () => {
    expect(
      resolveNodeAssignmentRoute({
        node: { participantId: seat("p2"), role: "implementer" },
        meeting: null,
        bindings: [binding],
      }),
    ).toBeNull();
  });

  it("rejects a node assigned to a seat that is not at the table", () => {
    expect(() =>
      resolveNodeAssignmentRoute({
        node: { participantId: seat("ghost"), role: "implementer" },
        meeting: meeting(),
        bindings: [binding],
      }),
    ).toThrow(WorkspaceMeetingError);
  });
});

describe("renderMeetingTranscript", () => {
  it("is empty before anyone speaks", () => {
    expect(renderMeetingTranscript(meeting())).toBe("");
  });

  it("names the speakers and carries the person's decisions", () => {
    const transcript = renderMeetingTranscript(
      meeting({
        rounds: [round({ index: 0, spoke: ["p1", "p2"], chairSummary: "의장 정리 내용" })],
        answers: [{ question: roundCheckInQuestion(0), answer: "B안으로", answeredAt: at }],
      }),
    );
    expect(transcript).toContain("## 1라운드");
    expect(transcript).toContain("### Claude");
    expect(transcript).toContain("### Codex");
    expect(transcript).toContain("### 의장 정리");
    expect(transcript).toContain("## 사용자 결정");
    expect(transcript).toContain("B안으로");
    // Seat ids stay out of the prose the models read.
    expect(transcript).not.toContain("p1");
  });
});

describe("parseMeetingQuestion", () => {
  it("reads a well-formed question with options and context", () => {
    const output = `동의하지만 확인이 필요하다. <t3_question>${JSON.stringify({
      question: "예산 상한이 있나요?",
      options: ["없음", "100만원"],
      context: "비용이 갈리는 지점",
    })}</t3_question>`;
    expect(parseMeetingQuestion(output)).toEqual({
      question: "예산 상한이 있나요?",
      options: ["없음", "100만원"],
      context: "비용이 갈리는 지점",
    });
  });

  it("tolerates missing options and context", () => {
    expect(parseMeetingQuestion(`<t3_question>{"question":"진행할까요?"}</t3_question>`)).toEqual({
      question: "진행할까요?",
      options: [],
      context: "",
    });
  });

  it("reads a malformed or absent tag as no question", () => {
    expect(parseMeetingQuestion("질문 없는 발언")).toBeNull();
    expect(parseMeetingQuestion("<t3_question>깨진 JSON</t3_question>")).toBeNull();
    expect(parseMeetingQuestion('<t3_question>{"question":""}</t3_question>')).toBeNull();
    expect(parseMeetingQuestion('<t3_question>["질문"]</t3_question>')).toBeNull();
  });

  it("drops non-string options rather than failing the question", () => {
    const parsed = parseMeetingQuestion(
      `<t3_question>${JSON.stringify({ question: "선택은?", options: ["A", 2, "B"] })}</t3_question>`,
    );
    expect(parsed?.options).toEqual(["A", "B"]);
  });
});

describe("parseStatementRespondsTo", () => {
  it("keeps only seated peers, once each", () => {
    const result = parseStatementRespondsTo(
      "반박한다. <t3_responds_to>p2, ghost, p2, p1</t3_responds_to>",
      meeting(),
      seat("p1"),
    );
    expect(result).toEqual([seat("p2")]);
  });

  it("reads an absent tag as arguing with nobody in particular", () => {
    expect(parseStatementRespondsTo("의견", meeting(), seat("p1"))).toEqual([]);
  });
});

describe("meeting prompts", () => {
  const spoken = meeting({
    rounds: [round({ index: 0, spoke: ["p1", "p2"], chairSummary: "1라운드 정리" })],
  });

  it("gives the opening round the workspace corpus and later rounds only the transcript", () => {
    const opening = buildMeetingStatementPrompt({
      workspacePrompt: "Workspace ID: w-1",
      task: "주제",
      meeting: meeting(),
      participantId: seat("p1"),
      roundIndex: 0,
    });
    expect(opening).toContain("Seat: Claude (p1)");
    expect(opening).toContain("## Workspace context");
    expect(opening).toContain("Workspace ID: w-1");
    expect(opening).toContain("<t3_responds_to>");
    expect(opening).toContain("<t3_question>");

    const later = buildMeetingStatementPrompt({
      workspacePrompt: null,
      task: "주제",
      meeting: spoken,
      participantId: seat("p2"),
      roundIndex: 1,
    });
    expect(later).not.toContain("## Workspace context");
    expect(later).toContain("## 1라운드");
    expect(later).toContain("1라운드 정리");
  });

  it("asks the chair for a verdict shaped to the meeting mode", () => {
    const untilConsensus = buildMeetingChairClosePrompt({
      task: "주제",
      meeting: { ...spoken, mode: "until-consensus" },
      roundIndex: 0,
    });
    expect(untilConsensus).toContain("<t3_chair_verdict>");
    expect(untilConsensus).toContain("true only when every seat's stated position");

    const freeForm = buildMeetingChairClosePrompt({
      task: "주제",
      meeting: { ...spoken, mode: "free-form" },
      roundIndex: 0,
    });
    expect(freeForm).toContain("nextSpeakerId: the one seat that should speak next");
    expect(freeForm).toContain("p1, p2");
  });

  it("asks the chair to assign plan nodes to seats, or to stop on a user question", () => {
    const prompt = buildMeetingPlanPrompt({
      workspacePrompt: "Workspace ID: w-1",
      task: "주제",
      meeting: spoken,
    });
    expect(prompt).toContain("Chair: Claude (p1)");
    expect(prompt).toContain("- p1: Claude");
    expect(prompt).toContain('"participantId":seatId');
    expect(prompt).toContain("Do not add validation or synthesis nodes.");
    expect(prompt).toContain("<t3_question>");
  });
});
