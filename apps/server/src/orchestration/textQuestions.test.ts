import { describe, expect, it } from "vite-plus/test";
import { parseExaoneTextQuestions } from "./exaoneTextQuestions.ts";
import {
  ANTIGRAVITY_QUESTION_INSTRUCTIONS,
  ANTIGRAVITY_QUESTION_INTRO,
  asksThroughText,
  isTextQuestionTurn,
  parseListTextQuestions,
  parseTextQuestions,
  textQuestionInstructions,
  textQuestionSummary,
} from "./textQuestions.ts";

const batch = {
  questions: [
    {
      header: "PowerShell",
      question: "PowerShell 영구 지침을 어떻게 처리할까요?",
      options: [
        { label: "조건부 예외 (권장)", description: "Antigravity만 허용" },
        { label: "전면 유지", description: "금지 유지" },
      ],
    },
  ],
};
const block = "```json\n" + JSON.stringify(batch) + "\n```";

const reportedExample = [
  "PowerShell 영구 지침을 어떻게 처리할까요?",
  "",
  "- [1] (권장) 조건부 예외로 조정: Codex·Claude는 PowerShell 금지 유지, 셸이 PowerShell로 고정된 Antigravity(Gemini)만 cmd /c·python·git 호출 용도로 허용",
  "- [2] 전면 유지: PowerShell 절대 금지 유지 (Antigravity는 파일 읽기·설계 위주로 쓰거나 CMD 하위 위임만 사용)",
  "- [3] 이번 대화·임시 작업에서만 Antigravity의 run_command 허용 (영구 지침과 공용 RAG는 수정하지 않음)",
  "- [4] 전면 해제: PowerShell 영구 금지 지침 자체를 폐기",
].join("\n");

describe("text question gate", () => {
  it("covers every Antigravity model and only the EXAONE models of OpenCode", () => {
    expect(isTextQuestionTurn("gemini", "auto")).toBe(true);
    expect(isTextQuestionTurn("gemini", undefined)).toBe(true);
    expect(isTextQuestionTurn("opencode", "t3_exaone/k-exaone_v2.5")).toBe(true);
    expect(isTextQuestionTurn("opencode", "t3_antseed/deepseek-v4.1-flash")).toBe(false);
    expect(isTextQuestionTurn("opencode", undefined)).toBe(false);
    for (const provider of ["codex", "claudeAgent", "cursor", "grok", undefined, null]) {
      expect(isTextQuestionTurn(provider, "t3_exaone/k-exaone_v2.5")).toBe(false);
      expect(asksThroughText(provider)).toBe(false);
    }
    expect(asksThroughText("opencode")).toBe(true);
    expect(asksThroughText("gemini")).toBe(true);
    expect(textQuestionSummary("gemini")).toBe("Antigravity 질문");
    expect(textQuestionSummary("opencode")).toBe("EXAONE 질문");
  });
});

describe("Antigravity question instructions", () => {
  it("are given to Antigravity only", () => {
    expect(textQuestionInstructions("gemini")).toBe(ANTIGRAVITY_QUESTION_INSTRUCTIONS);
    for (const driver of ["codex", "claudeAgent", "opencode", "cursor", "grok", undefined, null])
      expect(textQuestionInstructions(driver)).toBeUndefined();
  });
  it("describe a block the parser accepts and avoid the words that reject one", () => {
    expect(ANTIGRAVITY_QUESTION_INSTRUCTIONS).not.toMatch(
      /(?:예시|샘플|스키마|example|schema|sample|quoted)/iu,
    );
    expect(ANTIGRAVITY_QUESTION_INSTRUCTIONS).toContain(ANTIGRAVITY_QUESTION_INTRO);
    const shape = /```json\n(.+)\n```/u.exec(ANTIGRAVITY_QUESTION_INSTRUCTIONS)?.[1];
    expect(shape).toBeDefined();
    expect(
      parseExaoneTextQuestions(ANTIGRAVITY_QUESTION_INTRO + "\n\n```json\n" + shape + "\n```"),
    ).toEqual([
      {
        id: "question-1",
        header: "짧은 제목",
        question: "질문 문장",
        options: [{ label: "선택지 이름", description: "한 줄 설명" }],
      },
    ]);
  });
  it("still open a card when the model repeats the instructions' own wording before its question", () => {
    const echoed = ANTIGRAVITY_QUESTION_INSTRUCTIONS.split("\n")[0]!;
    expect(
      parseTextQuestions("gemini", echoed + "\n\n" + ANTIGRAVITY_QUESTION_INTRO + "\n\n" + block),
    ).toHaveLength(1);
  });
});

