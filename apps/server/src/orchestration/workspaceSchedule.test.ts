import { describe, expect, it } from "vite-plus/test";

import { resolveWorkspaceScheduleNextTrigger } from "./workspaceSchedule.ts";
import {
  ProjectId,
  WorkspaceCollaborationRunId,
  type WorkspaceCollaborationRun,
} from "@t3tools/contracts";
import { buildInitialWorkspaceTaskGraph } from "./workspaceTaskGraph.ts";

const completedAt = "2026-10-05T01:00:00.000Z";
const predecessor: WorkspaceCollaborationRun = {
  id: WorkspaceCollaborationRunId.make("predecessor"),
  projectId: ProjectId.make("project-a"),
  source: "user",
  scheduleId: null,
  incidentId: null,
  task: "Fix and verify",
  status: "completed",
  steps: [],
  graph: null,
  meeting: null,
  orchestra: null,
  finalOutput: "All checks passed",
  error: null,
  createdAt: completedAt,
  updatedAt: completedAt,
};
const afterRun = (
  run: WorkspaceCollaborationRun | null,
  condition: "completed" | "verified" = "verified",
  lastTriggeredAt: string | null = null,
) =>
  resolveWorkspaceScheduleNextTrigger({
    timing: { kind: "after-run", runId: predecessor.id, condition, onFailure: "hold" },
    now: completedAt,
    lastTriggeredAt,
    predecessor: run,
  });

describe("Workspace schedule timing", () => {
  it("waits for completion and consumes a dependency only once", () => {
    expect(afterRun({ ...predecessor, status: "running" }, "completed")).toEqual({
      nextTriggerAt: null,
      error: null,
    });
    expect(afterRun(predecessor, "completed").nextTriggerAt).toBe(completedAt);
    expect(afterRun(predecessor, "completed", completedAt)).toEqual({
      nextTriggerAt: null,
      error: null,
    });
  });
  it("requires persisted passing validation instead of a final answer that claims success", () => {
    expect(afterRun(predecessor).error).toContain("without passing validation evidence");
    const graph = buildInitialWorkspaceTaskGraph("Verify");
    const verified: WorkspaceCollaborationRun = {
      ...predecessor,
      graph: {
        ...graph,
        status: "completed",
        overallConfidence: "high",
        nodes: graph.nodes.map((node) => ({
          ...node,
          kind: "validation",
          status: "completed",
          validation: {
            targetNodeId: node.id,
            verdict: "pass",
            confidence: "high",
            summary: "Focused checks passed",
            evidence: ["test exit 0"],
            failureClassification: null,
            nextAction: "done",
            recordedAt: completedAt,
          },
        })),
      },
    };
    expect(afterRun(verified).nextTriggerAt).toBe(completedAt);
    for (const verdict of ["fail", "inconclusive"] as const) {
      expect(
        afterRun({
          ...verified,
          graph: {
            ...verified.graph!,
            nodes: verified.graph!.nodes.map((node) => ({
              ...node,
              validation: { ...node.validation!, verdict },
            })),
          },
        }).nextTriggerAt,
      ).toBeNull();
    }
    expect(
      afterRun({
        ...verified,
        graph: {
          ...verified.graph!,
          nodes: verified.graph!.nodes.map((node) => ({
            ...node,
            validation: { ...node.validation!, evidence: [] },
          })),
        },
      }).nextTriggerAt,
    ).toBeNull();
  });
  it.each(["failed", "cancelled"] as const)(
    "holds a follow-up when its predecessor is %s",
    (status) => {
      expect(afterRun({ ...predecessor, status }).nextTriggerAt).toBeNull();
      expect(afterRun({ ...predecessor, status }).error).toContain(status);
    },
  );
  it("reports deleted or mismatched predecessors", () => {
    expect(afterRun(null).error).toContain("unavailable");
    expect(
      afterRun({ ...predecessor, id: WorkspaceCollaborationRunId.make("different") }).nextTriggerAt,
    ).toBeNull();
  });
  it("runs an overdue one-time schedule once", () => {
    expect(
      resolveWorkspaceScheduleNextTrigger({
        timing: { kind: "once", runAt: "2026-08-08T00:00:00.000Z" },
        now: "2026-08-08T01:00:00.000Z",
        lastTriggeredAt: null,
      }),
    ).toEqual({ nextTriggerAt: "2026-08-08T00:00:00.000Z", error: null });
    expect(
      resolveWorkspaceScheduleNextTrigger({
        timing: { kind: "once", runAt: "2026-08-08T00:00:00.000Z" },
        now: "2026-08-08T01:00:00.000Z",
        lastTriggeredAt: "2026-08-08T00:00:00.000Z",
      }).nextTriggerAt,
    ).toBeNull();
  });

  it("skips missed interval fan-out and returns the next aligned occurrence", () => {
    expect(
      resolveWorkspaceScheduleNextTrigger({
        timing: {
          kind: "interval",
          everyMinutes: 30,
          startAt: "2026-08-08T00:00:00.000Z",
        },
        now: "2026-08-08T01:17:00.000Z",
        lastTriggeredAt: null,
      }).nextTriggerAt,
    ).toBe("2026-08-08T01:30:00.000Z");
  });

  it("resolves daily local time in the selected IANA time zone", () => {
    expect(
      resolveWorkspaceScheduleNextTrigger({
        timing: { kind: "daily", localTime: "09:00", timeZone: "Asia/Seoul" },
        now: "2026-08-08T00:01:00.000Z",
        lastTriggeredAt: null,
      }).nextTriggerAt,
    ).toBe("2026-08-09T00:00:00.000Z");
  });

  it("reports an invalid time zone instead of silently using the host zone", () => {
    expect(
      resolveWorkspaceScheduleNextTrigger({
        timing: { kind: "daily", localTime: "09:00", timeZone: "Mars/Olympus" },
        now: "2026-08-08T00:00:00.000Z",
        lastTriggeredAt: null,
      }).error,
    ).toContain("Unknown IANA time zone");
  });
});
