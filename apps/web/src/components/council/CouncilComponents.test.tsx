import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type CouncilSessionSnapshot,
  type ModelTargetRef,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { CouncilPinnedSpecCard } from "./CouncilPinnedSpecCard";
import {
  readCollapsedCouncilMap,
  readDismissedCouncilIds,
  resolveCouncilInlineCardVisibility,
  STALE_GATE_REFUSED_IDLE_MS,
  STALE_INLINE_PINNED_IDLE_MS,
  writeCollapsedCouncilMap,
  writeDismissedCouncilIds,
} from "./ThreadCouncilDock";

function makeTarget(
  id: string,
  driver: string,
  model: string,
  displayName: string,
): ModelTargetRef {
  return {
    providerInstanceId: ProviderInstanceId.make(id),
    driverId: ProviderDriverKind.make(driver),
    modelId: model,
    displayName,
  };
}

function makePinnedSession(overrides?: Partial<CouncilSessionSnapshot>): CouncilSessionSnapshot {
  const worker1 = makeTarget("inst_1", "driver_a", "model-1", "Worker Alpha");
  const worker2 = makeTarget("inst_2", "driver_b", "model-2", "Worker Beta");
  return {
    councilId: "cnc_test_000001",
    threadId: ThreadId.make("thr_1"),
    projectId: ProjectId.make("prj_1"),
    userPrompt: "인증 레이어 경쟁 조건 수정",
    state: "PINNED_READY",
    chairModel: worker1,
    roster: [
      {
        seatId: "seat_chair",
        targetModel: worker1,
        assignedRole: "CHAIR_ARBITER",
        capabilityTags: ["deep_reasoning", "code_edit"],
        temperatureOffset: 0,
        temperatureApplied: false,
        directoryShardHint: null,
        isFallbackSubstituted: false,
      },
      {
        seatId: "seat_sub_0",
        targetModel: worker2,
        assignedRole: "CONTRARIAN_RED",
        capabilityTags: ["code_edit", "fast_critic"],
        temperatureOffset: 0,
        temperatureApplied: false,
        directoryShardHint: null,
        isFallbackSubstituted: false,
      },
    ],
    triageScore: 0.9,
    flipBlockedCount: 2,
    researchRetryCount: 0,
    ledgerEntries: [
      {
        evidenceId: "ev_1",
        councilId: "cnc_test_000001",
        submittedBySeatId: "seat_chair",
        roundNum: 1,
        filePath: "src/auth.ts",
        startLine: 1,
        endLine: 12,
        astSymbol: "verifyToken",
        excerptSha256: "a".repeat(64),
        fileHeadSha256: "b".repeat(64),
        verificationStatus: "VERIFIED_EXACT",
        verifiedAtMs: 1000,
      },
    ],
    claims: [],
    pinnedSpec: {
      pinnedSpecId: "pspec_0001",
      councilId: "cnc_test_000001",
      threadId: ThreadId.make("thr_1"),
      projectId: ProjectId.make("prj_1"),
      titleKo: "auth.ts 토큰 검증 및 스코프 중복 제거",
      executiveSummaryKo: "verifyToken trim 및 parseScope 중복 제거를 적용합니다.",
      acceptedClaimIds: ["clm_1"],
      verifiedEvidenceIds: ["ev_1"],
      targetFilesLock: [
        {
          filePath: "src/auth.ts",
          expectedFileSha256: "b".repeat(64),
          patchIntentKo: "verifyToken 공백 가드 추가",
          relatedEvidenceIds: ["ev_1"],
        },
      ],
      acceptanceChecks: [
        {
          label: "단위 테스트",
          verifySpec: { command: "vp", args: ["test", "run", "src/auth.test.ts"] },
        },
      ],
      unresolvedDisagreementsKo: [],
      uniqueFindingsKo: [],
      recommendedWorker: worker1,
      availableWorkerCandidates: [worker1, worker2],
      specHashSha256: "c".repeat(64),
      delegatedTaskId: null,
      createdAtMs: 2000,
    },
    errorMessage: null,
    createdAtMs: 1000,
    updatedAtMs: 2000,
    ...overrides,
  };
}

