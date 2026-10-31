import { describe, expect, it } from "vite-plus/test";
import { renderApprovedTaskConditions } from "@t3tools/contracts";
import { approveTaskConditions, createTaskConditionsDraft } from "./taskConditions";

describe("task conditions approval", () => {
  it("requires an explicit permission choice, review, and every field", () => {
    const draft = createTaskConditionsDraft("프로세스를 조회하고 표로 정리해 줘", "D:/test");
    expect(draft.mode).toBeNull();
    expect(draft.additionalActions).toEqual([]);
    expect(approveTaskConditions(draft, true)).toBeNull();
    expect(approveTaskConditions({ ...draft, mode: "inspect" }, false)).toBeNull();
    expect(approveTaskConditions({ ...draft, mode: "inspect", criteria: " " }, true)).toBeNull();
    expect(
      approveTaskConditions({ ...draft, mode: "inspect", goal: "x".repeat(8_001) }, true),
    ).toBeNull();
    expect(
      approveTaskConditions({ ...draft, mode: "inspect", additionalActions: ["delete"] }, true),
    ).toBeNull();
  });

  it("preserves the user's edits and explicitly excludes unselected permissions", () => {
    const draft = {
      ...createTaskConditionsDraft("프로세스를 확인해 줘", "D:/test"),
      mode: "work" as const,
      criteria: "6개월 이상 미사용은 실행 이력으로 확인할 때만 표시",
      restrictions: "시스템 필수 앱 제외, 종료 금지",
      output: "표로만",
      additionalActions: ["install"] as const,
    };
    const approved = approveTaskConditions(draft, true);
    expect(approved).not.toBeNull();
    const prompt = renderApprovedTaskConditions(approved!, "프로세스를 확인해 줘\n첨부 맥락");
    expect(prompt).toContain(draft.criteria);
    expect(prompt).toContain(draft.restrictions);
    expect(prompt).toContain("## 결과 형식\n표로만");
    expect(prompt).toContain("추가로 허용한 행동: 패키지·프로그램 설치");
    expect(prompt).toContain("허용하지 않은 행동: 파일·데이터 삭제, 외부 서비스에 게시·전송");
    expect(prompt).toContain("첨부 맥락");
  });
});
