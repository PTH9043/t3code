import { expect, it } from "vite-plus/test";
import {
  classifyDevelopmentFailure,
  developmentRecoveryBarrier,
} from "./workspaceDevelopmentRecovery.ts";
import { state, task, workspace } from "./workspaceDevelopmentFixtures.ts";

it("classifies failures by execution stage and never retries unclear delivery or accepted input", () => {
  expect(classifyDevelopmentFailure("503 temporary timeout", "pending")).toMatchObject({
    kind: "transient",
    retryAllowed: true,
  });
  expect(classifyDevelopmentFailure("503 temporary timeout", "accepted").retryAllowed).toBe(false);
  expect(classifyDevelopmentFailure("503", "submitting")).toMatchObject({
    kind: "delivery-unknown",
    retryAllowed: false,
  });
  expect(classifyDevelopmentFailure("401 unauthorized", "pending").kind).toBe("environment");
  expect(classifyDevelopmentFailure("Cannot find module", "pending").strategy).toBe(
    "diagnose-environment",
  );
  expect(classifyDevelopmentFailure("typecheck TS2322", "accepted").strategy).toBe(
    "repair-and-verify",
  );
  expect(classifyDevelopmentFailure("conflicting requirement", "accepted").strategy).toBe(
    "clarify-requirement",
  );
  expect(classifyDevelopmentFailure("stop", "accepted", true).kind).toBe("cancelled");
});
it("requires a recovery plan and allows only one confirmed unaccepted retry on the same evidence", () => {
  const failed = {
    ...task,
    status: "failed" as const,
    error: "503 temporary",
    failureCodeFingerprint: workspace.observedFingerprint,
  };
  const input = { ...state, tasks: [failed] };
  expect(developmentRecoveryBarrier(input, workspace, task.objective)).toContain(
    "recoveryStrategy",
  );
  expect(
    developmentRecoveryBarrier(input, workspace, task.objective, "retry-after-check"),
  ).toBeNull();
  const repeated = { ...failed, id: "T-2", recoveryStrategy: "retry-after-check" as const };
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [failed, repeated] },
      workspace,
      task.objective,
      "retry-after-check",
    ),
  ).toContain("1회");
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [failed, repeated] },
      workspace,
      task.objective,
      "diagnose-environment",
    ),
  ).toBeNull();
  expect(
    developmentRecoveryBarrier(
      input,
      { ...workspace, observedFingerprint: "changed" },
      task.objective,
    ),
  ).toBeNull();
});
it("rejects repeated repair on unchanged code and permits changed requirements", () => {
  const failed = {
    ...task,
    status: "failed" as const,
    error: "test assertion",
    recoveryStrategy: "repair-and-verify" as const,
  };
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [failed] },
      workspace,
      task.objective,
      "repair-and-verify",
    ),
  ).toContain("새 근거");
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [failed] },
      { ...workspace, requirementRevision: 2 },
      task.objective,
    ),
  ).toBeNull();
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [{ ...failed, status: "delivery_unknown" }] },
      workspace,
      task.objective,
      "diagnose-environment",
    ),
  ).toContain("전달 여부");
});

it("keeps uncertain delivery blocked across checkout edits, requirement revisions and later failed attempts", () => {
  const uncertain = {
    ...task,
    status: "delivery_unknown" as const,
    delivery: "delivery_unknown" as const,
    failureCodeFingerprint: "before-the-submit",
  };
  const changedWorkspace = {
    ...workspace,
    observedFingerprint: "after-the-submit",
    requirementRevision: 2,
  };
  const later = { ...task, id: "T-later", status: "failed" as const, requirementRevision: 2 };
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [{ ...uncertain, status: "failed" }] },
      changedWorkspace,
      task.objective,
      "repair-and-verify",
    ),
  ).toContain("전달 여부");
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [uncertain, later] },
      changedWorkspace,
      task.objective,
      "diagnose-environment",
    ),
  ).toContain("전달 여부");
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [{ ...uncertain, status: "superseded" }] },
      changedWorkspace,
      task.objective,
    ),
  ).toBeNull();
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [uncertain] },
      changedWorkspace,
      "different task",
    ),
  ).toBeNull();
});

it("scopes the one-retry allowance to unchanged evidence while preserving unknown older fingerprints", () => {
  const failed = {
    ...task,
    status: "failed" as const,
    error: "503 temporary",
    failureCodeFingerprint: workspace.observedFingerprint,
  };
  const older = {
    ...failed,
    id: "T-old",
    failureCodeFingerprint: "old-checkout",
    recoveryStrategy: "retry-after-check" as const,
  };
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [older, failed] },
      workspace,
      task.objective,
      "retry-after-check",
    ),
  ).toBeNull();
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [{ ...older, failureCodeFingerprint: undefined }, failed] },
      workspace,
      task.objective,
      "retry-after-check",
    ),
  ).toContain("1회");
});

it("never retries an accepted input based on a stale retryAllowed flag", () => {
  const failed = {
    ...task,
    status: "failed" as const,
    delivery: "accepted" as const,
    failureRecovery: classifyDevelopmentFailure("503 temporary", "pending"),
  };
  expect(
    developmentRecoveryBarrier(
      { ...state, tasks: [failed] },
      workspace,
      task.objective,
      "retry-after-check",
    ),
  ).toContain("자동 재시도");
});
