import { expect, it } from "vite-plus/test";
import { matchedMemoryExcerpt, selectMemoryEvidence } from "./memoryRetrieval.ts";

const now = Date.parse("2026-10-20T00:00:00Z");
const row = (id: string, text: string, extra = {}) => ({
  id,
  text,
  project_id: "p",
  scope: "project",
  origin: "user",
  verification: "user-statement",
  status: "consolidated",
  created_at: "2026-10-19T00:00:00Z",
  ...extra,
});
it("returns the matching passage within the existing size limit", () => {
  const source = `${"prefix ".repeat(300)}TARGETALPHA relevant TARGETBETA ${"tail ".repeat(300)}`;
  const excerpt = matchedMemoryExcerpt(source, ["targetalpha", "targetbeta"], 1200);
  expect(excerpt.length).toBeLessThanOrEqual(1200);
  expect(excerpt).toContain("TARGETALPHA relevant TARGETBETA");
  expect(excerpt.startsWith("…")).toBe(true);
});
it("matches normalized text without breaking Unicode source characters", () => {
  const source = `${"😀".repeat(700)} 각별한 ﬂow FACT ${"😀".repeat(700)}`;
  const excerpt = matchedMemoryExcerpt(source, ["각별", "flow"], 1200);
  expect(excerpt).toContain("각별한 ﬂow FACT");
  expect(excerpt.length).toBeLessThanOrEqual(1200);
  expect(excerpt).not.toMatch(/\uFFFD/u);
  expect(excerpt).not.toMatch(/(?:^|…)\p{Surrogate}/u);
});
it("consolidates repeated evidence in retrieval while retaining source IDs and originals", () => {
  const rows = [
    row("old", "항상 CMD를 사용한다.", { created_at: "2025-01-01" }),
    row("new", "항상 CMD를 사용한다."),
    row("path", "기억은 E 드라이브에 저장한다."),
  ];
  const result = selectMemoryEvidence(rows, "사용자 작업 규칙", 2, now);
  expect(result.map((entry) => entry.id)).toEqual(["new", "path"]);
  expect(result[0]).toMatchObject({ supportingIds: ["old"], additionalSources: 1 });
  expect(rows).toHaveLength(3);
  expect(rows[0]!.id).toBe("old");
});
it("keeps distinct values and user statements separate from unverified agent reports", () => {
  const rows = [
    row("port-old", "백엔드 포트는 13773이다."),
    row("port-new", "백엔드 포트는 13774이다."),
    row("agent", "백엔드 포트는 13774이다.", {
      origin: "assistant",
      verification: "unverified-report",
    }),
  ];
  expect(selectMemoryEvidence(rows, "백엔드 포트", 6, now)).toHaveLength(3);
});
it("retains dated repetitions for explicit historical questions", () => {
  const rows = [
    row("old", "CMD를 사용한다.", { created_at: "2025-01-01" }),
    row("new", "CMD를 사용한다."),
  ];
  expect(selectMemoryEvidence(rows, "이전에는 언제 같은 지시를 했나", 6, now)).toHaveLength(2);
});
it("reduces stale session priority without aging curated permanent rules", () => {
  const rows = [
    row("stale", "지난 백엔드를 실행했다.", {
      status: "observed",
      created_at: "2020-01-01",
      origin: "assistant",
    }),
    row("rule", "항상 CMD를 사용한다.", { created_at: "2020-01-01" }),
    row("fresh", "현재 백엔드를 실행했다.", { status: "observed", origin: "assistant" }),
  ];
  expect(selectMemoryEvidence(rows, "현재 작업 규칙", 3, now)[0]!.id).toBe("rule");
  const result = selectMemoryEvidence(rows, "현재 실행", 3, now).map((entry) => entry.id);
  expect(result.indexOf("fresh")).toBeLessThan(result.indexOf("stale"));
});
