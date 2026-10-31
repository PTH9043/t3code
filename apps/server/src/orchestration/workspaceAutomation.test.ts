import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  ProjectId,
  WorkspaceCollaborationRunId,
  type DevelopmentVerification,
  type WorkspaceCollaborationRun,
  type ThreadTokenUsageReport,
} from "@t3tools/contracts";
import { state, task, workspace } from "./workspaceDevelopmentFixtures.ts";
import { automationOverview, readAutomationEvidence } from "./workspaceAutomation.ts";

const generatedAt = "2026-10-11T12:00:00Z";
const verification: DevelopmentVerification = {
  id: "v1",
  workspaceId: workspace.id,
  candidateSha: "candidate",
  requirementRevision: 1,
  generation: 1,
  targetSha: "target",
  status: "passed",
  verifiedAt: generatedAt,
  commands: [
    { command: "node", args: ["--test"], exitCode: 0, timedOut: false, logPath: "placeholder" },
  ],
};
const completed = {
  ...task,
  status: "completed" as const,
  candidateSha: "candidate",
  completedAt: generatedAt,
};

it("links verification and integration artifacts to their exact records and refuses a failed evidence receipt as verified", () => {
  const artifact = {
    relativePath: "result.pdf",
    label: "result.pdf",
    mediaType: "application/pdf" as const,
    snapshotPath: "managed-snapshot.pdf",
    byteLength: 100,
    sha256: "digest",
    error: null,
  };
  const current = {
    ...state,
    tasks: [completed],
    verifications: [{ ...verification, artifacts: [artifact] }],
    integrations: [
      {
        id: "integration",
        verificationIds: [verification.id],
        candidates: ["candidate"],
        expectedTargetSha: "target",
        resultSha: "merged",
        status: "release-ready" as const,
        error: null,
        logPaths: [],
        artifacts: [artifact],
      },
    ],
  };
  const good = automationOverview({
    projectId: state.projectId,
    generatedAt,
    runs: [],
    schedules: [],
    development: current,
  });
  expect(good.metrics.verified).toBe(1);
  expect(
    good.rows[0]?.evidence
      .filter((e) => e.kind.endsWith("artifact"))
      .map((e) => [e.kind, e.recordId, e.index]),
  ).toEqual([
    ["verification-artifact", verification.id, 0],
    ["integration-artifact", "integration", 0],
  ]);
  const bad = automationOverview({
    projectId: state.projectId,
    generatedAt,
    runs: [],
    schedules: [],
    development: {
      ...current,
      verifications: [{ ...verification, artifacts: [{ ...artifact, error: "missing output" }] }],
    },
  });
  expect(bad.metrics.verified).toBe(0);
  expect(bad.rows[0]?.verification).toBe("failed");
});
const run: WorkspaceCollaborationRun = {
  id: WorkspaceCollaborationRunId.make("run"),
  projectId: state.projectId,
  source: "user",
  scheduleId: null,
  incidentId: null,
  task: "Build",
  status: "completed",
  steps: [],
  graph: null,
  meeting: null,
  orchestra: null,
  finalOutput: "All tests passed",
  error: null,
  createdAt: task.requestedAt,
  updatedAt: generatedAt,
};
it("does not count model completion as verified or missing usage as zero", () => {
  const result = automationOverview({
    projectId: state.projectId,
    generatedAt,
    runs: [run],
    schedules: [],
    development: { ...state, tasks: [completed] },
  });
  expect(result.metrics.completed).toBe(2);
  expect(result.metrics.verified).toBe(0);
  expect(result.metrics.measuredTokens).toBeNull();
  expect(result.rows.every((row) => row.verification === "unverified")).toBe(true);
  expect(result.rows.find((row) => row.source === "development")?.retries).toBeNull();
});
it("only counts successful recorded commands at the current requirement and generation", () => {
  const result = (v: DevelopmentVerification, generation = 1) =>
    automationOverview({
      projectId: state.projectId,
      generatedAt,
      runs: [],
      schedules: [],
      development: {
        ...state,
        tasks: [completed],
        workspaces: [{ ...workspace, generation }],
        verifications: [v],
      },
    }).rows[0]?.verification;
  expect(result(verification)).toBe("passed");
  expect(result(verification, 2)).toBe("stale");
  expect(result({ ...verification, requirementRevision: 2 })).toBe("stale");
  expect(result({ ...verification, commands: [] })).toBe("unverified");
  expect(
    result({ ...verification, commands: [{ ...verification.commands[0]!, exitCode: 1 }] }),
  ).toBe("failed");
  expect(
    result({ ...verification, commands: [{ ...verification.commands[0]!, timedOut: true }] }),
  ).toBe("failed");
});
it("bounds the transport window and rejects another project's records", () => {
  const runs = Array.from({ length: 200 }, (_unused, index) => ({
    ...run,
    id: WorkspaceCollaborationRunId.make(`run${index}`),
  }));
  const result = automationOverview({
    projectId: state.projectId,
    generatedAt,
    runs: [...runs, { ...run, projectId: ProjectId.make("other") }],
    schedules: [],
    development: null,
  });
  expect(result.totalRows).toBe(200);
  expect(result.rows).toHaveLength(50);
  expect(
    automationOverview({
      projectId: ProjectId.make("other"),
      generatedAt,
      runs: [],
      schedules: [],
      development: state,
    }).rows,
  ).toEqual([]);
});
it("attributes only the exact work ID and retains partial token coverage", () => {
  const report: ThreadTokenUsageReport = {
    finality: "final",
    outcome: "completed",
    verificationStatus: "not-evaluated",
    collectedSince: generatedAt,
    coverage: "partial",
    work: { workId: "run:run", requestedAt: generatedAt, sequence: 1 },
    counts: {
      total: 123,
      input: 100,
      output: 23,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
    },
    breakdown: [],
    issues: ["native-child-coverage-unknown"],
    inProgress: false,
    recentWorks: [],
    nextBeforeSequence: null,
  };
  const result = (value: ThreadTokenUsageReport) =>
    automationOverview({
      projectId: state.projectId,
      generatedAt,
      runs: [run],
      schedules: [],
      development: null,
      usage: new Map([["run:run", value]]),
    });
  expect(result(report).metrics.measuredTokens).toBe(123);
  expect(result(report).rows[0]?.tokenCoverage).toBe("partial");
  expect(
    result({ ...report, work: { ...report.work!, workId: "other" } }).metrics.measuredTokens,
  ).toBeNull();
});
it.effect(
  "reads bounded recorded logs, redacts secrets, and refuses missing or escaped evidence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const logs = path.join(dir, "workspace-development", "logs");
        yield* fs.makeDirectory(logs, { recursive: true });
        const logPath = path.join(logs, "test.log");
        yield* fs.writeFileString(logPath, `API_KEY=sk-private-token\n${"x".repeat(100_000)}`);
        const dev = {
          ...state,
          verifications: [
            { ...verification, commands: [{ ...verification.commands[0]!, logPath }] },
          ],
        };
        const input = {
          projectId: state.projectId,
          kind: "verification-log" as const,
          recordId: "v1",
          index: 0,
          label: "unused",
        };
        const result = yield* readAutomationEvidence(dev, input, path.join(dir, "state.sqlite"));
        expect(result.truncated).toBe(true);
        expect(result.contents.length).toBeLessThanOrEqual(65_536);
        expect(result.contents).not.toContain("sk-private-token");
        const other = yield* readAutomationEvidence(
          dev,
          { ...input, projectId: ProjectId.make("other") },
          path.join(dir, "state.sqlite"),
        ).pipe(Effect.flip);
        expect(other.message).toContain("프로젝트");
        const missing = yield* readAutomationEvidence(
          dev,
          { ...input, index: 2 },
          path.join(dir, "state.sqlite"),
        ).pipe(Effect.flip);
        expect(missing.message).toContain("없습니다");
        const outside = path.join(dir, "outside.log");
        yield* fs.writeFileString(outside, "private");
        const escaped = yield* readAutomationEvidence(
          {
            ...dev,
            verifications: [
              { ...verification, commands: [{ ...verification.commands[0]!, logPath: outside }] },
            ],
          },
          input,
          path.join(dir, "state.sqlite"),
        ).pipe(Effect.flip);
        expect(escaped.message).toContain("저장 영역 밖");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