describe("parseTextQuestions", () => {
  it("reads the instructed block for Antigravity", () => {
    const answer = "확인을 마쳤습니다.\n\n" + ANTIGRAVITY_QUESTION_INTRO + "\n\n" + block;
    expect(parseTextQuestions("gemini", answer)).toEqual([
      {
        id: "question-1",
        header: "PowerShell",
        question: "PowerShell 영구 지침을 어떻게 처리할까요?",
        options: batch.questions[0]!.options,
      },
    ]);
  });
  it("keeps multiple-choice questions", () => {
    const multiple = { questions: [{ ...batch.questions[0]!, multiple: true }] };
    const answer =
      ANTIGRAVITY_QUESTION_INTRO + "\n\n```json\n" + JSON.stringify(multiple) + "\n```";
    expect(parseTextQuestions("gemini", answer)?.[0]).toMatchObject({ multiSelect: true });
  });
  it("is not hidden by words in the answer above the introduction sentence", () => {
    const answer =
      "DB schema 변경 예시를 검토했습니다.\n\n" + ANTIGRAVITY_QUESTION_INTRO + "\n\n" + block;
    expect(parseExaoneTextQuestions(answer)).toBeNull();
    expect(parseTextQuestions("gemini", answer)).toHaveLength(1);
    expect(parseTextQuestions("opencode", answer)).toBeNull();
  });
  it("leaves a demonstrated block alone", () => {
    expect(parseTextQuestions("gemini", "질문 블록 예시입니다.\n\n" + block)).toBeNull();
    expect(
      parseTextQuestions(
        "gemini",
        ANTIGRAVITY_QUESTION_INTRO + "\n\n" + block + "\n\n이어서 진행합니다.",
      ),
    ).toBeNull();
  });
  it("gives every text-question provider the same result as the batch parser", () => {
    const answer = "질문을 카드로 올립니다.\n\n" + block;
    expect(parseTextQuestions("opencode", answer)).toEqual(parseExaoneTextQuestions(answer));
    expect(parseTextQuestions("gemini", answer)).toEqual(parseExaoneTextQuestions(answer));
  });
  it("reads the prose list only for Antigravity and only without a block", () => {
    expect(parseTextQuestions("gemini", reportedExample)).toHaveLength(1);
    expect(parseTextQuestions("opencode", reportedExample)).toBeNull();
    const both = reportedExample + "\n\n" + ANTIGRAVITY_QUESTION_INTRO + "\n\n" + block;
    expect(parseTextQuestions("gemini", both)?.[0]?.header).toBe("PowerShell");
  });
  it("reads bare JSON after the Antigravity intro or question paragraph without code fences", () => {
    const bareJson = JSON.stringify(batch);
    expect(
      parseTextQuestions(
        "gemini",
        "분석을 마쳤습니다.\n\n" + ANTIGRAVITY_QUESTION_INTRO + "\n\n" + bareJson,
      ),
    ).toHaveLength(1);
    expect(parseTextQuestions("gemini", "방향을 선택해 주세요.\n\n" + bareJson)).toHaveLength(1);
    expect(parseTextQuestions("gemini", "질문 블록 예시입니다.\n\n" + bareJson)).toBeNull();
  });
  it("tolerates a trailing global-contract closing heading section after the Antigravity question block", () => {
    const withTrailingAdvice =
      "## [보고]\n해부 준비를 마쳤어요.\n\n" +
      ANTIGRAVITY_QUESTION_INTRO +
      "\n\n" +
      block +
      "\n\n## [비서실장의 조언]\n앞 기간에서만 해부하고 미공개 구간은 1회만 채점하세요.";
    expect(parseTextQuestions("gemini", withTrailingAdvice)).toHaveLength(1);
    expect(parseTextQuestions("opencode", withTrailingAdvice)).toBeNull();
  });
  it("is not hidden by earlier sample/example words when using a short card intro line", () => {
    const withShortIntro =
      "샘플 142건과 예시 종목을 확인했습니다.\n\n아래 카드에서 선택해 주세요.\n\n" + block;
    expect(parseTextQuestions("gemini", withShortIntro)).toHaveLength(1);
  });
  it("tolerates a stray tokenizer suffix glued to the closing fence (e.g. ```Ble from gemini-4-neon)", () => {
    const realReport = [
      "## [비서실장의 조언]",
      "DB 전용 스레드의 3단 종료 순서와 스레드당 커넥션 1개 전담 구조까지 확인해 보신 뒤, 아래 카드에서 바로 구현에 들어갈지 수정할 부분이 있는지 선택해 주세요.",
      "",
      ANTIGRAVITY_QUESTION_INTRO,
      "",
      "```json",
      JSON.stringify({
        questions: [
          {
            header: "DB 전용 스레드 설계 승인",
            question: "설계대로 바로 구현을 시작할까요?",
            options: [
              { label: "설계 확정 — Phase 2 바로 구현 착수 (권장)", description: "바로 구현 진행" },
              { label: "세부 조정 먼저", description: "워커 수·큐 정책 조정" },
            ],
          },
        ],
      }),
      "```Ble",
    ].join("\n");
    const parsed = parseTextQuestions("gemini", realReport);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.header).toBe("DB 전용 스레드 설계 승인");
    // Unclosed trailing fence after intro also parses cleanly when JSON itself is complete
    const unclosed = [ANTIGRAVITY_QUESTION_INTRO, "", "```json", JSON.stringify(batch)].join("\n");
    expect(parseTextQuestions("gemini", unclosed)).toHaveLength(1);
    // Real trailing prose on a new line must still be rejected
    expect(
      parseTextQuestions(
        "gemini",
        ANTIGRAVITY_QUESTION_INTRO + "\n\n" + block + "\n\n계속 진행합니다.",
      ),
    ).toBeNull();
  });
});

