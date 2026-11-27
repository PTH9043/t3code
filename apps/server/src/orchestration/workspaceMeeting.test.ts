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
import { contextArtifactHash } from "./workspaceContextArtifacts.ts";
import { renderCompactMeetingContext } from "./workspaceMeetingContext.ts";

import {
  buildMeetingChairClosePrompt,
  buildMeetingPlanPrompt,
  buildMeetingStatementPrompt,
  meetingWrapUpQuestion,
  nextMeetingStep,
  parseChairVerdict,
  isNodeInterventionQuestion,
  isProviderContentRefusal,
  nodeInterventionQuestion,
  nodeRefusalQuestion,
  parseNodeInterventionDecision,
  parseNodeRefusalDecision,
  parseWrapUpDecision,
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
    interjections: [],
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

it("passes user-assigned supervisor and worker roles into the meeting prompts", () => {
  const configured = meeting({
    participants: [
      { ...participant("p1", "Supervisor"), roleDescription: "개발 방향 결정" },
      { ...participant("p2", "Worker"), roleDescription: "검증 담당" },
    ],
    chairParticipantId: seat("p1"),
  });
  const plan = buildMeetingPlanPrompt({
    task: "기능 구현",
    workspacePrompt: "",
    meeting: configured,
  });
  expect(plan).toContain("개발 방향 결정");
  expect(plan).toContain("검증 담당");
  expect(plan).toContain("work outside their usual role");
  const statement = buildMeetingStatementPrompt({
    task: "기능 구현",
    workspacePrompt: "",
    meeting: configured,
    participantId: seat("p2"),
    roundIndex: 0,
  });
  expect(statement).toContain("사용자가 지정한 역할: 검증 담당");
});

describe("nextMeetingStep", () => {
  it("opens the first round on a fresh meeting", () => {
    expect(nextMeetingStep(meeting())).toEqual({ kind: "open-round", roundIndex: 0 });
  });

  it("plans immediately when zero rounds make it a direct collaboration", () => {
    expect(nextMeetingStep(meeting({ maxRounds: 0 }))).toEqual({ kind: "plan" });
  });

  it("still parks a direct collaboration on a pending question", () => {
    const step = nextMeetingStep(
      meeting({
        maxRounds: 0,
        pendingQuestion: {
          askedByParticipantId: seat("p1"),
          question: "범위를 정해줄래요?",
          options: [],
          context: "",
          askedAt: "2026-08-18T00:00:00.000Z",
          nodeId: null,
        },
      }),
    );
    expect(step).toEqual({ kind: "awaiting-user" });
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
          nodeId: null,
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
    it("runs exactly maxRounds and then asks the person what happens next", () => {
      const closed = { spoke: ["p1", "p2"], chairSummary: "정리" };
      const afterFirst = nextMeetingStep(meeting({ rounds: [round({ index: 0, ...closed })] }));
      expect(afterFirst).toEqual({ kind: "open-round", roundIndex: 1 });

      const afterSecond = nextMeetingStep(
        meeting({ rounds: [round({ index: 0, ...closed }), round({ index: 1, ...closed })] }),
      );
      expect(afterSecond).toEqual({ kind: "ask-wrap-up", question: meetingWrapUpQuestion(2) });
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
    it("stops early once the chair reports agreement and asks the person", () => {
      const step = nextMeetingStep(
        meeting({
          mode: "until-consensus",
          maxRounds: 5,
          rounds: [
            round({ index: 0, spoke: ["p1", "p2"], chairSummary: "합의", consensusReached: true }),
          ],
        }),
      );
      expect(step).toEqual({ kind: "ask-wrap-up", question: meetingWrapUpQuestion(1) });
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
      expect(step).toEqual({ kind: "ask-wrap-up", question: meetingWrapUpQuestion(2) });
    });
  });

  describe("wrap-up gate", () => {
    const closed = { spoke: ["p1", "p2"], chairSummary: "정리" };
    const spentRounds = [round({ index: 0, ...closed }), round({ index: 1, ...closed })];
    const answered = (answer: string) =>
      meeting({
        rounds: spentRounds,
        answers: [{ question: meetingWrapUpQuestion(2), answer, answeredAt: at, nodeId: null }],
      });

    it("plans once the person says to execute", () => {
      expect(nextMeetingStep(answered("합의대로 실행 시작"))).toEqual({ kind: "plan" });
    });

    it("treats free text without a stop or more-rounds intent as an execute steer", () => {
      expect(nextMeetingStep(answered("배포 파트는 빼고 진행해줘"))).toEqual({ kind: "plan" });
    });

    it("concludes without execution when the person stops here", () => {
      expect(nextMeetingStep(answered("여기서 종료 (실행 없음)"))).toEqual({ kind: "conclude" });
    });

    it("reopens discussion when the person grants more rounds", () => {
      expect(nextMeetingStep(answered("라운드 1회 추가"))).toEqual({
        kind: "open-round",
        roundIndex: 2,
      });
    });

    it("asks again with a fresh key once the granted rounds are spent", () => {
      const step = nextMeetingStep(
        meeting({
          rounds: [...spentRounds, round({ index: 2, ...closed })],
          answers: [
            {
              question: meetingWrapUpQuestion(2),
              answer: "라운드 1회 추가",
              answeredAt: at,
              nodeId: null,
            },
          ],
        }),
      );
      expect(step).toEqual({ kind: "ask-wrap-up", question: meetingWrapUpQuestion(3) });
    });

    it("grants rounds past an early consensus in until-consensus mode", () => {
      const step = nextMeetingStep(
        meeting({
          mode: "until-consensus",
          maxRounds: 5,
          rounds: [
            round({ index: 0, spoke: ["p1", "p2"], chairSummary: "합의", consensusReached: true }),
          ],
          answers: [
            {
              question: meetingWrapUpQuestion(1),
              answer: "2라운드 더 해",
              answeredAt: at,
              nodeId: null,
            },
          ],
        }),
      );
      expect(step).toEqual({ kind: "open-round", roundIndex: 1 });
    });

    it("does not gate a zero-round direct collaboration", () => {
      expect(nextMeetingStep(meeting({ maxRounds: 0 }))).toEqual({ kind: "plan" });
    });
  });

  describe("parseWrapUpDecision", () => {
    it("maps the canonical options", () => {
      expect(parseWrapUpDecision("합의대로 실행 시작")).toEqual({ kind: "execute" });
      expect(parseWrapUpDecision("라운드 1회 추가")).toEqual({ kind: "more-rounds", count: 1 });
      expect(parseWrapUpDecision("여기서 종료 (실행 없음)")).toEqual({ kind: "conclude" });
    });

    it("requires an explicit action for safety refusals", () => {
      expect(parseNodeRefusalDecision("다시 시도")).toEqual({ kind: "retry" });
      expect(parseNodeRefusalDecision("재시도해줘")).toEqual({ kind: "retry" });
      expect(parseNodeRefusalDecision("이 단계 건너뛰고 계속")).toEqual({ kind: "skip" });
      expect(parseNodeRefusalDecision("여기서 종료")).toEqual({ kind: "stop" });
      expect(parseNodeRefusalDecision("중지해줘")).toEqual({ kind: "stop" });
      expect(parseNodeRefusalDecision("재시도하지 말고 다른 일을 계속해")).toBeNull();
      expect(parseNodeRefusalDecision("건너뛰지 마")).toBeNull();
      expect(parseNodeRefusalDecision("다른 모델에게 맡겨")).toBeNull();
      expect(parseNodeRefusalDecision("계속해")).toBeNull();
    });

    it("reads a round count out of free text", () => {
      expect(parseWrapUpDecision("3라운드 더 진행해")).toEqual({ kind: "more-rounds", count: 3 });
      expect(parseWrapUpDecision("회의를 더 하자")).toEqual({ kind: "more-rounds", count: 1 });
    });

    it("reads stop intent out of free text", () => {
      expect(parseWrapUpDecision("그만하고 정리만 해줘")).toEqual({ kind: "conclude" });
      expect(parseWrapUpDecision("실행은 하지 마")).toEqual({ kind: "conclude" });
    });

    it("defaults free text to executing with the answer as a steer", () => {
      expect(parseWrapUpDecision("결론대로 가되 문서는 한 개만 써")).toEqual({ kind: "execute" });
    });
  });

  describe("node intervention", () => {
    it("recognizes its own question and nothing else", () => {
      expect(isNodeInterventionQuestion(nodeInterventionQuestion("DOM-03 주문 도메인"))).toBe(true);
      expect(isNodeInterventionQuestion(meetingWrapUpQuestion(2))).toBe(false);
      expect(isNodeInterventionQuestion("이 단계 어떻게 할까요?")).toBe(false);
    });

    it("maps the canonical options", () => {
      expect(parseNodeInterventionDecision("다른 좌석에게 맡기기")).toEqual({ kind: "reassign" });
      expect(parseNodeInterventionDecision("다시 시도")).toEqual({ kind: "retry" });
      expect(parseNodeInterventionDecision("이 단계 건너뛰고 계속")).toEqual({ kind: "skip" });
      expect(parseNodeInterventionDecision("여기서 종료")).toEqual({ kind: "stop" });
    });

    it("recognizes a provider refusal and its question", () => {
      expect(
        isProviderContentRefusal(
          "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber",
        ),
      ).toBe(true);
      expect(isProviderContentRefusal("Missing <t3_validation> JSON payload.")).toBe(false);
      expect(isProviderContentRefusal("Your message was flagged by Claude's safeguards.")).toBe(
        true,
      );
      expect(
        isProviderContentRefusal(
          "API Error: Opus 5.5's safeguards flagged this session (https://www.anthropic.com/legal/aup). Details: `[cyber]`",
        ),
      ).toBe(true);
      expect(
        isProviderContentRefusal(
          "Opus 5.5's safeguards stopped the response above · continuing once with that noted",
        ),
      ).toBe(false);
      expect(isProviderContentRefusal("model_refusal_no_fallback")).toBe(true);
      expect(isProviderContentRefusal("HTTP 429 Too Many Requests")).toBe(false);
      expect(isNodeInterventionQuestion(nodeRefusalQuestion("Codex 교차 검증"))).toBe(true);
    });

    it("does not interpret a prohibition on changing models as a reassignment", () => {
      expect(parseNodeInterventionDecision("다른 모델로 바꾸지 말고 다시 시도해")).toEqual({
        kind: "retry",
      });
      expect(parseNodeInterventionDecision("다른 계정은 사용하지 마").kind).not.toBe("reassign");
    });

    it("reads skip and stop intent out of free text", () => {
      expect(parseNodeInterventionDecision("그건 스킵하고 다음으로 가")).toEqual({ kind: "skip" });
      expect(parseNodeInterventionDecision("그만하자")).toEqual({ kind: "stop" });
    });

    it("keeps the work by defaulting free text to a retry", () => {
      expect(parseNodeInterventionDecision("경로를 바꿔서 다시 해봐")).toEqual({ kind: "retry" });
      expect(parseNodeInterventionDecision("이번엔 파일을 직접 읽고 진행해")).toEqual({
        kind: "retry",
      });
    });

    it("treats an explicit retry as a retry even when it mentions stopping", () => {
      expect(parseNodeInterventionDecision("중단하지 말고 다시 시도해")).toEqual({ kind: "retry" });
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
          answers: [
            { question: roundCheckInQuestion(0), answer: "계속", answeredAt: at, nodeId: null },
          ],
        }),
      );
      expect(step).toEqual({ kind: "open-round", roundIndex: 1 });
    });

    it("does not count an agent's question as the round check-in", () => {
      const step = nextMeetingStep(
        meeting({
          userInLoop: true,
          rounds: [round({ index: 0, spoke: ["p1", "p2"], chairSummary: "정리" })],
          answers: [
            { question: "예산 상한이 있나요?", answer: "없음", answeredAt: at, nodeId: null },
          ],
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
          answers: [
            { question: roundCheckInQuestion(0), answer: "계속", answeredAt: at, nodeId: null },
          ],
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
  it("routes two models of the same account by participant id with independent effort", () => {
    const participants = ["low", "high"].map((effort, index) => ({
      id: seat(`worker-${index}`),
      displayName: "Codex",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: `model-${index}`,
        options: [{ id: "reasoningEffort", value: effort }],
      },
    }));
    const configured = meeting({
      participants,
      chairParticipantId: participants[1]!.id,
      allowAdditionalWorkers: false,
    });
    for (const selected of participants) {
      expect(
        resolveNodeAssignmentRoute({
          node: { participantId: selected.id, role: "implementer" },
          meeting: configured,
          bindings: [],
        })?.modelSelection,
      ).toEqual(selected.modelSelection);
    }
    expect(resolveChairParticipantId(configured)).toBe(participants[1]!.id);
  });

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
        answers: [
          { question: roundCheckInQuestion(0), answer: "B안으로", answeredAt: at, nodeId: null },
        ],
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

  it("includes attached image references in the model transcript while keeping the decision text separate", () => {
    const answer = {
      question: "계속할까요?",
      answer: "건너뛰기",
      answeredAt: at,
      nodeId: null,
      imageReferences: [{ name: "stop.png", path: "D:/attachments/stop.png" }],
    };
    const transcript = renderMeetingTranscript(meeting({ answers: [answer] }));
    expect(transcript).toContain("답변: 건너뛰기");
    expect(transcript).toContain("D:/attachments/stop.png");
    expect(parseNodeInterventionDecision(answer.answer)).toEqual({ kind: "skip" });
  });

  it("weaves the person's interjections into the order they arrived", () => {
    const transcript = renderMeetingTranscript(
      meeting({
        rounds: [round({ index: 0, spoke: ["p1", "p2"] })],
        interjections: [
          { text: "시작 전 당부", roundIndex: 0, afterStatements: 0, saidAt: at },
          { text: "첫 발언에 대한 이견", roundIndex: 0, afterStatements: 1, saidAt: at },
        ],
      }),
    );
    const order = [
      transcript.indexOf("시작 전 당부"),
      transcript.indexOf("1번째 의견"),
      transcript.indexOf("첫 발언에 대한 이견"),
      transcript.indexOf("2번째 의견"),
    ];
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(transcript).toContain("### 사용자 (개입)");
  });

  it("keeps an interjection whose round never opened", () => {
    const transcript = renderMeetingTranscript(
      meeting({
        interjections: [{ text: "라운드 전 당부", roundIndex: 0, afterStatements: 0, saidAt: at }],
      }),
    );
    expect(transcript).toContain("## 사용자 개입");
    expect(transcript).toContain("라운드 전 당부");
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
  it("never clips an old user interjection or a current-round tail when context exceeds its target", () => {
    const longMeeting = meeting({
      rounds: [
        {
          ...round({ index: 0, spoke: ["p1"] }),
          statements: [statement("p1", "evidence ".repeat(9000) + "TAIL")],
        },
      ],
      interjections: [
        { roundIndex: 0, afterStatements: 0, text: "OLD MANDATORY RULE", saidAt: at },
      ],
    });
    const prompt = buildMeetingStatementPrompt({
      workspacePrompt: null,
      task: "topic",
      meeting: longMeeting,
      participantId: seat("p2"),
      roundIndex: 0,
    });
    expect(prompt).toContain("OLD MANDATORY RULE");
    expect(prompt).toContain("TAIL");
  });
  it("uses exact covered text from a closed summary and keeps dissent and current statements", () => {
    const covered = "agreed implementation evidence ".repeat(100);
    const input = meeting({
      rounds: [
        {
          index: 0,
          chairSummary: covered,
          consensusReached: true,
          statements: [
            statement("p1", covered),
            { ...statement("p2", "아직 반대하며 검증은 미완료"), respondsTo: [seat("p1")] },
          ],
        },
        {
          index: 1,
          chairSummary: null,
          consensusReached: null,
          statements: [statement("p1", "현재 라운드의 전체 원문")],
        },
      ],
    });
    const original = renderMeetingTranscript(input);
    const source = {
      path: "D:/isolated/meeting.txt",
      sha256: contextArtifactHash(original),
      chars: original.length,
    };
    const compact = renderCompactMeetingContext(input, source);
    expect(compact.length).toBeLessThan(original.length);
    expect(compact.split(covered)).toHaveLength(2);
    expect(compact).toContain("아직 반대하며 검증은 미완료");
    expect(compact).toContain("현재 라운드의 전체 원문");
    expect(renderCompactMeetingContext(input, { ...source, sha256: "stale" })).toBe(original);
  });
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

  it("preserves the requested work without instructing the chair to evade refusals", () => {
    const task = "지정된 보안 연구 범위의 계약을 분석하고 재현 근거를 기록하세요.";
    const prompt = buildMeetingPlanPrompt({ workspacePrompt: "", task, meeting: spoken });
    expect(prompt).toContain(task);
    expect(prompt).toContain("Do not change the task description to evade");
    expect(prompt).toContain("report a refusal and continue independent permitted work");
    expect(prompt).not.toContain("providers refuse such requests on policy");
  });
});

it("prioritizes conductor clarification and its pending question even with zero rounds", () => {
  expect(nextMeetingStep(meeting({ phase: "clarifying", maxRounds: 0 }))).toEqual({
    kind: "clarify",
  });
  expect(
    nextMeetingStep(
      meeting({
        phase: "clarifying",
        maxRounds: 0,
        pendingQuestion: {
          question: "범위?",
          options: [],
          context: "",
          askedAt: at,
          nodeId: null,
          askedByParticipantId: seat("p2"),
        },
      }),
    ),
  ).toEqual({ kind: "awaiting-user" });
});

for (const runtimeMode of [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const) {
  it(`keeps the app-selected ${runtimeMode} policy for seated orchestra work`, () => {
    const selected = { ...meeting(), runtimeMode, interactionMode: "plan" as const };
    const route = resolveNodeAssignmentRoute({
      node: { participantId: seat("p2"), role: "researcher" },
      meeting: selected,
      bindings: [],
    });
    expect(route?.runtimeMode).toBe(runtimeMode);
    expect(route?.interactionMode).toBe("plan");
  });
}

it("does not route an unassigned meeting node to a model outside the selected roster", () => {
  const route = resolveNodeAssignmentRoute({
    node: { participantId: null, role: "researcher" },
    meeting: meeting({ runtimeMode: "full-access", interactionMode: "plan" }),
    bindings: [
      {
        projectId: ProjectId.make("workspace-a"),
        role: "researcher",
        displayName: "Grok",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-test" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        instructions: "research",
        enabled: true,
        updatedAt: at,
      },
    ],
  });
  expect(route).toBeNull();
});