describe("CouncilPinnedSpecCard", () => {
  it("renders dynamic seat count, verified evidence, flip-blocked badge, worker switcher and 1-click button with semantic tokens", () => {
    const html = renderToStaticMarkup(
      <CouncilPinnedSpecCard
        session={makePinnedSession()}
        onOpenEvidenceDrawer={() => {}}
        onExecuteDelegate={async () => {}}
      />,
    );

    expect(html).toContain('data-council-pinned-card=""');
    expect(html).toContain("2인 동적 위원회");
    expect(html).toContain("원장 검증 근거 1건");
    expect(html).toContain("무근거 Flip 2건 차단");
    expect(html).toContain("[추천 1순위] Worker Alpha");
    expect(html).toContain("Worker Beta");
    expect(html).toContain("src/auth.ts");
    expect(html).toContain("bbbbbbb");
    expect(html).toContain("PinnedSpec 원클릭 실행 위임");
    // Must use T3 semantic tokens instead of hardcoded dark slate backgrounds
    expect(html).toContain("bg-card");
    expect(html).not.toContain("bg-slate-900");
  });

  it("renders STALE_PINNED_SPEC alert with re-verify action and AWAITING_OVERRIDE hold banner", () => {
    const staleHtml = renderToStaticMarkup(
      <CouncilPinnedSpecCard
        session={makePinnedSession()}
        staleWarning="[STALE_PINNED_SPEC] src/auth.ts 해시 불일치"
        onOpenEvidenceDrawer={() => {}}
        onReverifyPinnedSpec={async () => {}}
        onExecuteDelegate={async () => {}}
      />,
    );
    expect(staleHtml).toContain("STALE_PINNED_SPEC");
    expect(staleHtml).toContain("디스크 해시 재검증");

    const overrideHtml = renderToStaticMarkup(
      <CouncilPinnedSpecCard
        session={makePinnedSession({
          state: "AWAITING_OVERRIDE",
          pinnedSpec: null,
          errorMessage: "미해결 P0 반론 1건",
        })}
        onOpenEvidenceDrawer={() => {}}
        onApproveOverride={async () => {}}
        onExecuteDelegate={async () => {}}
      />,
    );
    expect(overrideHtml).toContain("보류 승인 후 PinnedSpec 잠금");
    expect(overrideHtml).toContain("CONTRARIAN_RED");
  });

  it("displays Zero Self-Approval completion proof badge when COMPLETED", () => {
    const completedHtml = renderToStaticMarkup(
      <CouncilPinnedSpecCard
        session={makePinnedSession({
          state: "COMPLETED",
          pinnedSpec: {
            ...makePinnedSession().pinnedSpec!,
            delegatedTaskId: "cdel_1234",
            specGateOutcome: "pass",
            specProofSummary: {
              specId: "pspec_0001",
              outcome: "pass",
              checkerActorId: "inst_2:model-2",
              summary: "독립 검증자(inst_2:model-2)가 승인했습니다.",
            },
          },
        })}
        onOpenEvidenceDrawer={() => {}}
        onExecuteDelegate={async () => {}}
      />,
    );
    expect(completedHtml).toContain("Zero Self-Approval 통과");
    expect(completedHtml).toContain("완료됨 (cdel_1234)");
  });

  it("collapses ABORTED sessions by default, provides expand/dismiss controls, and never shows '실행 중' for stale delegatedTaskId", () => {
    const abortedSession = makePinnedSession({
      state: "ABORTED",
      errorMessage: "사용자가 다자간 위원회를 중단했습니다.",
      pinnedSpec: {
        ...makePinnedSession().pinnedSpec!,
        delegatedTaskId: "cdel_d2324473b715419b",
      },
    });

    // Default uncontrolled state for ABORTED is collapsed with expand & dismiss controls
    const collapsedHtml = renderToStaticMarkup(
      <CouncilPinnedSpecCard
        session={abortedSession}
        onDismiss={() => {}}
        onOpenEvidenceDrawer={() => {}}
        onExecuteDelegate={async () => {}}
      />,
    );
    expect(collapsedHtml).toContain('data-council-collapsed="true"');
    expect(collapsedHtml).toContain("data-council-collapse-btn");
    expect(collapsedHtml).toContain("펼치기");
    expect(collapsedHtml).toContain("data-council-dismiss-btn");
    expect(collapsedHtml).toContain("닫기");
    expect(collapsedHtml).not.toContain("실행 중 (cdel_d2324473b715419b)");

    // When explicitly expanded, shows error alert and '중단됨' instead of '실행 중 (...)'
    const expandedHtml = renderToStaticMarkup(
      <CouncilPinnedSpecCard
        session={abortedSession}
        collapsed={false}
        onDismiss={() => {}}
        onOpenEvidenceDrawer={() => {}}
        onExecuteDelegate={async () => {}}
      />,
    );
    expect(expandedHtml).toContain('data-council-collapsed="false"');
    expect(expandedHtml).toContain("접기");
    expect(expandedHtml).toContain('data-council-error-alert=""');
    expect(expandedHtml).toContain("사용자가 다자간 위원회를 중단했습니다.");
    expect(expandedHtml).toContain("중단됨");
    expect(expandedHtml).not.toContain("실행 중 (cdel_d2324473b715419b)");
  });

  it("hides ABORTED/INTERRUPTED_BY_RESTART inline cards by default, allows strip reopen, and persists dismissed IDs", () => {
    const aborted = makePinnedSession({ state: "ABORTED" });
    const interrupted = makePinnedSession({ state: "INTERRUPTED_BY_RESTART" });
    const completed = makePinnedSession({ state: "COMPLETED" });
    const ready = makePinnedSession({ state: "PINNED_READY" });

    // Default: ABORTED & INTERRUPTED_BY_RESTART stay completely hidden with strip reopen button
    expect(
      resolveCouncilInlineCardVisibility({
        session: aborted,
        dismissedIds: new Set(),
        reopenedCouncilId: null,
      }),
    ).toEqual({ showInlineCard: false, canReopenFromStrip: true });
    expect(
      resolveCouncilInlineCardVisibility({
        session: interrupted,
        dismissedIds: new Set(),
        reopenedCouncilId: null,
      }),
    ).toEqual({ showInlineCard: false, canReopenFromStrip: true });

    // Explicit reopen shows the card; re-dismissing hides it again
    expect(
      resolveCouncilInlineCardVisibility({
        session: aborted,
        dismissedIds: new Set(),
        reopenedCouncilId: aborted.councilId,
      }),
    ).toEqual({ showInlineCard: true, canReopenFromStrip: false });

    // COMPLETED is visible until dismissed, then stays hidden across remounts via storage
    expect(
      resolveCouncilInlineCardVisibility({
        session: completed,
        dismissedIds: new Set(),
        reopenedCouncilId: null,
      }),
    ).toEqual({ showInlineCard: true, canReopenFromStrip: false });
    expect(
      resolveCouncilInlineCardVisibility({
        session: completed,
        dismissedIds: new Set([completed.councilId]),
        reopenedCouncilId: null,
      }),
    ).toEqual({ showInlineCard: false, canReopenFromStrip: true });

    // PINNED_READY stays visible when fresh & undismissed, but honors explicit dismissal,
    // gate-refusal aging (>5m), and idle aging (>30m) while keeping "카드 보기" in the strip
    expect(
      resolveCouncilInlineCardVisibility({
        session: ready,
        dismissedIds: new Set(),
        reopenedCouncilId: null,
        nowMs: ready.updatedAtMs + 60_000,
      }),
    ).toEqual({ showInlineCard: true, canReopenFromStrip: false });
    expect(
      resolveCouncilInlineCardVisibility({
        session: ready,
        dismissedIds: new Set([ready.councilId]),
        reopenedCouncilId: null,
      }),
    ).toEqual({ showInlineCard: false, canReopenFromStrip: true });
    expect(
      resolveCouncilInlineCardVisibility({
        session: ready,
        dismissedIds: new Set(),
        reopenedCouncilId: null,
        nowMs: ready.updatedAtMs + STALE_INLINE_PINNED_IDLE_MS + 1,
      }),
    ).toEqual({ showInlineCard: false, canReopenFromStrip: true });

    const gateRefusedReady = makePinnedSession({
      state: "PINNED_READY",
      errorMessage: "독립 검증자(Checker)의 승인 판정이 없어 완료를 보류했습니다.",
      pinnedSpec: {
        ...makePinnedSession().pinnedSpec!,
        specGateOutcome: "refused_missing_checker",
      },
    });
    expect(
      resolveCouncilInlineCardVisibility({
        session: gateRefusedReady,
        dismissedIds: new Set(),
        reopenedCouncilId: null,
        nowMs: gateRefusedReady.updatedAtMs + STALE_GATE_REFUSED_IDLE_MS + 1,
      }),
    ).toEqual({ showInlineCard: false, canReopenFromStrip: true });
    expect(
      resolveCouncilInlineCardVisibility({
        session: gateRefusedReady,
        dismissedIds: new Set(),
        reopenedCouncilId: gateRefusedReady.councilId,
        nowMs: gateRefusedReady.updatedAtMs + STALE_GATE_REFUSED_IDLE_MS + 1,
      }),
    ).toEqual({ showInlineCard: true, canReopenFromStrip: false });

    // PINNED_READY card renders close ("닫기") & discard ("보류 폐기") buttons, and gate-failed cards start collapsed
    const gateRefusedHtml = renderToStaticMarkup(
      <CouncilPinnedSpecCard
        session={gateRefusedReady}
        onDismiss={() => {}}
        onAbortCouncil={async () => {}}
        onOpenEvidenceDrawer={() => {}}
        onExecuteDelegate={async () => {}}
      />,
    );
    expect(gateRefusedHtml).toContain('data-council-collapsed="true"');
    expect(gateRefusedHtml).toContain('data-council-dismiss-btn=""');
    expect(gateRefusedHtml).toContain('data-council-abort-btn=""');
    expect(gateRefusedHtml).toContain("보류 폐기");
    expect(gateRefusedHtml).toContain("닫기");

    // Storage round-trip check (both dismissed IDs and collapsed map)
    const mem = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
    };
    writeDismissedCouncilIds(new Set(["cnc_1", "cnc_2"]), fakeStorage);
    expect([...readDismissedCouncilIds(fakeStorage)]).toEqual(["cnc_1", "cnc_2"]);
    writeCollapsedCouncilMap({ cnc_1: true, cnc_2: false }, fakeStorage);
    expect(readCollapsedCouncilMap(fakeStorage)).toEqual({ cnc_1: true, cnc_2: false });
  });

  it("renders live per-seat progress badges while in-flight and hides completed discussion inline cards by default", () => {
    const inFlight = makePinnedSession({
      state: "BLIND_ROUND_1",
      pinnedSpec: null,
      seatProgress: [
        {
          seatId: "seat_chair",
          roundNum: 1,
          state: "completed",
          startedAtMs: 1_000,
          finishedAtMs: 53_000,
          elapsedMs: 52_000,
        },
        {
          seatId: "seat_sub_0",
          roundNum: 1,
          state: "running",
          startedAtMs: 1_000,
          finishedAtMs: null,
          elapsedMs: 12_000,
        },
      ],
    });

    const inFlightHtml = renderToStaticMarkup(
      <CouncilPinnedSpecCard
        session={inFlight}
        onOpenEvidenceDrawer={() => {}}
        onExecuteDelegate={async () => {}}
      />,
    );
    expect(inFlightHtml).toContain('data-council-seat-progress=""');
    expect(inFlightHtml).toContain("CHAIR · model-1 (완료 52s)");
    expect(inFlightHtml).toContain("RED · model-2 (실행 중)");

    // Once in DELEGATED_RUNNING, stale Round-2 seat badges must be hidden and single-worker progress shown
    const delegatedHtml = renderToStaticMarkup(
      <CouncilPinnedSpecCard
        session={{
          ...makePinnedSession({
            state: "DELEGATED_RUNNING",
            seatProgress: inFlight.seatProgress ?? [],
          }),
          pinnedSpec: {
            ...makePinnedSession().pinnedSpec!,
            delegatedTaskId: "cdel_worker_99",
          },
        }}
        onOpenEvidenceDrawer={() => {}}
        onExecuteDelegate={async () => {}}
      />,
    );
    expect(delegatedHtml).not.toContain('data-council-seat-progress=""');
    expect(delegatedHtml).toContain('data-council-worker-progress=""');
    expect(delegatedHtml).toContain("cdel_worker_99");

    const discussionDone = makePinnedSession({
      mode: "discussion",
      state: "COMPLETED",
      pinnedSpec: null,
      synthesisReportMarkdown: "### 다자간 위원회 분석·토론 보고서 — 핵심 결론",
    });
    expect(
      resolveCouncilInlineCardVisibility({
        session: discussionDone,
        dismissedIds: new Set(),
        reopenedCouncilId: null,
      }),
    ).toEqual({ showInlineCard: false, canReopenFromStrip: true });
    expect(
      resolveCouncilInlineCardVisibility({
        session: discussionDone,
        dismissedIds: new Set(),
        reopenedCouncilId: discussionDone.councilId,
      }),
    ).toEqual({ showInlineCard: true, canReopenFromStrip: false });
  });
});
