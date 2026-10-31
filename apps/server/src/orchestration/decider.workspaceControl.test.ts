import {
  CommandId,
  DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
  DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
  DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
  ProjectId,
  ProviderInstanceId,
  WorkspaceCollaborationRunId,
  WorkspaceMeetingParticipantId,
  WorkspaceCollaborationRun,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-08T00:00:00.000Z";
const asProjectId = (value: string) => ProjectId.make(value);
function asSingleEvent(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  const event = Array.isArray(result) ? result[0] : result;
  if (!event) throw new Error("Expected one orchestration event");
  return event;
}

it.layer(NodeServices.layer)("Workspace control decider", (it) => {
  it.effect("persists the folder-owned long-term-memory root on project creation", () =>
    Effect.gen(function* () {
      const event = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("create-workspace-a"),
            projectId: asProjectId("workspace-a"),
            title: "Workspace A",
            workspaceRoot: "D:/work/workspace-a",
            longTermMemoryRoot: "F:/NewAutoUsage/workspaces/workspace-a/memory/long-term",
            createdAt: now,
          },
          readModel: createEmptyReadModel(now),
        }),
      );

      expect(event.type).toBe("project.created");
      if (event.type !== "project.created") return;
      expect(event.payload.workspaceControl).toEqual({
        isolationMode: "strict",
        longTermMemoryRoot: "F:/NewAutoUsage/workspaces/workspace-a/memory/long-term",
        conversationRag: DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
        agentKnowledge: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
        monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
        orchestra: DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
      });
    }),
  );

  it.effect("updates and projects Workspace control settings", () =>
    Effect.gen(function* () {
      const projectId = asProjectId("workspace-a");
      const created = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("create-workspace-a"),
            projectId,
            title: "Workspace A",
            workspaceRoot: "D:/work/workspace-a",
            createdAt: now,
          },
          readModel: createEmptyReadModel(now),
        }),
      );
      const createdModel = yield* projectEvent(createEmptyReadModel(now), {
        ...created,
        sequence: 1,
      } as OrchestrationEvent);

      const updated = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.workspace-control.update",
            commandId: CommandId.make("update-workspace-a-memory"),
            projectId,
            longTermMemoryRoot: "F:/LongMemory/workspace-a",
            contextOptimization: {
              memoryMode: "relevant",
              compactHandoffs: true,
              autoChatMemory: true,
            },
            conversationRag: {
              enabled: false,
              redactSensitiveData: true,
              maxInputChars: 12_000,
            },
          },
          readModel: createdModel,
        }),
      );
      expect(updated.type).toBe("project.workspace-control-updated");
      const updatedModel = yield* projectEvent(createdModel, {
        ...updated,
        sequence: 2,
      } as OrchestrationEvent);
      expect(updatedModel.projects[0]?.workspaceControl).toEqual({
        contextOptimization: {
          memoryMode: "relevant",
          compactHandoffs: true,
          autoChatMemory: true,
        },
        isolationMode: "strict",
        longTermMemoryRoot: "F:/LongMemory/workspace-a",
        conversationRag: {
          enabled: false,
          redactSensitiveData: true,
          maxInputChars: 12_000,
        },
        agentKnowledge: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
        monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
        orchestra: DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
      });

      // A later update that only touches agent capture must not reset the
      // conversation settings the previous update established.
      const agentUpdated = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.workspace-control.update",
            commandId: CommandId.make("update-workspace-a-agent-knowledge"),
            projectId,
            longTermMemoryRoot: "F:/LongMemory/workspace-a",
            agentKnowledge: {
              enabled: false,
              redactSensitiveData: false,
              maxOutputChars: 60_000,
            },
          },
          readModel: updatedModel,
        }),
      );
      const agentUpdatedModel = yield* projectEvent(updatedModel, {
        ...agentUpdated,
        sequence: 3,
      } as OrchestrationEvent);
      expect(agentUpdatedModel.projects[0]?.workspaceControl).toEqual({
        contextOptimization: {
          memoryMode: "relevant",
          compactHandoffs: true,
          autoChatMemory: true,
        },
        isolationMode: "strict",
        longTermMemoryRoot: "F:/LongMemory/workspace-a",
        conversationRag: {
          enabled: false,
          redactSensitiveData: true,
          maxInputChars: 12_000,
        },
        agentKnowledge: {
          enabled: false,
          redactSensitiveData: false,
          maxOutputChars: 60_000,
        },
        monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
        orchestra: DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
      });
    }),
  );

  it.effect("rejects equal and nested memory roots across active Workspaces", () =>
    Effect.gen(function* () {
      const firstProjectId = asProjectId("workspace-a");
      const created = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("create-workspace-a"),
            projectId: firstProjectId,
            title: "Workspace A",
            workspaceRoot: "D:/work/workspace-a",
            longTermMemoryRoot: "F:/NewAutoUsage/workspaces/workspace-a/memory/long-term",
            createdAt: now,
          },
          readModel: createEmptyReadModel(now),
        }),
      );
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        ...created,
        sequence: 1,
      } as OrchestrationEvent);

      const error = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("create-workspace-b"),
          projectId: asProjectId("workspace-b"),
          title: "Workspace B",
          workspaceRoot: "D:/work/workspace-b",
          longTermMemoryRoot:
            "f:\\newautousage\\workspaces\\workspace-a\\memory\\long-term\\claude",
          createdAt: now,
        },
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (!("detail" in error)) return;
      expect(error.detail).toContain("overlaps active project 'workspace-a'");
    }),
  );

  it.effect("records project completion attention as a monotonic viewed receipt", () =>
    Effect.gen(function* () {
      const projectId = asProjectId("workspace-viewed");
      const created = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("create-workspace-viewed"),
            projectId,
            title: "Viewed Workspace",
            workspaceRoot: "D:/work/workspace-viewed",
            createdAt: now,
          },
          readModel: createEmptyReadModel(now),
        }),
      );
      const createdModel = yield* projectEvent(createEmptyReadModel(now), {
        ...created,
        sequence: 1,
      } as OrchestrationEvent);
      const firstViewedThrough = "2026-08-08T02:00:00.000Z";
      const viewed = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.runtime.view",
            commandId: CommandId.make("view-workspace"),
            projectId,
            viewedThrough: firstViewedThrough,
            createdAt: "2026-08-08T02:01:00.000Z",
          },
          readModel: createdModel,
        }),
      );
      const viewedModel = yield* projectEvent(createdModel, {
        ...viewed,
        sequence: 2,
      } as OrchestrationEvent);
      const staleView = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.runtime.view",
            commandId: CommandId.make("view-workspace-stale"),
            projectId,
            viewedThrough: "2026-08-08T01:00:00.000Z",
            createdAt: "2026-08-08T02:02:00.000Z",
          },
          readModel: viewedModel,
        }),
      );

      expect(viewed.type).toBe("project.runtime-viewed");
      expect(viewedModel.projects[0]?.runtimeViewedThrough).toBe(firstViewedThrough);
      expect(staleView.type).toBe("project.runtime-viewed");
      if (staleView.type !== "project.runtime-viewed") return;
      expect(staleView.payload.viewedThrough).toBe(firstViewedThrough);
    }),
  );
});

