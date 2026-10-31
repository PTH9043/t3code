import { expect, it } from "vite-plus/test";
import { workspaceRetrievalQuery, workspaceSearchExpansion } from "./workspaceSearchVocabulary.ts";
it("expands specific bilingual engineering terms without rewriting the source task", () => {
  const task = "실행파일 검색 경로가 긴 경우의 인공지능 명령 실행";
  expect(workspaceSearchExpansion(task)).toEqual(["PATH", "AI"]);
  expect(workspaceRetrievalQuery(task)).toContain(task);
  expect(workspaceSearchExpansion("AI 작업별 누적 집계가 섞인다")).toContain("사용량");
  expect(workspaceSearchExpansion("휴대폰에서 담당 인공지능 발언 표시")).toEqual(["모바일", "AI"]);
});
it("does not turn unrelated observation, directions, or consumption into engineering evidence", () => {
  for (const task of [
    "아이를 지켜보는 방법",
    "여행 경로를 변경해",
    "전기 소비량을 정리해",
    "선거 누적 집계를 알려줘",
  ])
    expect(workspaceSearchExpansion(task)).toEqual([]);
});
it("connects explicit cross-folder isolation wording to context isolation without expanding ordinary file moves", () => {
  expect(workspaceSearchExpansion("다른 폴더의 자료가 섞이지 않게 해")).toEqual(["문맥", "격리"]);
  expect(workspaceSearchExpansion("다른 프로젝트의 기억을 분리해")).toEqual(["문맥", "격리"]);
  expect(workspaceSearchExpansion("다른 폴더로 사진을 복사해")).toEqual([]);
});
