import {
  CommandId,
  ProjectId,
  WorkspaceCollaborationRunId,
  WorkspaceIncidentId,
  WorkspaceProgramId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-09T00:00:00.000Z";

function singleEvent(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  const event = Array.isArray(result) ? result[0] : result;
  if (!event) throw new Error("Expected one event");
  return event;
}

const workspaceReadModel = Effect.gen(function* () {
  const projectId = ProjectId.make("workspace-programs");
  const created = singleEvent(
    yield* decideOrchestrationCommand({
      command: {
        type: "project.create",
        commandId: CommandId.make("create-workspace-programs"),
        projectId,
        title: "Workspace programs",
        workspaceRoot: "D:/workspace-programs",
        createdAt: now,
      },
      readModel: createEmptyReadModel(now),
    }),
  );
  const readModel = yield* projectEvent(createEmptyReadModel(now), {
    ...created,
    sequence: 1,
  } as OrchestrationEvent);
  return { projectId, readModel } as const;
});

it.layer(NodeServices.layer)("Workspace program decider", (it) => {
  it.effect("emits a Workspace-owned program definition without storing environment values", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const programId = WorkspaceProgramId.make("web-dev");
      const event = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.program.upsert",
            commandId: CommandId.make("upsert-web-dev"),
            projectId,
            programId,
            name: "웹 개발 서버",
            command: "npm run dev",
            relativeDirectory: "apps/web",
            environmentVariableNames: ["API_URL"],
            startPolicy: "server-start",
            healthCheck: {
              kind: "http",
              url: "http://127.0.0.1:3000/health",
              expectedStatusMin: 200,
              expectedStatusMax: 399,
              intervalSeconds: 30,
              timeoutSeconds: 5,
              failureThreshold: 3,
            },
            errorPatterns: ["fatal|panic"],
            enabled: true,
            integrityEnabled: true,
            integrityValidationCommands: ["vp test run apps/web/src/example.test.ts"],
            integrityRequiredCleanPasses: 2,
            createdAt: now,
          },
          readModel,
        }),
      );

      expect(event.type).toBe("project.program-upserted");
      if (event.type !== "project.program-upserted") return;
      expect(event.payload.program).toMatchObject({
        id: programId,
        projectId,
        name: "웹 개발 서버",
        environmentVariableNames: ["API_URL"],
        startPolicy: "server-start",
        integrity: {
          enabled: true,
          validationCommands: ["vp test run apps/web/src/example.test.ts"],
          requiredCleanPasses: 2,
          status: "queued",
        },
      });
    }),
  );

  it.effect("keeps repair collaboration linked to its incident", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const incidentId = WorkspaceIncidentId.make("incident-a");
      const runId = WorkspaceCollaborationRunId.make("repair-run-a");
      const event = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.collaboration.run.incident",
            commandId: CommandId.make("repair-incident-a"),
            projectId,
            incidentId,
            runId,
            task: "오류를 수정하고 검증하세요.",
            createdAt: now,
          },
          readModel,
        }),
      );

      expect(event.type).toBe("project.collaboration-run-requested");
      if (event.type !== "project.collaboration-run-requested") return;
      expect(event.payload.run).toMatchObject({
        source: "incident",
        incidentId,
        scheduleId: null,
      });
      expect(event.payload.run.id).toBe(runId);
    }),
  );

  it.effect("emits explicit start, stop, restart, repair, resolve, and remove requests", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const programId = WorkspaceProgramId.make("worker");
      const incidentId = WorkspaceIncidentId.make("incident-worker");
      const commands = [
        { type: "project.program.start", expected: "project.program-start-requested" },
        { type: "project.program.stop", expected: "project.program-stop-requested" },
        { type: "project.program.restart", expected: "project.program-restart-requested" },
        {
          type: "project.program.integrity.start",
          expected: "project.program-integrity-start-requested",
        },
        {
          type: "project.program.integrity.stop",
          expected: "project.program-integrity-stop-requested",
        },
        { type: "project.program.remove", expected: "project.program-removed" },
      ] as const;

      for (const [index, item] of commands.entries()) {
        const event = singleEvent(
          yield* decideOrchestrationCommand({
            command: {
              type: item.type,
              commandId: CommandId.make(`program-action-${index}`),
              projectId,
              programId,
              createdAt: now,
            },
            readModel,
          }),
        );
        expect(event.type).toBe(item.expected);
      }

      const repair = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.program.incident.repair.request",
            commandId: CommandId.make("repair-worker"),
            projectId,
            incidentId,
            instruction: "수정 후 집중 검사를 실행하세요.",
            createdAt: now,
          },
          readModel,
        }),
      );
      const resolve = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.program.incident.resolve",
            commandId: CommandId.make("resolve-worker"),
            projectId,
            incidentId,
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(repair.type).toBe("project.program-incident-repair-requested");
      expect(resolve.type).toBe("project.program-incident-resolve-requested");
    }),
  );
});
