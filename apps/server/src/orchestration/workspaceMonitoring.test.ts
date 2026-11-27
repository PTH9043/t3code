import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import {
  MAX_MONITORING_TURNS_PER_HOUR,
  WORKSPACE_MONITORING_ACTION_CLOSE_MARKER,
  WORKSPACE_MONITORING_ACTION_OPEN_MARKER,
  WORKSPACE_MONITORING_PLAN_CLOSE_MARKER,
  WORKSPACE_MONITORING_PLAN_OPEN_MARKER,
  buildMonitoringFindingPrompt,
  monitoringTurnBudget,
  parseMonitoringActions,
  parseMonitoringPlan,
} from "./workspaceMonitoring.ts";

const validBody = {
  rationale: "dev 서버가 핵심입니다.",
  targets: [{ kind: "program", label: "dev", programId: "prog-dev" }],
  metrics: [{ targetIndex: 0, metric: "health", trend: "threshold", windowMin: 5, limit: 3 }],
  playbooks: [{ when: 0, action: "notify-only" }],
};

const fenced = (body: unknown) =>
  `설명입니다.\n\n${WORKSPACE_MONITORING_PLAN_OPEN_MARKER}\n${JSON.stringify(body)}\n${WORKSPACE_MONITORING_PLAN_CLOSE_MARKER}`;

it("parses a fenced plan, tolerating a json code fence inside the markers", () => {
  const plain = parseMonitoringPlan(fenced(validBody));
  expect(plain._tag).toBe("Plan");
  const withCodeFence = parseMonitoringPlan(
    `${WORKSPACE_MONITORING_PLAN_OPEN_MARKER}\n\`\`\`json\n${JSON.stringify(validBody)}\n\`\`\`\n${WORKSPACE_MONITORING_PLAN_CLOSE_MARKER}`,
  );
  expect(withCodeFence._tag).toBe("Plan");
  if (withCodeFence._tag === "Plan") {
    expect(withCodeFence.plan.targets[0]?.label).toBe("dev");
  }
});

it("uses the LAST plan block so an AI that quotes the template first still parses", () => {
  const template = { ...validBody, rationale: "한 문단" };
  const output = `${fenced(template)}\n\n수정본:\n${fenced(validBody)}`;
  const parsed = parseMonitoringPlan(output);
  expect(parsed._tag).toBe("Plan");
  if (parsed._tag === "Plan") expect(parsed.plan.rationale).toBe(validBody.rationale);
});

it("reports missing, unterminated, malformed, and out-of-range plans without guessing", () => {
  expect(parseMonitoringPlan("계획 없이 설명만")._tag).toBe("Missing");
  expect(parseMonitoringPlan(`${WORKSPACE_MONITORING_PLAN_OPEN_MARKER}\n{}`)._tag).toBe("Invalid");
  expect(
    parseMonitoringPlan(
      `${WORKSPACE_MONITORING_PLAN_OPEN_MARKER}\n{not json\n${WORKSPACE_MONITORING_PLAN_CLOSE_MARKER}`,
    )._tag,
  ).toBe("Invalid");
  const badIndex = parseMonitoringPlan(
    fenced({ ...validBody, metrics: [{ ...validBody.metrics[0], targetIndex: 4 }] }),
  );
  expect(badIndex).toMatchObject({
    _tag: "Invalid",
    detail: expect.stringContaining("targetIndex"),
  });
  const badPlaybook = parseMonitoringPlan(
    fenced({ ...validBody, playbooks: [{ when: 9, action: "notify-only" }] }),
  );
  expect(badPlaybook).toMatchObject({ _tag: "Invalid", detail: expect.stringContaining("when") });
  const tooMany = parseMonitoringPlan(
    fenced({ ...validBody, targets: Array.from({ length: 17 }, () => validBody.targets[0]) }),
  );
  expect(tooMany._tag).toBe("Invalid");
});

it("computes the remaining budget from the log and clamps under the global ceiling", () => {
  const now = "2026-08-21T12:00:00.000Z";
  const minutesAgo = (minutes: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(Date.parse(now) - minutes * 60_000));
  const budget = monitoringTurnBudget(
    {
      aiTurnBudget: { perHour: 3, perDay: 5 },
      turnLog: [minutesAgo(25 * 60), minutesAgo(90), minutesAgo(30), minutesAgo(5)],
    },
    now,
  );
  // Two turns in the last hour, three in the last day; the 25h-old entry is gone.
  expect(budget.remainingHour).toBe(1);
  expect(budget.remainingDay).toBe(2);
  expect(budget.trimmedLog).toHaveLength(3);

  const ceiling = monitoringTurnBudget(
    { aiTurnBudget: { perHour: 99, perDay: 999 }, turnLog: [] },
    now,
  );
  expect(ceiling.remainingHour).toBe(MAX_MONITORING_TURNS_PER_HOUR);

  const exhausted = monitoringTurnBudget(
    { aiTurnBudget: { perHour: 1, perDay: 1 }, turnLog: [minutesAgo(1)] },
    now,
  );
  expect(exhausted.remainingHour).toBe(0);
  expect(exhausted.remainingDay).toBe(0);
});

it("executes only relayed actions that target programs in the approved plan", () => {
  const plan = { targets: [{ kind: "program", label: "dev", programId: "prog-dev" }] } as never;
  const block = (body: unknown) =>
    `조치합니다.\n${WORKSPACE_MONITORING_ACTION_OPEN_MARKER}\n${JSON.stringify(body)}\n${WORKSPACE_MONITORING_ACTION_CLOSE_MARKER}`;
  expect(parseMonitoringActions("블록 없음", plan)).toEqual({ actions: [], rejected: null });
  const ok = parseMonitoringActions(
    block([{ action: "restart-program", programId: "prog-dev" }]),
    plan,
  );
  expect(ok.actions).toEqual([{ action: "restart-program", programId: "prog-dev" }]);
  expect(ok.rejected).toBeNull();
  // A single object is tolerated; a foreign programId is dropped and reported.
  const foreign = parseMonitoringActions(
    block({ action: "stop-program", programId: "someone-else" }),
    plan,
  );
  expect(foreign.actions).toEqual([]);
  expect(foreign.rejected).toContain("계획에 없는");
  expect(
    parseMonitoringActions(block([{ action: "delete-everything", programId: "prog-dev" }]), plan)
      .actions,
  ).toEqual([]);
  expect(
    parseMonitoringActions(`${WORKSPACE_MONITORING_ACTION_OPEN_MARKER}\n[]`, plan).rejected,
  ).toContain("닫는 마커");
});

it("includes fail-well [UNREADABLE] guidance in monitoring finding prompts", () => {
  const prompt = buildMonitoringFindingPrompt({
    projectTitle: "T3 Code",
    findings: [
      {
        fingerprint: "0|health|up",
        targetLabel: "dev",
        programId: "prog-dev",
        metric: { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 5, limit: 3 },
        observed: "3 consecutive failures",
        observedAt: "2026-11-22T00:00:00.000Z",
      },
    ],
    executedPlaybooks: [],
    autonomy: "ask",
    budget: { remainingHour: 5, remainingDay: 20, trimmedLog: [] },
  });
  expect(prompt).toContain("[UNREADABLE]");
});
