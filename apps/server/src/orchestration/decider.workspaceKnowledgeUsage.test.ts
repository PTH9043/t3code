import {
  CommandId,
  ProjectId,
  WorkspaceKnowledgeItemId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-08T00:00:00.000Z";
const projectId = ProjectId.make("workspace-a");

function asSingleEvent(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  const event = Array.isArray(result) ? result[0] : result;
  if (!event) throw new Error("Expected one orchestration event");
  return event;
}

const createdProject = Effect.gen(function* () {
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
  return yield* projectEvent(createEmptyReadModel(now), {
    ...created,
    sequence: 1,
  } as OrchestrationEvent);
});

it.layer(NodeServices.layer)("Workspace knowledge usage decider", (it) => {
  it.effect("records the items a composed prompt actually used", () =>
    Effect.gen(function* () {
      const readModel = yield* createdProject;
      const event = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.knowledge.usage.record",
            commandId: CommandId.make("record-usage"),
            projectId,
            itemIds: [
              WorkspaceKnowledgeItemId.make("item-a"),
              WorkspaceKnowledgeItemId.make("item-b"),
            ],
            usedAt: "2026-08-09T00:00:00.000Z",
          },
          readModel,
        }),
      );

      expect(event.type).toBe("project.knowledge-usage-recorded");
      if (event.type !== "project.knowledge-usage-recorded") return;
      expect(event.payload).toEqual({
        projectId,
        itemIds: ["item-a", "item-b"],
        usedAt: "2026-08-09T00:00:00.000Z",
      });
      expect(event.occurredAt).toBe("2026-08-09T00:00:00.000Z");
    }),
  );

  it.effect("collapses a repeated item so one composition counts once", () =>
    Effect.gen(function* () {
      const readModel = yield* createdProject;
      const event = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.knowledge.usage.record",
            commandId: CommandId.make("record-usage-duplicate"),
            projectId,
            // The composer can reach the same item through both the knowledge
            // list and a RAG match.
            itemIds: [
              WorkspaceKnowledgeItemId.make("item-a"),
              WorkspaceKnowledgeItemId.make("item-a"),
              WorkspaceKnowledgeItemId.make("item-b"),
            ],
            usedAt: "2026-08-09T00:00:00.000Z",
          },
          readModel,
        }),
      );

      if (event.type !== "project.knowledge-usage-recorded") throw new Error("unexpected event");
      expect(event.payload.itemIds).toEqual(["item-a", "item-b"]);
    }),
  );

  it.effect("refuses to record usage for a project that does not exist", () =>
    Effect.gen(function* () {
      const failure = yield* decideOrchestrationCommand({
        command: {
          type: "project.knowledge.usage.record",
          commandId: CommandId.make("record-usage-missing"),
          projectId: ProjectId.make("missing-workspace"),
          itemIds: [WorkspaceKnowledgeItemId.make("item-a")],
          usedAt: "2026-08-09T00:00:00.000Z",
        },
        readModel: createEmptyReadModel(now),
      }).pipe(Effect.flip);

      expect(failure).toBeDefined();
    }),
  );
});
