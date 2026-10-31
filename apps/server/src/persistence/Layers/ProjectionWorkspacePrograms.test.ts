import {
  DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
  DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
  ProjectId,
  WorkspaceIncidentId,
  WorkspaceProgramId,
  WorkspaceProgramRunId,
  type WorkspaceIncident,
  type WorkspaceProgram,
  type WorkspaceProgramRun,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionWorkspaceProgramRepository } from "../Services/ProjectionWorkspacePrograms.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionWorkspaceProgramRepositoryLive } from "./ProjectionWorkspacePrograms.ts";

const layer = it.layer(
  ProjectionWorkspaceProgramRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const at = "2026-08-09T00:00:00.000Z";

function program(projectId: ProjectId, id: WorkspaceProgramId, name: string): WorkspaceProgram {
  return {
    id,
    projectId,
    name,
    command: "npm run dev",
    relativeDirectory: "",
    environmentVariableNames: ["API_URL"],
    startPolicy: "manual",
    healthCheck: null,
    errorPatterns: ["fatal|panic"],
    enabled: true,
    integrity: DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
    hubMemory: DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
    createdAt: at,
    updatedAt: at,
  };
}

function run(
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  id: WorkspaceProgramRunId,
): WorkspaceProgramRun {
  return {
    id,
    projectId,
    programId,
    status: "running",
    pid: 1234,
    startedAt: at,
    stoppedAt: null,
    exitCode: null,
    exitSignal: null,
    healthStatus: "healthy",
    consecutiveHealthFailures: 0,
    lastHealthCheckAt: at,
    lastHealthFailure: null,
    recentLogTail: "ready",
    updatedAt: at,
  };
}

function incident(
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  runId: WorkspaceProgramRunId,
  id: WorkspaceIncidentId,
): WorkspaceIncident {
  return {
    id,
    projectId,
    programId,
    runId,
    kind: "log-pattern",
    severity: "error",
    status: "awaiting-user",
    fingerprint: "same-fingerprint",
    summary: "오류 로그가 감지됐습니다.",
    evidence: "fatal: example",
    occurrenceCount: 1,
    firstOccurredAt: at,
    lastOccurredAt: at,
    diagnosisThreadId: null,
    diagnosis: "테스트 진단",
    repairRunId: null,
    resolvedAt: null,
    updatedAt: at,
  };
}

layer("ProjectionWorkspaceProgramRepository", (it) => {
  it.effect("isolates identical program ids by Workspace and cascades only the removed owner", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceProgramRepository;
      const workspaceA = ProjectId.make("workspace-program-a");
      const workspaceB = ProjectId.make("workspace-program-b");
      for (const projectId of [workspaceA, workspaceB]) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, workspace_control_json, created_at, updated_at, deleted_at
          ) VALUES (
            ${projectId}, ${projectId}, ${`D:/${projectId}`}, NULL, '[]',
            '{"isolationMode":"strict","longTermMemoryRoot":null}',
            ${at}, ${at}, NULL
          )
        `;
      }

      const sharedProgramId = WorkspaceProgramId.make("dev");
      const runA = WorkspaceProgramRunId.make("program-run-a");
      const runB = WorkspaceProgramRunId.make("program-run-b");
      const incidentA = WorkspaceIncidentId.make("program-incident-a");
      const incidentB = WorkspaceIncidentId.make("program-incident-b");

      const hubMemory = {
        commitLimitMb: 256,
        concurrencyGroup: "research",
        concurrencySlots: 2,
        sharedDatasets: [{ name: "EVENTS", relativeSource: "data/events.jsonl" }],
      };
      const programA = { ...program(workspaceA, sharedProgramId, "A 개발 서버"), hubMemory };
      yield* repository.upsertProgram(programA);
      expect(
        yield* repository.getProgram({ projectId: workspaceA, programId: sharedProgramId }),
      ).toEqual(Option.some(programA));
      yield* repository.upsertProgram({
        ...programA,
        hubMemory: { ...hubMemory, commitLimitMb: 512 },
      });
      expect(
        yield* repository.getProgram({ projectId: workspaceA, programId: sharedProgramId }),
      ).toEqual(Option.some({ ...programA, hubMemory: { ...hubMemory, commitLimitMb: 512 } }));
      yield* repository.upsertProgram(program(workspaceB, sharedProgramId, "B 개발 서버"));
      yield* repository.upsertRun(run(workspaceA, sharedProgramId, runA));
      yield* repository.upsertRun(run(workspaceB, sharedProgramId, runB));
      yield* repository.upsertIncident(incident(workspaceA, sharedProgramId, runA, incidentA));
      yield* repository.upsertIncident(incident(workspaceB, sharedProgramId, runB, incidentB));

      expect(yield* repository.listPrograms(workspaceA)).toEqual([
        expect.objectContaining({ projectId: workspaceA, name: "A 개발 서버" }),
      ]);
      expect(yield* repository.listPrograms(workspaceB)).toEqual([
        expect.objectContaining({ projectId: workspaceB, name: "B 개발 서버" }),
      ]);
      expect(
        Option.isNone(
          yield* repository.getProgram({ projectId: workspaceB, programId: sharedProgramId }),
        ),
      ).toBe(false);
      expect(
        yield* repository.findOpenIncidentByFingerprint({
          projectId: workspaceA,
          programId: sharedProgramId,
          fingerprint: "same-fingerprint",
        }),
      ).toEqual(Option.some(expect.objectContaining({ id: incidentA })));
      expect(yield* repository.listActiveRuns()).toHaveLength(2);
      expect(yield* repository.listRecoverableIncidents()).toEqual([]);

      yield* repository.removeProgram({ projectId: workspaceA, programId: sharedProgramId });

      expect(yield* repository.listPrograms(workspaceA)).toEqual([]);
      expect(yield* repository.listRuns({ projectId: workspaceA })).toEqual([]);
      expect(yield* repository.listIncidents({ projectId: workspaceA })).toEqual([]);
      expect(yield* repository.listPrograms(workspaceB)).toHaveLength(1);
      expect(yield* repository.listRuns({ projectId: workspaceB })).toHaveLength(1);
      expect(yield* repository.listIncidents({ projectId: workspaceB })).toHaveLength(1);
    }),
  );

  it.effect(
    "persists health configuration, bounded history filters, and incident status filters",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* ProjectionWorkspaceProgramRepository;
        const projectId = ProjectId.make("workspace-program-filters");
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, workspace_control_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, ${projectId}, ${`D:/${projectId}`}, NULL, '[]',
          '{"isolationMode":"strict","longTermMemoryRoot":null}',
          ${at}, ${at}, NULL
        )
      `;
        const programId = WorkspaceProgramId.make("web");
        yield* repository.upsertProgram({
          ...program(projectId, programId, "웹 서버"),
          startPolicy: "server-start",
          healthCheck: {
            kind: "tcp",
            host: "127.0.0.1",
            port: 3000,
            intervalSeconds: 30,
            timeoutSeconds: 5,
            failureThreshold: 3,
          },
          integrity: {
            ...DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
            enabled: true,
            validationCommands: ["vp test run apps/web/src/example.test.ts"],
            status: "queued",
            updatedAt: at,
          },
        });
        const stored = Option.getOrThrow(yield* repository.getProgram({ projectId, programId }));
        expect(stored).toMatchObject({
          startPolicy: "server-start",
          environmentVariableNames: ["API_URL"],
          healthCheck: { kind: "tcp", port: 3000 },
          integrity: {
            enabled: true,
            validationCommands: ["vp test run apps/web/src/example.test.ts"],
            status: "queued",
          },
        });
        expect(yield* repository.listIntegrityPrograms()).toHaveLength(1);
        yield* repository.updateIntegrity({
          projectId,
          programId,
          integrity: {
            ...stored.integrity,
            status: "converged",
            consecutiveCleanPasses: 2,
            summary: "두 번 연속 독립 검증 통과",
            convergedAt: at,
            updatedAt: at,
          },
        });
        expect(yield* repository.listIntegrityPrograms()).toEqual([]);
        expect(
          Option.getOrThrow(yield* repository.getProgram({ projectId, programId })).integrity,
        ).toMatchObject({ status: "converged", consecutiveCleanPasses: 2 });

        const runId = WorkspaceProgramRunId.make("filter-run");
        yield* repository.upsertRun({
          ...run(projectId, programId, runId),
          recentLogTail: "x".repeat(9_000),
        });
        const unresolved = {
          ...incident(
            projectId,
            programId,
            runId,
            WorkspaceIncidentId.make("filter-incident-open"),
          ),
          evidence: "e".repeat(5_000),
          diagnosis: "d".repeat(9_000),
        } satisfies WorkspaceIncident;
        yield* repository.upsertIncident(unresolved);
        yield* repository.upsertIncident({
          ...unresolved,
          id: WorkspaceIncidentId.make("filter-incident-resolved"),
          status: "resolved",
          resolvedAt: at,
        });
        yield* repository.upsertIncident({
          ...unresolved,
          id: WorkspaceIncidentId.make("filter-incident-verifying"),
          status: "verifying",
        });

        const listedIncidents = yield* repository.listIncidents({
          projectId,
          statuses: ["awaiting-user"],
        });
        expect(listedIncidents).toEqual([expect.objectContaining({ status: "awaiting-user" })]);
        expect(listedIncidents[0]?.evidence).toHaveLength(4_096);
        expect(listedIncidents[0]?.diagnosis).toHaveLength(8_192);
        expect(
          Option.getOrThrow(yield* repository.getIncident({ projectId, incidentId: unresolved.id }))
            .evidence,
        ).toHaveLength(5_000);
        expect(yield* repository.listRecoverableIncidents()).toEqual([
          expect.objectContaining({ status: "verifying" }),
        ]);
        const listedRuns = yield* repository.listRuns({ projectId, programId, limit: 1 });
        expect(listedRuns).toHaveLength(1);
        expect(listedRuns[0]?.recentLogTail).toHaveLength(8_192);
      }),
  );
});
