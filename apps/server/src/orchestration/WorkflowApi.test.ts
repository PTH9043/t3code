import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceMeetingParticipantId,
  type WorkspaceAgentRole,
} from "@t3tools/contracts";
import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { workflowDefaults } from "@t3tools/shared/workflow";
import { OrchestrationLayerLive } from "./runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { makeWorkspaceWorkflow } from "./WorkflowApi.ts";
import { WorkspaceWorkflowStore } from "../persistence/WorkspaceWorkflowStore.ts";
import { compileWorkflowRun } from "./workspaceWorkflow.ts";
import { resolveNodeAssignmentRoute } from "./workspaceMeeting.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const now = "2026-10-26T00:00:00.000Z";
const layer = it.layer(
  OrchestrationLayerLive.pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-test-" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  ),
);
let nextId = 0;
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-workspace-" });
  const projectId = ProjectId.make(`workflow-test-${++nextId}`);
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`create:${projectId}`),
    projectId,
    title: "Workflow test",
    workspaceRoot,
    defaultModelSelection: null,
    createdAt: now,
  });
  for (const role of ["coordinator", "implementer", "researcher"] as WorkspaceAgentRole[]) {
    yield* engine.dispatch({
      type: "project.agent-role.upsert",
      commandId: CommandId.make(`role:${projectId}:${role}`),
      projectId,
      role,
      displayName: role,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      instructions: "Keep user conditions",
      enabled: true,
      createdAt: now,
    });
  }
  const api = yield* makeWorkspaceWorkflow;
  const definition = workflowDefaults()[0]!;
  const saved = yield* api.save({ projectId, definition, expectedRevision: 0, archived: false });
  return { projectId, engine, api, saved };
});

