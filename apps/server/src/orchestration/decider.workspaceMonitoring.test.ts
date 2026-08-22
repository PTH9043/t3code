import {
  CommandId,
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceProgramId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type WorkspaceMonitoringPlan,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-21T00:00:00.000Z";

type Planned = Omit<OrchestrationEvent, "sequence">;

function events(result: Planned | ReadonlyArray<Planned>): ReadonlyArray<Planned> {
  return Array.isArray(result) ? (result as ReadonlyArray<Planned>) : [result as Planned];
}

function singleEvent(result: Planned | ReadonlyArray<Planned>) {
  const [event] = events(result);
  if (!event) throw new Error("Expected one event");
  return event;
}

const apply = (readModel: OrchestrationReadModel, planned: Planned, sequence: number) =>
  projectEvent(readModel, { ...planned, sequence } as OrchestrationEvent);

const samplePlan: WorkspaceMonitoringPlan = {
  revision: 0,
  proposedAt: now,
  approvedAt: null,
  rationale: "dev 서버가 핵심",
  targets: [{ kind: "program", label: "dev", programId: WorkspaceProgramId.make("prog-dev") }],
  metrics: [{ targetIndex: 0, metric: "health", trend: "threshold", windowMin: 5, limit: 3 }],
  playbooks: [{ when: 0, action: "notify-only" }],
};

const workspaceReadModel = Effect.gen(function* () {
  const projectId = ProjectId.make("workspace-a");
  const created = singleEvent(
    yield* decideOrchestrationCommand({
      command: {
        type: "project.create",
        commandId: CommandId.make("create-workspace-a"),
        projectId,
        title: "Workspace A",
        workspaceRoot: "D:/workspace-a",
        createdAt: now,
      },
      readModel: createEmptyReadModel(now),
    }),
  );
  const readModel = yield* apply(createEmptyReadModel(now), created, 1);
  return { projectId, readModel } as const;
});

const monitoringOf = (readModel: OrchestrationReadModel, projectId: ProjectId) =>
  readModel.projects.find((project) => project.id === projectId)?.workspaceControl?.monitoring;

it.layer(NodeServices.layer)("Workspace monitoring decider", (it) => {
  it.effect("turning the switch on rides the workspace-control event and keeps defaults", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const event = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.workspace-control.update",
            commandId: CommandId.make("enable"),
            projectId,
            longTermMemoryRoot: null,
            monitoring: {
              enabled: true,
              autonomy: "ask",
              modelSelection: null,
              checkIntervalSec: 30,
              aiTurnBudget: { perHour: 2, perDay: 10 },
            },
          },
          readModel,
        }),
      );
      expect(event.type).toBe("project.workspace-control-updated");
      const next = yield* apply(readModel, event, 2);
      expect(monitoringOf(next, projectId)).toMatchObject({
        ...DEFAULT_WORKSPACE_MONITORING_SETTINGS,
        enabled: true,
        checkIntervalSec: 30,
        aiTurnBudget: { perHour: 2, perDay: 10 },
        planStatus: "none",
      });
    }),
  );

  it.effect("propose → approve carries the revision and stamps approvedAt", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const proposed = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.monitoring.plan.propose",
            commandId: CommandId.make("propose"),
            projectId,
            plan: samplePlan,
          },
          readModel,
        }),
      );
      const afterPropose = yield* apply(readModel, proposed, 2);
      const monitoring = monitoringOf(afterPropose, projectId);
      expect(monitoring?.planStatus).toBe("proposed");
      expect(monitoring?.plan?.revision).toBe(1);

      const approved = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.monitoring.plan.approve",
            commandId: CommandId.make("approve"),
            projectId,
            revision: 1,
            createdAt: now,
          },
          readModel: afterPropose,
        }),
      );
      const afterApprove = yield* apply(afterPropose, approved, 3);
      expect(monitoringOf(afterApprove, projectId)).toMatchObject({
        planStatus: "approved",
        plan: { revision: 1, approvedAt: expect.any(String) },
      });
    }),
  );

  it.effect("approving a stale revision or a missing proposal is an invariant error", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const missing = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "project.monitoring.plan.approve",
            commandId: CommandId.make("approve-nothing"),
            projectId,
            revision: 1,
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(missing._tag).toBe("Failure");

      const proposed = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.monitoring.plan.propose",
            commandId: CommandId.make("propose"),
            projectId,
            plan: samplePlan,
          },
          readModel,
        }),
      );
      const afterPropose = yield* apply(readModel, proposed, 2);
      const wrongRevision = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "project.monitoring.plan.approve",
            commandId: CommandId.make("approve-old"),
            projectId,
            revision: 7,
            createdAt: now,
          },
          readModel: afterPropose,
        }),
      );
      expect(wrongRevision._tag).toBe("Failure");
    }),
  );

  it.effect("a person-edited plan is approved by definition; 다시 분석 resets to none", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const edited = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.workspace-control.update",
            commandId: CommandId.make("edit-plan"),
            projectId,
            longTermMemoryRoot: null,
            monitoring: {
              enabled: true,
              autonomy: "playbooks",
              modelSelection: null,
              checkIntervalSec: 60,
              aiTurnBudget: { perHour: 4, perDay: 24 },
              plan: samplePlan,
            },
          },
          readModel,
        }),
      );
      const afterEdit = yield* apply(readModel, edited, 2);
      expect(monitoringOf(afterEdit, projectId)).toMatchObject({
        planStatus: "approved",
        autonomy: "playbooks",
        plan: { revision: 1, approvedAt: expect.any(String) },
      });

      const reanalyzed = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.monitoring.reanalyze",
            commandId: CommandId.make("reanalyze"),
            projectId,
            createdAt: now,
          },
          readModel: afterEdit,
        }),
      );
      const afterReanalyze = yield* apply(afterEdit, reanalyzed, 3);
      const monitoring = monitoringOf(afterReanalyze, projectId);
      expect(monitoring?.planStatus).toBe("none");
      // The old plan stays visible until the new proposal replaces it.
      expect(monitoring?.plan?.revision).toBe(1);
    }),
  );

  it.effect("runtime.update patches bookkeeping and only stales an approved plan", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const threadId = ThreadId.make("monitoring-thread");
      const withThread = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.monitoring.runtime.update",
            commandId: CommandId.make("thread"),
            projectId,
            threadId,
            turnLog: [now],
            planStatus: "stale",
          },
          readModel,
        }),
      );
      const next = yield* apply(readModel, withThread, 2);
      expect(monitoringOf(next, projectId)).toMatchObject({
        threadId,
        turnLog: [now],
        // Nothing was approved, so "stale" must not apply.
        planStatus: "none",
      });
    }),
  );

  it.effect("deleting the monitoring thread detaches it from the project", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const threadId = ThreadId.make("monitoring-thread");
      const threadCreated = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.make("create-thread"),
            threadId,
            projectId,
            title: "모니터링 · Workspace A",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          readModel,
        }),
      );
      let model = yield* apply(readModel, threadCreated, 2);
      const attached = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.monitoring.runtime.update",
            commandId: CommandId.make("attach"),
            projectId,
            threadId,
          },
          readModel: model,
        }),
      );
      model = yield* apply(model, attached, 3);
      expect(monitoringOf(model, projectId)?.threadId).toBe(threadId);

      const deleted = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.delete",
            commandId: CommandId.make("delete-thread"),
            threadId,
          },
          readModel: model,
        }),
      );
      expect(deleted.map((event) => event.type)).toEqual([
        "thread.deleted",
        "project.workspace-control-updated",
      ]);
      for (const [index, event] of deleted.entries()) {
        model = yield* apply(model, event, 4 + index);
      }
      expect(monitoringOf(model, projectId)?.threadId).toBeNull();
    }),
  );
});
