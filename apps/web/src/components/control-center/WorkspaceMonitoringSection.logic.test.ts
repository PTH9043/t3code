import { WorkspaceProgramId, type WorkspaceMonitoringPlan } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeMonitoringMetric,
  describeMonitoringPlaybook,
  describeMonitoringTarget,
  monitoringPlanStatusLabel,
  monitoringPlanStatusVariant,
  parseMonitoringPlanDraft,
} from "./WorkspaceMonitoringSection.logic";

const plan: WorkspaceMonitoringPlan = {
  revision: 2,
  proposedAt: "2026-08-21T00:00:00.000Z",
  approvedAt: null,
  rationale: null,
  targets: [
    { kind: "program", label: "dev", programId: WorkspaceProgramId.make("prog-dev") },
    { kind: "self-server", label: "T3 서버" },
  ],
  metrics: [
    { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 5, limit: 3 },
    { targetIndex: 1, metric: "memory", trend: "slope", windowMin: 30, limit: 20 * 1024 * 1024 },
  ],
  playbooks: [{ when: 0, action: "restart-program" }],
};

describe("parseMonitoringPlanDraft", () => {
  it("accepts a hand-written plan and carries revision/proposedAt from the previous one", () => {
    const parsed = parseMonitoringPlanDraft(
      JSON.stringify({ targets: plan.targets, metrics: plan.metrics, playbooks: plan.playbooks }),
      plan,
    );
    expect(parsed._tag).toBe("Plan");
    if (parsed._tag !== "Plan") return;
    expect(parsed.plan.revision).toBe(2);
    expect(parsed.plan.proposedAt).toBe(plan.proposedAt);
    expect(parsed.plan.approvedAt).toBeNull();
    expect(parsed.plan.rationale).toBeNull();
  });

  it("rejects bad JSON, schema violations, and dangling indexes with a readable detail", () => {
    expect(parseMonitoringPlanDraft("{", null)).toMatchObject({ _tag: "Invalid" });
    expect(
      parseMonitoringPlanDraft(JSON.stringify({ targets: [], metrics: "x" }), null),
    ).toMatchObject({
      _tag: "Invalid",
    });
    expect(
      parseMonitoringPlanDraft(
        JSON.stringify({
          targets: plan.targets,
          metrics: [{ ...plan.metrics[0], targetIndex: 9 }],
        }),
        null,
      ),
    ).toMatchObject({ _tag: "Invalid", detail: expect.stringContaining("targetIndex") });
    expect(
      parseMonitoringPlanDraft(
        JSON.stringify({
          targets: plan.targets,
          metrics: plan.metrics,
          playbooks: [{ when: 5, action: "notify-only" }],
        }),
        null,
      ),
    ).toMatchObject({ _tag: "Invalid", detail: expect.stringContaining("when") });
  });
});

describe("labels", () => {
  it("describes targets, metrics, and playbooks in the words the card shows", () => {
    expect(describeMonitoringTarget(plan.targets[0]!)).toBe("프로그램 · dev (prog-dev)");
    expect(describeMonitoringMetric(plan.metrics[0]!, plan.targets)).toBe(
      "dev · 상태검사 · 임계치 연속 3회 실패 · 5분 창",
    );
    expect(describeMonitoringMetric(plan.metrics[1]!, plan.targets)).toBe(
      "T3 서버 · 메모리 · 증가 추세 분당 20MB · 30분 창",
    );
    expect(describeMonitoringPlaybook(plan.playbooks[0]!, plan)).toBe(
      "dev의 상태검사 이상 → 프로그램 재시작",
    );
  });

  it("maps plan status to a label and a badge tone, and reads 꺼짐 as outline", () => {
    expect(monitoringPlanStatusLabel("proposed")).toBe("승인 대기");
    expect(monitoringPlanStatusVariant("approved", true)).toBe("success");
    expect(monitoringPlanStatusVariant("stale", true)).toBe("warning");
    expect(monitoringPlanStatusVariant("approved", false)).toBe("outline");
  });
});
