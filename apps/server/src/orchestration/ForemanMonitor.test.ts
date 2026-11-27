import { describe, expect, it } from "vite-plus/test";
import { evaluateForemanIndicators, trigramCosineSimilarity } from "./ForemanMonitor.ts";

describe("ForemanMonitor", () => {
  it("detects loop, file collision, handoff drop, quota burn, silent routine, and preserves 3-state unavailable semantics", () => {
    const now = 1_700_000_000_000;
    expect(
      trigramCosineSimilarity("지금 파일을 확인 중입니다", "지금 파일을 확인 중입니다"),
    ).toBeCloseTo(1, 5);

    const snapshot = evaluateForemanIndicators({
      nowMs: now,
      lastEventAtMs: now - 30 * 60_000,
      hasPendingUserQuestion: false,
      hasPendingHostApproval: true,
      hasIncompleteWork: true,
      recentAssistantMessages: [
        "테스트 실패 원인을 다시 확인하고 동일한 패치를 시도합니다.",
        "테스트 실패 원인을 다시 확인하고 동일한 패치를 시도합니다.",
        "테스트 실패 원인을 다시 확인하고 동일한 패치를 시도합니다.",
      ],
      handoffs: [{ targetId: "codex-worker", dispatchedAtMs: now - 15 * 60_000, responded: false }],
      activeWorkerPaths: [
        { workerId: "w1", paths: ["D:\\__NewAutoUsage\\apps\\server\\src\\ws.ts"] },
        { workerId: "w2", paths: ["d:/__NewAutoUsage/apps/server/src/ws.ts"] },
      ],
      shiftDispatchCount: 140,
      scheduledRoutines: [
        { routineId: "nightly-audit", expectedRunAtMs: now - 60_000, observedOutputCount: 0 },
      ],
      unverifiedCompletionCount: 1,
    });

    expect(snapshot.highestSeverityLabel).toBe("approval wait");
    const byId = new Map(snapshot.indicators.map((item) => [item.id, item]));
    expect(byId.get("approval_wait")?.state).toBe("fired");
    expect(byId.get("loop")?.state).toBe("fired");
    expect(byId.get("vm_collision")?.state).toBe("fired");
    expect(byId.get("handoff_drop")?.state).toBe("fired");
    expect(byId.get("quota_burn")?.state).toBe("fired");
    expect(byId.get("quota_burn")?.usageIsIncomplete).toBe(true);
    expect(byId.get("silent_routine")?.state).toBe("fired");
    expect(byId.get("unverified")?.state).toBe("fired");
    // Stall does not fire when parked on host approval
    expect(byId.get("stall")?.state).toBe("clear");

    // Missing telemetry MUST report `unavailable`, never silently `clear`
    const missing = evaluateForemanIndicators({
      nowMs: now,
      lastEventAtMs: null,
      hasPendingUserQuestion: false,
      hasPendingHostApproval: false,
      hasIncompleteWork: false,
    });
    expect(missing.highestSeverityLabel).toBe("age unknown");
    const mById = new Map(missing.indicators.map((item) => [item.id, item]));
    expect(mById.get("stall")?.state).toBe("unavailable");
    expect(mById.get("loop")?.state).toBe("unavailable");
    expect(mById.get("quota_burn")?.state).toBe("unavailable");
  });
});
