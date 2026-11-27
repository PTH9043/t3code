import { expect, it } from "vite-plus/test";
import {
  computeMemoryRetentionAndHeat,
  matchedMemoryExcerpt,
  selectMemoryEvidence,
  selectWorkspaceMemoryRecords,
  type WorkspaceMemoryRecord,
} from "./memoryRetrieval.ts";
import { classifyCognitiveMemory, composeProgressiveProceduralContext } from "./memorySalience.ts";

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

it("prioritizes explicit decisions and sourced reports while leaving original evidence unchanged", () => {
  const rows = [
    row("ordinary", "프로젝트에 대한 일회성 이야기입니다.", {
      origin: "assistant",
      status: "observed",
    }),
    row("decision", "프로젝트 예산은 5달러로 제한한다.", { status: "observed" }),
    row(
      "source",
      "apps/server/src/test.ts:12에서 테스트 실패를 확인하고 원인과 관련 근거를 기록했습니다.",
      { origin: "assistant", status: "observed", verification: "unverified-report" },
    ),
  ];
  const selected = selectMemoryEvidence(rows, "프로젝트 테스트 예산", 3, now);
  expect(selected[0]?.id).toBe("decision");
  expect(selected.find((item) => item.id === "source")?.verification).toBe("unverified-report");
  expect(rows).toHaveLength(3);
});

it("reinforces Ebbinghaus stability and promotes frequently accessed directives to hot tier while demoting stale ordinary memories to cold", () => {
  const dayMs = 86_400_000;
  const hotDirective = computeMemoryRetentionAndHeat(
    {
      createdAt: now - 120 * dayMs,
      lastAccessedAt: now - 1 * dayMs,
      accessCount: 12,
      salience: "user-decision",
      cognitiveType: "directive",
    },
    now,
  );
  expect(hotDirective.stabilityDays).toBeGreaterThan(150);
  expect(hotDirective.heatScore).toBeGreaterThanOrEqual(1.35);
  expect(hotDirective.recommendedTier).toBe("hot");

  const coldEpisodic = computeMemoryRetentionAndHeat(
    {
      createdAt: now - 90 * dayMs,
      lastAccessedAt: now - 60 * dayMs,
      accessCount: 0,
      salience: "ordinary",
      cognitiveType: "episodic",
    },
    now,
  );
  expect(coldEpisodic.heatScore).toBeLessThan(0.25);
  expect(coldEpisodic.recommendedTier).toBe("cold");
});

it("filters superseded and expired records in selectWorkspaceMemoryRecords unless historical mode is requested", () => {
  const baseRecord: WorkspaceMemoryRecord = {
    id: "m-1",
    workspaceId: "ws-1",
    topic: "server.http",
    content: "server.http의 포트를 8000으로 설정",
    role: "user",
    salience: "user-decision",
    cognitiveType: "semantic",
    memoryTier: "cold",
    createdAt: now - 86_400_000 * 10,
    lastAccessedAt: null,
    accessCount: 0,
    stabilityDays: 60,
    heatScore: 0.9,
    entityKey: "server.http",
    predicateSlot: "port",
    validFrom: now - 86_400_000 * 10,
    validTo: now - 86_400_000 * 2,
    expiredAt: now - 86_400_000 * 2,
    supersededById: "m-2",
    lexicalScore: 0.9,
    semanticScore: 0.9,
  };
  const currentRecord: WorkspaceMemoryRecord = {
    ...baseRecord,
    id: "m-2",
    content: "server.http의 포트를 8080으로 변경",
    memoryTier: "hot",
    createdAt: now - 86_400_000 * 2,
    validFrom: now - 86_400_000 * 2,
    validTo: null,
    expiredAt: null,
    supersededById: null,
  };

  const activeOnly = selectWorkspaceMemoryRecords([baseRecord, currentRecord], { nowMs: now });
  expect(activeOnly.map((r) => r.id)).toEqual(["m-2"]);

  const withHistory = selectWorkspaceMemoryRecords([baseRecord, currentRecord], {
    nowMs: now,
    includeHistoricalSuperseded: true,
  });
  expect(withHistory.map((r) => r.id)).toHaveLength(2);
});

it("classifies CoALA 4 cognitive memory types and builds progressive disclosure procedural manifests", () => {
  const directive = classifyCognitiveMemory("절대 PowerShell을 사용하지 마세요.", "user");
  expect(directive.cognitiveType).toBe("directive");
  expect(directive.requiresProceduralReview).toBe(false);

  const agentProcedural = classifyCognitiveMemory(
    "배포 절차 체크리스트: 1. 빌드 2. 테스트 3. 예약 작업 재시작 순서대로 실행",
    "assistant",
  );
  expect(agentProcedural.cognitiveType).toBe("procedural");
  expect(agentProcedural.requiresProceduralReview).toBe(true);

  const userProcedural = classifyCognitiveMemory(
    "런북 절차: 순서대로 마이그레이션 확인 후 재시작",
    "user",
  );
  expect(userProcedural.cognitiveType).toBe("procedural");
  expect(userProcedural.requiresProceduralReview).toBe(false);

  const manifest = composeProgressiveProceduralContext(
    [
      {
        id: "proc-deploy",
        topic: "Windows 운영 배포 런북",
        summaryHeader: "예약 작업으로 dev:desktop 재시작",
        fullSteps: "1. runtime.py start --production --mode dev:desktop\n2. HTTP 200 확인",
      },
      {
        id: "proc-ios",
        topic: "iOS 시뮬레이터 디버깅",
        summaryHeader: "XcodeBuildMCP 시뮬레이터 연결",
        fullSteps: "1. serve-sim 실행",
      },
    ],
    "Windows 운영 배포 재시작 방법",
    1,
  );
  expect(manifest).toContain("### Procedural Memory Manifest");
  expect(manifest).toContain("- [proc-deploy] (Windows 운영 배포 런북)");
  expect(manifest).toContain("- [proc-ios] (iOS 시뮬레이터 디버깅)");
  expect(manifest).toContain("#### Expanded Runbook [proc-deploy]");
  expect(manifest).not.toContain("#### Expanded Runbook [proc-ios]");
});
