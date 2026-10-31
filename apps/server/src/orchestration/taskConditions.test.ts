import { describe, expect, it } from "vite-plus/test";
import { ApprovedTaskConditions } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { taskConditionsError } from "./taskConditions.ts";

const isApprovedTaskConditions = Schema.is(ApprovedTaskConditions);

const conditions: ApprovedTaskConditions = {
  version: 1,
  approvedByUser: true,
  sourceText: "조회해 줘",
  goal: "실행 프로세스 조회",
  scope: "사용자 앱",
  criteria: "현재 사용량",
  approach: "조회 후 분석",
  restrictions: "변경 금지",
  completion: "조회 결과 검증",
  output: "표",
  mode: "inspect",
  additionalActions: [],
};

describe("task conditions server validation", () => {
  it("rejects missing, stale, or contradictory approval", () => {
    expect(
      taskConditionsError({ requireTaskConditions: true, message: { text: "조회해 줘" } }),
    ).toContain("승인 전");
    expect(
      taskConditionsError({ taskConditions: conditions, message: { text: "새 요청" } }),
    ).toContain("달라졌습니다");
    expect(
      taskConditionsError({
        taskConditions: { ...conditions, additionalActions: ["delete"] },
        message: { text: "조회해 줘" },
      }),
    ).toContain("조회 전용");
    expect(isApprovedTaskConditions({ ...conditions, approvedByUser: false })).toBe(false);
    expect(isApprovedTaskConditions({ ...conditions, scope: "" })).toBe(false);
  });

  it("accepts confirmed conditions with attachment context and remains compatible with other clients", () => {
    expect(
      taskConditionsError({
        requireTaskConditions: true,
        taskConditions: conditions,
        message: { text: "조회해 줘\n첨부 맥락" },
      }),
    ).toBeNull();
    expect(taskConditionsError({ message: { text: "기존 클라이언트 요청" } })).toBeNull();
  });
});