layer("Workflow command/event/projection integration", (it) => {
  it.effect(
    "starts an AI-planned run through the unified API with the selected model and policy",
    () =>
      Effect.gen(function* () {
        const { projectId, engine, api } = yield* setup;
        const threadId = ThreadId.make(`${projectId}:unified-chat`);
        const selected = { instanceId: ProviderInstanceId.make("codex"), model: "user-selected" };
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "Unified chat",
          modelSelection: selected,
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        const input = {
          projectId,
          task: "Build the requested feature",
          requestId: "unified-auto",
          threadId,
          roleModels: { coordinator: selected, implementer: selected, researcher: selected },
          runtimeMode: "full-access" as const,
          interactionMode: "plan" as const,
          requestMode: "ask-first" as const,
        };
        const run = yield* api.start(input);
        expect(run.workflow).toBeNull();
        expect(run.runContext?.threadId).toBe(threadId);
        expect(run.runContext?.requestMode).toBe("ask-first");
        expect(
          run.runContext?.roleBindings
            ?.filter((role) => role.enabled)
            .map((role) => ({
              model: role.modelSelection.model,
              runtimeMode: role.runtimeMode,
              interactionMode: role.interactionMode,
            })),
        ).toEqual([
          { model: "user-selected", runtimeMode: "full-access", interactionMode: "plan" },
          { model: "user-selected", runtimeMode: "full-access", interactionMode: "plan" },
          { model: "user-selected", runtimeMode: "full-access", interactionMode: "plan" },
        ]);
        expect((yield* api.start(input)).id).toBe(run.id);
        expect(
          Exit.isFailure(yield* Effect.exit(api.start({ ...input, task: "Different task" }))),
        ).toBe(true);
        const overview = yield* api.overview({ projectId });
        expect(overview.allRuns?.find((item) => item.id === run.id)).toMatchObject({
          title: input.task,
          workflowRevision: null,
          control: "active",
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              api.start({
                ...input,
                requestId: "needs-confirmation",
                requestMode: "conditions",
                conditionsConfirmed: false,
              }),
            ),
          ),
        ).toBe(true);
      }),
  );
  it.effect(
    "uses the same run controls for an AI-planned task and preserves a newer pause against stale updates",
    () =>
      Effect.gen(function* () {
        const { projectId, engine, api } = yield* setup;
        const runId = WorkspaceCollaborationRunId.make(`${projectId}:ai-task`);
        yield* engine.dispatch({
          type: "project.collaboration.run.request",
          commandId: CommandId.make(`${runId}:start`),
          projectId,
          runId,
          task: "Plan and implement the task",
          createdAt: now,
        });
        const initial = yield* api.getRun({ projectId, runId });
        expect(initial.workflow).toBeNull();
        expect(initial.runControl).toMatchObject({ control: "active", controlRevision: 0 });
        const paused = yield* api.control({
          projectId,
          runId,
          expectedRevision: 0,
          action: "pause",
        });
        expect(paused.runControl).toMatchObject({ control: "pause-requested", controlRevision: 1 });
        yield* engine.dispatch({
          type: "project.collaboration.run.update",
          commandId: CommandId.make(`${runId}:late-update`),
          run: { ...initial, status: "running" },
        });
        expect((yield* api.getRun({ projectId, runId })).runControl).toMatchObject({
          control: "pause-requested",
          controlRevision: 1,
        });
        const resumed = yield* api.control({
          projectId,
          runId,
          expectedRevision: 1,
          action: "resume",
        });
        expect(resumed.runControl).toMatchObject({ control: "active", controlRevision: 2 });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              api.control({ projectId, runId, expectedRevision: 1, action: "pause" }),
            ),
          ),
        ).toBe(true);
      }),
  );
  it.effect("requires confirmed delivery evidence before retrying an AI-planned step", () =>
    Effect.gen(function* () {
      const { projectId, engine, api, saved } = yield* setup;
      const selected = { instanceId: ProviderInstanceId.make("codex"), model: "selected" };
      const planned = yield* api.start({
        projectId,
        task: "AI planned",
        requestId: "retry-auto",
        roleModels: { coordinator: selected, implementer: selected, researcher: selected },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const savedRun = yield* api.start({
        projectId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "fixture" },
        requestId: "retry-template",
      });
      const graph = compileWorkflowRun(savedRun);
      const failed = {
        ...planned,
        status: "failed" as const,
        graph: {
          ...graph,
          status: "failed" as const,
          nodes: graph.nodes.map((node) =>
            node.id === "analyze"
              ? { ...node, status: "failed" as const, error: "fixture", completedAt: now }
              : node,
          ),
        },
      };
      yield* engine.dispatch({
        type: "project.collaboration.run.update",
        commandId: CommandId.make(`${planned.id}:failed`),
        run: failed,
      });
      const retry = {
        projectId,
        runId: planned.id,
        expectedRevision: 0,
        action: "retry" as const,
        nodeId: "analyze",
      };
      expect(Exit.isFailure(yield* Effect.exit(api.control(retry)))).toBe(true);
      const delivery = {
        projectId,
        runId: planned.id,
        nodeId: "analyze",
        executionId: `${planned.id}:analyze:1`,
        createdAt: now,
      };
      yield* engine.dispatch({
        type: "project.workflow.delivery",
        commandId: CommandId.make(`${planned.id}:intent`),
        ...delivery,
        phase: "submitting",
        confirmed: false,
      });
      expect(Exit.isFailure(yield* Effect.exit(api.control(retry)))).toBe(true);
      yield* engine.dispatch({
        type: "project.workflow.delivery",
        commandId: CommandId.make(`${planned.id}:stopped`),
        ...delivery,
        phase: "stopped",
        confirmed: true,
      });
      const retried = yield* api.control(retry);
      expect(retried.runControl?.executionRevision).toBe(1);
      expect(retried.graph?.nodes.find((node) => node.id === "analyze")?.status).toBe("queued");
      yield* engine.dispatch({
        type: "project.collaboration.run.update",
        commandId: CommandId.make(`${planned.id}:late-failure`),
        run: failed,
      });
      expect((yield* api.getRun({ projectId, runId: planned.id })).status).toBe("running");
    }),
  );
  it.effect("pins selected role models and an existing chat without changing project roles", () =>
    Effect.gen(function* () {
      const { projectId, api, saved, engine } = yield* setup;
      const threadId = ThreadId.make(`${projectId}:chat`);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${projectId}:chat`),
        threadId,
        projectId,
        title: "Existing chat",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "chat-model" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "project.agent-role.upsert",
        commandId: CommandId.make(`${projectId}:disable-coordinator`),
        projectId,
        role: "coordinator",
        displayName: "Fable",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "old-model" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        instructions: "Keep project instructions",
        enabled: false,
        createdAt: now,
      });
      const models = {
        coordinator: { instanceId: ProviderInstanceId.make("codex"), model: "lead" },
        implementer: { instanceId: ProviderInstanceId.make("codex"), model: "build" },
        researcher: { instanceId: ProviderInstanceId.make("codex"), model: "research" },
      };
      const input = {
        projectId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "model fixture" },
        requestId: "role-models",
        threadId,
        roleModels: models,
        runtimeMode: "auto-accept-edits" as const,
        interactionMode: "default" as const,
      };
      const run = yield* api.start(input);
      expect(run.workflow?.threadId).toBe(threadId);
      for (const role of ["coordinator", "implementer", "researcher"] as const) {
        expect(run.workflow?.roleBindings.find((entry) => entry.role === role)).toMatchObject({
          enabled: true,
          displayName: models[role].model,
          modelSelection: models[role],
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
        });
      }
      expect(compileWorkflowRun(run).nodes.some((node) => node.kind === "validation")).toBe(true);
      expect((yield* api.start(input)).id).toBe(run.id);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            api.start({ ...input, roleModels: { ...models, coordinator: models.implementer } }),
          ),
        ),
      ).toBe(true);
      const query = yield* ProjectionSnapshotQuery;
      const savedRoles = yield* query.listWorkspaceAgentRoles!({ projectId });
      expect(savedRoles.roles.find((entry) => entry.role === "coordinator")).toMatchObject({
        enabled: false,
        displayName: "Fable",
        modelSelection: { model: "old-model" },
        instructions: "Keep project instructions",
      });
      const same = {
        coordinator: models.coordinator,
        implementer: models.coordinator,
        researcher: models.coordinator,
      };
      const singleRun = yield* api.start({ ...input, roleModels: same, requestId: "single-model" });
      expect(
        singleRun.workflow?.roleBindings
          .filter((role) => role.enabled)
          .map((role) => role.modelSelection.model),
      ).toEqual(["lead", "lead", "lead"]);
      for (const node of compileWorkflowRun(singleRun).nodes) {
        expect(
          resolveNodeAssignmentRoute({
            node,
            meeting: singleRun.meeting,
            bindings: singleRun.workflow!.roleBindings,
          })?.modelSelection,
        ).toEqual(models.coordinator);
      }
    }),
  );
  it.effect("rejects an execution thread from a different project", () =>
    Effect.gen(function* () {
      const { projectId, api, saved, engine } = yield* setup;
      const foreign = yield* setup;
      const threadId = ThreadId.make(`${foreign.projectId}:chat`);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${foreign.projectId}:thread`),
        threadId,
        projectId: foreign.projectId,
        title: "Foreign chat",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            api.start({
              projectId,
              definitionId: saved.id,
              revision: saved.revision,
              values: { goal: "fixture" },
              requestId: "foreign-chat",
              threadId,
            }),
          ),
        ),
      ).toBe(true);
    }),
  );
  it.effect(
    "preserves meeting participants while routing workflow validation through the selected coordinator",
    () =>
      Effect.gen(function* () {
        const { projectId, api, saved } = yield* setup;
        const participants = ["first", "second"].map((id) => ({
          id: WorkspaceMeetingParticipantId.make(id),
          displayName: id,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: `${id}-meeting` },
        }));
        const chosen = { instanceId: ProviderInstanceId.make("codex"), model: "workflow-model" };
        const run = yield* api.start({
          projectId,
          definitionId: saved.id,
          revision: saved.revision,
          values: { goal: "meeting workflow" },
          requestId: "meeting-role-models",
          meeting: {
            mode: "fixed-rounds",
            participants,
            chairParticipantId: participants[0]!.id,
            maxRounds: 0,
            userInLoop: false,
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
          roleModels: { coordinator: chosen, implementer: chosen, researcher: chosen },
          runtimeMode: "approval-required",
          interactionMode: "default",
        });
        expect(run.meeting?.participants).toEqual(participants);
        expect(
          compileWorkflowRun(run).nodes.find((node) => node.kind === "validation"),
        ).toMatchObject({
          role: "coordinator",
          participantId: null,
        });
      }),
  );
  it.effect("keeps the chosen roster and profile while applying the chat policy", () =>
    Effect.gen(function* () {
      const { projectId, api, saved } = yield* setup;
      const participants = ["seat-a", "seat-b"].map((id) => ({
        id: WorkspaceMeetingParticipantId.make(id),
        displayName: id,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "fixture-model",
          options: [{ id: "effort", value: "high" }],
        },
      }));
      const profile = {
        id: "chosen-profile",
        name: "Chosen profile",
        revision: 3,
        instructions: "Keep profile instructions",
        verificationCommands: [],
        meeting: {
          mode: "fixed-rounds" as const,
          participants,
          chairParticipantId: participants[0]!.id,
          maxRounds: 0,
          userInLoop: true,
          runtimeMode: "approval-required" as const,
          interactionMode: "plan" as const,
        },
        orchestra: { maxParallel: 6, isolateWorktrees: false },
      };
      const run = yield* api.start({
        projectId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "profile fixture" },
        requestId: "chat-roster",
        executionProfile: profile,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      expect(run.meeting?.participants).toEqual(participants);
      expect(run.meeting?.runtimeMode).toBe("full-access");
      expect(run.meeting?.interactionMode).toBe("default");
      expect(run.orchestra?.maxParallel).toBe(6);
      const auto = yield* api.start({
        projectId,
        task: "profile auto task",
        requestId: "profile-auto",
        executionProfile: profile,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      expect(auto.meeting?.participants).toEqual(participants);
      expect(auto.meeting?.runtimeMode).toBe("full-access");
      expect(auto.runContext?.roleBindings).toBeUndefined();
    }),
  );
  it.effect("keeps chat permissions without changing role accounts or project defaults", () =>
    Effect.gen(function* () {
      const { projectId, api, saved } = yield* setup;
      const input = {
        projectId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "chat workflow" },
        requestId: "chat-policy",
        runtimeMode: "auto-accept-edits" as const,
        interactionMode: "default" as const,
        requestMode: "ask-first" as const,
      };
      const run = yield* api.start(input);
      expect(run.workflow?.roleBindings).toHaveLength(3);
      for (const role of run.workflow!.roleBindings) {
        expect(role.runtimeMode).toBe("auto-accept-edits");
        expect(role.interactionMode).toBe("default");
        expect(role.modelSelection).toEqual({ instanceId: "codex", model: "fixture-model" });
        expect(role.instructions).toBe("Keep user conditions");
      }
      expect((yield* api.start(input)).id).toBe(run.id);
      expect(
        Exit.isFailure(yield* Effect.exit(api.start({ ...input, runtimeMode: "full-access" }))),
      ).toBe(true);
      const inherited = yield* api.start({
        projectId,
        definitionId: saved.id,
        revision: saved.revision,
        values: input.values,
        requestId: "project-policy-still-preserved",
      });
      expect(
        inherited.workflow?.roleBindings.every(
          (role) => role.runtimeMode === "approval-required" && role.interactionMode === "plan",
        ),
      ).toBe(true);
    }),
  );
  it.effect("finds a pinned skill in an older version without trusting a new snapshot path", () =>
    Effect.gen(function* () {
      const { projectId, saved, engine } = yield* setup;
      const store = yield* WorkspaceWorkflowStore;
      const binding = {
        name: "fixture",
        path: "/original/SKILL.md",
        provider: "codex" as const,
        digest: "a".repeat(64),
        arguments: "old",
        mode: "native" as const,
        snapshotPath: "/cache/digest/source/SKILL.md",
      };
      const oldVersion = {
        ...saved,
        revision: 2,
        digest: "b".repeat(64),
        nodes: saved.nodes.map((node, index) =>
          index === 0 ? { ...node, skills: [binding] } : node,
        ),
      };
      yield* engine.dispatch({
        type: "project.workflow.save",
        commandId: CommandId.make(`${projectId}:skill-v2`),
        projectId,
        definition: oldVersion,
        expectedRevision: 1,
      });
      yield* engine.dispatch({
        type: "project.workflow.save",
        commandId: CommandId.make(`${projectId}:skill-v3`),
        projectId,
        definition: { ...saved, revision: 3, digest: "c".repeat(64) },
        expectedRevision: 2,
      });
      expect((yield* store.get(projectId, saved.id))?.nodes[0]?.skills).toHaveLength(0);
      expect(
        yield* store.retainedBinding(projectId, saved.id, { ...binding, arguments: "new" }),
      ).toEqual(binding);
      expect(
        yield* store.retainedBinding(projectId, saved.id, {
          ...binding,
          snapshotPath: "/untrusted/SKILL.md",
        }),
      ).toBeNull();
      expect(yield* store.retainedBinding(projectId, "another-workflow", binding)).toBeNull();
      expect(
        yield* store.retainedBinding(ProjectId.make("another-project"), saved.id, binding),
      ).toBeNull();
    }),
  );
  it.effect(
    "rejects unknown retry, preserves completed nodes and fences late results after retry",
    () =>
      Effect.gen(function* () {
        const { projectId, api, saved, engine } = yield* setup;
        const run = yield* api.start({
          projectId,
          definitionId: saved.id,
          revision: 1,
          values: { goal: "retry fixture" },
          requestId: "retry-generation",
        });
        const graph = compileWorkflowRun(run);
        const failed: typeof run = {
          ...run,
          status: "failed",
          graph: {
            ...graph,
            status: "failed",
            nodes: graph.nodes.map((node) =>
              node.status === "completed"
                ? node
                : { ...node, status: "failed", error: "fixture", completedAt: now },
            ),
          },
        };
        yield* engine.dispatch({
          type: "project.collaboration.run.update",
          commandId: CommandId.make(`${run.id}:failed`),
          run: failed,
        });
        const delivery = {
          projectId,
          runId: run.id,
          nodeId: "analyze",
          executionId: `${run.id}:analyze:1`,
          createdAt: now,
        };
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${run.id}:intent`),
          ...delivery,
          phase: "submitting",
          confirmed: false,
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              api.control({
                projectId,
                runId: run.id,
                expectedRevision: 0,
                action: "retry",
                nodeId: "analyze",
              }),
            ),
          ),
        ).toBe(true);
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${run.id}:stopped`),
          ...delivery,
          phase: "stopped",
          confirmed: true,
        });
        const retried = yield* api.control({
          projectId,
          runId: run.id,
          expectedRevision: 0,
          action: "retry",
          nodeId: "analyze",
        });
        expect(retried.workflow?.executionRevision).toBe(1);
        expect(retried.graph?.nodes.find((node) => node.id === "plan")?.output).toBe(
          graph.nodes.find((node) => node.id === "plan")?.output,
        );
        expect(retried.graph?.nodes.find((node) => node.id === "analyze")?.status).toBe("queued");
        expect(retried.graph?.nodes.find((node) => node.id === "execute")?.status).toBe("blocked");
        yield* engine.dispatch({
          type: "project.collaboration.run.update",
          commandId: CommandId.make(`${run.id}:late-result`),
          run: failed,
        });
        const current = yield* api.getRun({ projectId, runId: run.id });
        expect(current.status).toBe("running");
        expect(current.workflow?.executionRevision).toBe(1);
        const summary = (yield* api.overview({ projectId })).runs[0]!;
        expect(summary.status).toBe("running");
        expect(summary.counts.completed).toBe(1);
        expect("graph" in summary).toBe(false);
      }),
  );
  it.effect(
    "stores immutable versions in the existing event stream and rejects concurrent stale saves",
    () =>
      Effect.gen(function* () {
        const { projectId, api, saved } = yield* setup;
        const events = yield* OrchestrationEventStore;
        const store = yield* WorkspaceWorkflowStore;
        const next = yield* api.save({
          projectId,
          definition: { ...saved, title: "Updated" },
          expectedRevision: 1,
          archived: false,
        });
        expect(next.revision).toBe(2);
        expect((yield* store.get(projectId, saved.id, 1))?.title).toBe(saved.title);
        const stale = yield* Effect.exit(
          api.save({ projectId, definition: saved, expectedRevision: 1, archived: false }),
        );
        expect(Exit.isFailure(stale)).toBe(true);
        const rows = yield* Stream.runCollect(events.readAll());
        expect(
          Array.from(rows).filter(
            (event) => event.aggregateId === projectId && event.type === "project.workflow-saved",
          ),
        ).toHaveLength(2);
      }),
  );

  it.effect("deduplicates starts, rejects changed duplicate input and pins role permissions", () =>
    Effect.gen(function* () {
      const { projectId, api, saved } = yield* setup;
      const input = {
        projectId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "fixture goal" },
        requestId: "same-start",
        requestMode: "ask-first" as const,
      };
      const first = yield* api.start(input);
      // The pre-chat request fingerprint for the unchanged fixture wire payload.
      expect(first.workflow?.requestDigest).toBe(
        "4ffa5a2dcfe9d3a9deba91800b110378ea4dc16951da5b46a026a5569486a765",
      );
      const repeated = yield* api.start(input);
      expect(repeated.id).toBe(first.id);
      expect((yield* api.overview({ projectId })).runs).toHaveLength(1);
      expect(
        first.workflow?.roleBindings.every(
          (role) => role.runtimeMode === "approval-required" && role.interactionMode === "plan",
        ),
      ).toBe(true);
      expect(first.workflow?.requestMode).toBe("ask-first");
      expect(
        Exit.isFailure(yield* Effect.exit(api.start({ ...input, values: { goal: "different" } }))),
      ).toBe(true);
      const graph = compileWorkflowRun(first);
      expect(
        graph.nodes.some(
          (node) => node.id === "analyze" && node.handoff.task.includes("fixture goal"),
        ),
      ).toBe(true);
      expect(graph.nodes.some((node) => node.kind === "validation")).toBe(true);
      expect(graph.nodes.some((node) => node.kind === "synthesis")).toBe(true);
    }),
  );

  it.effect("preserves pause and resume revisions and rejects stale controls", () =>
    Effect.gen(function* () {
      const { projectId, api, saved } = yield* setup;
      const run = yield* api.start({
        projectId,
        definitionId: saved.id,
        revision: 1,
        values: { goal: "pause fixture" },
        requestId: "pause-start",
      });
      const paused = yield* api.control({
        projectId,
        runId: run.id,
        expectedRevision: 0,
        action: "pause",
      });
      expect(paused.workflow?.control).toBe("pause-requested");
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            api.control({ projectId, runId: run.id, expectedRevision: 0, action: "resume" }),
          ),
        ),
      ).toBe(true);
      const resumed = yield* api.control({
        projectId,
        runId: run.id,
        expectedRevision: 1,
        action: "resume",
      });
      expect(resumed.workflow?.control).toBe("active");
      expect(resumed.workflow?.controlRevision).toBe(2);
      const cancelled = yield* api.control({
        projectId,
        runId: run.id,
        expectedRevision: 2,
        action: "cancel",
      });
      expect(cancelled.status).toBe("cancel-requested");
    }),
  );

  it.effect("retains archived versions and requires the selected condition confirmation", () =>
    Effect.gen(function* () {
      const { projectId, api, saved } = yield* setup;
      const input = {
        projectId,
        definitionId: saved.id,
        revision: 1,
        values: { goal: "fixture" },
        requestId: "conditions-start",
        requestMode: "conditions" as const,
      };
      expect(Exit.isFailure(yield* Effect.exit(api.start(input)))).toBe(true);
      const run = yield* api.start({ ...input, conditionsConfirmed: true });
      expect(run.workflow?.requestMode).toBe("conditions");
      yield* api.save({ projectId, definition: saved, expectedRevision: 1, archived: true });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            api.start({ ...input, requestId: "archived", conditionsConfirmed: true }),
          ),
        ),
      ).toBe(true);
      expect(run.workflow?.definition.revision).toBe(1);
    }),
  );

  it.effect(
    "records submission intent before delivery and keeps unknown attempts unsafe for retry",
    () =>
      Effect.gen(function* () {
        const { projectId, api, saved, engine } = yield* setup;
        const run = yield* api.start({
          projectId,
          definitionId: saved.id,
          revision: 1,
          values: { goal: "delivery fixture" },
          requestId: "delivery-start",
        });
        const store = yield* WorkspaceWorkflowStore;
        const executionId = `${run.id}:analyze:1`;
        const base = { projectId, runId: run.id, nodeId: "analyze", executionId, createdAt: now };
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${executionId}:intent`),
          ...base,
          phase: "submitting",
          confirmed: false,
        });
        expect(yield* store.retrySafe(run.id, "analyze")).toBe(false);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              engine.dispatch({
                type: "project.workflow.delivery",
                commandId: CommandId.make(`${executionId}:duplicate`),
                ...base,
                phase: "submitting",
                confirmed: false,
              }),
            ),
          ),
        ).toBe(true);
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${executionId}:accepted`),
          ...base,
          phase: "accepted",
          confirmed: false,
        });
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${executionId}:unknown-stop`),
          ...base,
          phase: "stopped",
          confirmed: false,
        });
        expect(yield* store.retrySafe(run.id, "analyze")).toBe(false);
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${executionId}:confirmed-stop`),
          ...base,
          phase: "stopped",
          confirmed: true,
        });
        expect(yield* store.retrySafe(run.id, "analyze")).toBe(true);
      }),
  );
});