const runJson = Schema.fromJsonString(WorkspaceCollaborationRun);
const encodeRun = Schema.encodeSync(runJson);
const decodeRun = Schema.decodeUnknownSync(runJson);
for (const askFirst of [undefined, false, true]) {
  it.effect(`persists a conductor clarification phase only when askFirst is ${askFirst}`, () =>
    Effect.gen(function* () {
      const projectId = asProjectId("ask-first");
      const created = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("create-ask-first"),
            projectId,
            title: "Ask first",
            workspaceRoot: "D:/ask-first",
            createdAt: now,
          },
          readModel: createEmptyReadModel(now),
        }),
      );
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        ...created,
        sequence: 1,
      } as OrchestrationEvent);
      const result = asSingleEvent(
        yield* decideOrchestrationCommand({
          readModel,
          command: {
            type: "project.collaboration.run.request",
            commandId: CommandId.make("ask-first-run"),
            projectId,
            runId: WorkspaceCollaborationRunId.make("run"),
            task: "질문을 먼저 받으세요",
            createdAt: now,
            meeting: {
              ...(askFirst === undefined ? {} : { askFirst }),
              mode: "fixed-rounds",
              maxRounds: 0,
              userInLoop: false,
              chairParticipantId: WorkspaceMeetingParticipantId.make("second"),
              participants: ["first", "second"].map((id) => ({
                id: WorkspaceMeetingParticipantId.make(id),
                displayName: id,
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
              })),
            },
          },
        }),
      );
      expect(result.type).toBe("project.collaboration-run-requested");
      if (result.type !== "project.collaboration-run-requested") return;
      const persisted = decodeRun(encodeRun(result.payload.run));
      expect(persisted.meeting?.phase).toBe(askFirst ? "clarifying" : "discussing");
      expect(persisted.meeting?.chairParticipantId).toBe("second");
      expect(persisted.graph).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const runtimeMode of ["approval-required", "full-access"] as const) {
  it.effect(`keeps current app policy over saved profile policy (${runtimeMode})`, () =>
    Effect.gen(function* () {
      const projectId = asProjectId("app-policy-profile");
      const created = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("create-policy"),
            projectId,
            title: "App policy",
            workspaceRoot: "D:/app-policy",
            createdAt: now,
          },
          readModel: createEmptyReadModel(now),
        }),
      );
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        ...created,
        sequence: 1,
      } as OrchestrationEvent);
      const meeting = {
        mode: "fixed-rounds" as const,
        maxRounds: 0,
        userInLoop: false,
        chairParticipantId: null,
        participants: ["first", "second"].map((id) => ({
          id: WorkspaceMeetingParticipantId.make(id),
          displayName: id,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        })),
      };
      const result = asSingleEvent(
        yield* decideOrchestrationCommand({
          readModel,
          command: {
            type: "project.collaboration.run.request",
            commandId: CommandId.make("app-policy-run"),
            projectId,
            runId: WorkspaceCollaborationRunId.make("run"),
            task: "research",
            createdAt: now,
            meeting: { ...meeting, runtimeMode, interactionMode: "default" },
            executionProfile: {
              id: "profile",
              name: "Saved profile",
              revision: 1,
              instructions: "research",
              verificationCommands: [],
              orchestra: { maxParallel: 2, isolateWorktrees: false },
              meeting: {
                ...meeting,
                maxRounds: 1,
                runtimeMode: runtimeMode === "full-access" ? "approval-required" : "full-access",
                interactionMode: "plan",
              },
            },
          },
        }),
      );
      expect(result.type).toBe("project.collaboration-run-requested");
      if (result.type !== "project.collaboration-run-requested") return;
      const saved = decodeRun(encodeRun(result.payload.run));
      expect(saved.meeting).toMatchObject({
        runtimeMode,
        interactionMode: "default",
        maxRounds: 1,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
