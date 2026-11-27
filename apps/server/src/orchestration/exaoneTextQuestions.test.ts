import { describe, expect, it } from "vite-plus/test";
import { matchesExaoneTextQuestions, parseExaoneTextQuestions } from "./exaoneTextQuestions.ts";

const batch = {
  questions: [
    {
      header: "다음 순서",
      question: "무엇부터 할까요?",
      options: [
        { label: "계획", description: "계획 작성" },
        { label: "검사", description: "검사 먼저" },
      ],
    },
    {
      header: "감시",
      question: "무엇을 볼까요?",
      options: [
        { label: "진행", description: "상태" },
        { label: "로그", description: "기록" },
      ],
      multiple: true,
    },
  ],
};
describe("EXAONE text questions", () => {
  it("accepts the reported fenced batch after a question introduction", () => {
    const questions = parseExaoneTextQuestions(
      "질문을 카드로 올립니다.\n\n```json\n" + JSON.stringify(batch) + "\n```",
    );
    expect(questions).toHaveLength(2);
    expect(
      parseExaoneTextQuestions("질문 카드\n```question\n" + JSON.stringify(batch) + "\n```"),
    ).toHaveLength(2);
    expect(questions?.[1]).toMatchObject({
      id: "question-2",
      multiSelect: true,
      options: batch.questions[1]?.options,
    });
  });
  it("preserves all five questions in the reported batch", () => {
    const questions = Array.from({ length: 5 }, (_, index) => ({
      header: "선택 " + (index + 1),
      question: "어느 항목 " + (index + 1) + "?",
      options: [
        { label: "하나", description: "첫 번째" },
        { label: "둘", description: "두 번째" },
      ],
    }));
    const result = parseExaoneTextQuestions(JSON.stringify({ questions }));
    expect(result).toHaveLength(5);
    expect(result?.map((item) => item.question)).toEqual(questions.map((item) => item.question));
  });
  it("only matches the same questions and options, ignoring provider IDs", () => {
    const questions = parseExaoneTextQuestions(JSON.stringify(batch))!;
    const payload = { requestId: "text-question:turn", questions };
    const native = questions.map((question, i) => ({ ...question, id: "native-" + i }));
    expect(matchesExaoneTextQuestions(payload, "text-question:turn", native)).toBe(true);
    expect(matchesExaoneTextQuestions(payload, "text-question:other", native)).toBe(false);
    expect(
      matchesExaoneTextQuestions(payload, "text-question:turn", [
        { ...native[0]!, question: "다른 질문" },
        native[1]!,
      ]),
    ).toBe(false);
    expect(
      matchesExaoneTextQuestions(payload, "text-question:turn", [
        native[0]!,
        { ...native[1]!, multiSelect: false },
      ]),
    ).toBe(false);
  });
  it("accepts an entire JSON response and rejects incomplete or unrelated examples", () => {
    expect(parseExaoneTextQuestions(JSON.stringify(batch))).toHaveLength(2);
    expect(parseExaoneTextQuestions(JSON.stringify(batch).slice(0, -1))).toBeNull();
    expect(
      parseExaoneTextQuestions("설정 예시입니다.\n```json\n" + JSON.stringify(batch) + "\n```"),
    ).toBeNull();
    expect(
      parseExaoneTextQuestions(
        "질문 데이터 형식 예시입니다.\n```question\n" + JSON.stringify(batch) + "\n```",
      ),
    ).toBeNull();
    expect(
      parseExaoneTextQuestions(
        JSON.stringify({ questions: [{ header: "x", question: "y", options: "bad" }] }),
      ),
    ).toBeNull();
  });
  it("accepts options without a description by normalizing to an empty string", () => {
    const result = parseExaoneTextQuestions(
      JSON.stringify({
        questions: [
          {
            header: "방향",
            question: "어떻게 진행할까요?",
            options: [{ label: "계속 진행" }, { label: "중단", description: "여기서 종료" }],
          },
        ],
      }),
    );
    expect(result).toEqual([
      {
        id: "question-1",
        header: "방향",
        question: "어떻게 진행할까요?",
        options: [
          { label: "계속 진행", description: "" },
          { label: "중단", description: "여기서 종료" },
        ],
      },
    ]);
  });
});