describe("parseListTextQuestions", () => {
  it("turns the reported Antigravity question into one card", () => {
    expect(parseListTextQuestions("지침을 확인했습니다.\n\n" + reportedExample + "\n")).toEqual([
      {
        id: "question-1",
        header: "선택",
        question: "PowerShell 영구 지침을 어떻게 처리할까요?",
        options: [
          {
            label: "(권장) 조건부 예외로 조정",
            description:
              "Codex·Claude는 PowerShell 금지 유지, 셸이 PowerShell로 고정된 Antigravity(Gemini)만 cmd /c·python·git 호출 용도로 허용",
          },
          {
            label: "전면 유지",
            description:
              "PowerShell 절대 금지 유지 (Antigravity는 파일 읽기·설계 위주로 쓰거나 CMD 하위 위임만 사용)",
          },
          {
            label:
              "이번 대화·임시 작업에서만 Antigravity의 run_command 허용 (영구 지침과 공용 RAG는 수정하지 않음)",
            description: "",
          },
          { label: "전면 해제", description: "PowerShell 영구 금지 지침 자체를 폐기" },
        ],
      },
    ]);
  });
  it("accepts bare markers, a heading question and a request to choose", () => {
    expect(
      parseListTextQuestions(
        "## **어느 쪽으로 진행할까요?**\n[1] **빠른 수정** — 한 파일만\n[2] 전체 정리",
      ),
    ).toEqual([
      {
        id: "question-1",
        header: "선택",
        question: "어느 쪽으로 진행할까요?",
        options: [
          { label: "빠른 수정", description: "한 파일만" },
          { label: "전체 정리", description: "" },
        ],
      },
    ]);
    expect(
      parseListTextQuestions("진행 방식을 선택해 주세요.\n\n* [1] 지금 적용\n\n* [2] 나중에 적용"),
    ).toHaveLength(1);
  });
  it("does not split on a colon inside a path, time or address", () => {
    expect(
      parseListTextQuestions(
        "어디에 저장할까요?\n- [1] C:\\work\\out\n- [2] https://example.org/a 12:30 기준",
      ),
    ).toMatchObject([
      {
        options: [
          { label: "C:\\work\\out", description: "" },
          { label: "https://example.org/a 12:30 기준", description: "" },
        ],
      },
    ]);
  });
  it("ignores a numbered task list in a final report", () => {
    expect(
      parseListTextQuestions(
        "완료한 작업은 다음과 같습니다.\n\n- [1] 파서 추가\n- [2] 테스트 추가\n- [3] 문서 갱신",
      ),
    ).toBeNull();
    expect(
      parseListTextQuestions("다음 순서로 진행했습니다:\n1. 조사\n2. 구현\n3. 검증"),
    ).toBeNull();
    expect(parseListTextQuestions("어떻게 할까요?\n1. 조사\n2. 구현")).toBeNull();
    expect(parseListTextQuestions("할 일?\n- [ ] 조사\n- [x] 구현")).toBeNull();
  });
  it("ignores a list that is followed by more prose", () => {
    expect(
      parseListTextQuestions(reportedExample + "\n\n답을 주시면 바로 반영하겠습니다."),
    ).toBeNull();
  });
  it("ignores quoted, fenced and demonstrated lists", () => {
    const quoted = reportedExample
      .split("\n")
      .map((line) => "> " + line)
      .join("\n");
    expect(parseListTextQuestions("이전 답변을 인용합니다.\n\n" + quoted)).toBeNull();
    expect(parseListTextQuestions("```text\n" + reportedExample)).toBeNull();
    expect(parseListTextQuestions("```text\n" + reportedExample + "\n```")).toBeNull();
    expect(
      parseListTextQuestions("질문은 예를 들어 이렇게 씁니다.\n" + reportedExample),
    ).toBeNull();
    expect(parseListTextQuestions("예시: 어떻게 할까요?\n- [1] 하나\n- [2] 둘")).toBeNull();
    expect(
      parseListTextQuestions(
        "출처를 더 볼까요?\n[1] https://example.org/a\n[2] https://example.org/b",
      ),
    ).toBeNull();
  });
  it("requires two to eight options numbered from one in order, with distinct labels", () => {
    const list = (numbers: ReadonlyArray<number>) =>
      "어떻게 할까요?\n" + numbers.map((number) => `- [${number}] 선택 ${number}`).join("\n");
    expect(parseListTextQuestions(list([1]))).toBeNull();
    expect(parseListTextQuestions(list([1, 2]))).toHaveLength(1);
    expect(parseListTextQuestions(list([1, 2, 3, 4, 5, 6, 7, 8]))).toHaveLength(1);
    expect(parseListTextQuestions(list([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
    expect(parseListTextQuestions(list([2, 3]))).toBeNull();
    expect(parseListTextQuestions(list([1, 3]))).toBeNull();
    expect(parseListTextQuestions(list([2, 1]))).toBeNull();
    expect(parseListTextQuestions("어떻게 할까요?\n- [1] 같음\n- [2] 같음")).toBeNull();
    expect(parseListTextQuestions("- [1] 하나\n- [2] 둘")).toBeNull();
    expect(parseListTextQuestions("")).toBeNull();
  });
});
