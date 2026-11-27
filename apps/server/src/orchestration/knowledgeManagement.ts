import type {
  OrchestrationCommand,
  OrchestrationEvent,
  ProjectKnowledgeItemUpsertedPayload,
  WorkspaceKnowledgeItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionWorkspaceKnowledgeDbRow } from "../persistence/Layers/ProjectionWorkspaceKnowledge.ts";
import { knowledgeRevisionSequence, visibleKnowledge } from "../persistence/knowledgeVisibility.ts";
import { toPersistenceDecodeError } from "../persistence/Errors.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** Recaptures can update a source body, while the user's merge stays in the event history. */
export const retainKnowledgeSuccessor = Effect.fn("retainKnowledgeSuccessor")(function* (
  sql: SqlClient.SqlClient,
  event: Omit<OrchestrationEvent, "sequence">,
) {
  if (event.type !== "project.knowledge-item-upserted") return event;
  const payload = event.payload as typeof ProjectKnowledgeItemUpsertedPayload.Type;
  if (payload.supersededBy !== undefined) return event;
  const [previous] = yield* sql<{ supersededBy: WorkspaceKnowledgeItemId }>`
    SELECT superseded_by AS supersededBy FROM projection_workspace_knowledge_items
    WHERE project_id=${payload.projectId} AND item_id=${payload.itemId} AND superseded_by IS NOT NULL`;
  if (!previous) return event;
  return {
    ...event,
    payload: {
      ...payload,
      supersededBy: previous.supersededBy,
      status: payload.status === "archived" ? ("archived" as const) : ("superseded" as const),
    },
  };
});

type ManagementCommand = Extract<
  OrchestrationCommand,
  {
    type:
      | "project.knowledge.bulk"
      | "project.knowledge.search.save"
      | "project.knowledge.search.remove";
  }
>;

export const isKnowledgeManagementCommand = (
  command: OrchestrationCommand,
): command is ManagementCommand =>
  command.type === "project.knowledge.bulk" ||
  command.type === "project.knowledge.search.save" ||
  command.type === "project.knowledge.search.remove";

export const checkKnowledgeSelection = Effect.fn("checkKnowledgeSelection")(function* (
  sql: SqlClient.SqlClient,
  command: ManagementCommand,
) {
  const [project] =
    yield* sql`SELECT 1 FROM projection_projects WHERE project_id=${command.projectId} AND deleted_at IS NULL`;
  if (!project)
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: "Project unavailable.",
    });
  if (command.type !== "project.knowledge.bulk") {
    const [row] = yield* sql<{ updatedAt: string }>`SELECT updated_at AS updatedAt
      FROM workspace_knowledge_saved_searches WHERE project_id=${command.projectId} AND id=${command.id}`;
    if ((row?.updatedAt ?? null) !== command.expectedUpdatedAt) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Saved search has changed. Reload it before saving.",
      });
    }
    return [];
  }
  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Array(Schema.Struct({ id: Schema.String, revisionSequence: Schema.Int })),
    ),
  )(command.items).pipe(Effect.mapError(toPersistenceDecodeError("knowledge selection")));
  const rows =
    yield* sql`SELECT item_id AS id, project_id AS projectId, kind, title, content, status, origin,
    relative_folder AS relativeFolder, scope, applies_to_folder AS appliesToFolder, research_json AS research,
    tags_json AS tags, original_chars AS originalChars, stored_chars AS storedChars, prompt_uses AS promptUses,
    last_used_at AS lastUsedAt, created_at AS createdAt, updated_at AS updatedAt, superseded_by AS supersededBy,
    provenance_json AS provenance, source_item_id AS sourceItemId
    FROM json_each(${encoded}) AS selection
    JOIN projection_workspace_knowledge_items ON item_id=json_extract(selection.value,'$.id')
      AND project_id=${command.projectId}
    WHERE ${knowledgeRevisionSequence(sql)}=json_extract(selection.value,'$.revisionSequence')
      AND ${visibleKnowledge(sql)}`;
  return yield* Schema.decodeUnknownEffect(Schema.Array(ProjectionWorkspaceKnowledgeDbRow))(
    rows,
  ).pipe(Effect.mapError(toPersistenceDecodeError("knowledge selection")));
});
