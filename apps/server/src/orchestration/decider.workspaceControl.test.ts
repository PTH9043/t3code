import {
  CommandId,
  DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
  ProjectId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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
        isolationMode: "strict",
        longTermMemoryRoot: "F:/LongMemory/workspace-a",
        conversationRag: {
          enabled: false,
          redactSensitiveData: true,
          maxInputChars: 12_000,
        },
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
