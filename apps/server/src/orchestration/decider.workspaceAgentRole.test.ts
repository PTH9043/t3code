import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-08T00:00:00.000Z";

function singleEvent(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  const event = Array.isArray(result) ? result[0] : result;
  if (!event) throw new Error("Expected one event");
  return event;
}

it.layer(NodeServices.layer)("Workspace agent role decider", (it) => {
  it.effect("binds a Workspace role to a specific CLI provider instance", () =>
    Effect.gen(function* () {
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
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        ...created,
        sequence: 1,
      } as OrchestrationEvent);

      const event = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.agent-role.upsert",
            commandId: CommandId.make("bind-workspace-a-coordinator"),
            projectId,
            role: "coordinator",
            displayName: "Claude work coordinator",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claude_work"),
              model: "claude-opus",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            instructions: "Coordinate and finalize Workspace A only.",
            enabled: true,
            createdAt: now,
          },
          readModel,
        }),
      );

      expect(event.type).toBe("project.agent-role-upserted");
      if (event.type !== "project.agent-role-upserted") return;
      expect(event.payload).toMatchObject({
        projectId,
        role: "coordinator",
        modelSelection: { instanceId: "claude_work" },
      });
    }),
  );

  it.effect("rejects role bindings for an unknown Workspace", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "project.agent-role.upsert",
          commandId: CommandId.make("bind-missing-workspace"),
          projectId: ProjectId.make("missing-workspace"),
          role: "implementer",
          displayName: "Codex implementer",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex_work"),
            model: "gpt-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          instructions: "Implement changes.",
          enabled: true,
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
