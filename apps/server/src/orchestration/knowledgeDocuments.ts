import {
  isProtectedWorkspaceKnowledgeItem,
  OrchestrationRpcSchemas,
  WorkspaceKnowledgeItemId,
  type OrchestrationCommand,
  type ProjectId,
  type WorkspaceKnowledgeItem,
  type WorkspaceKnowledgeEditInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import {
  knowledgeContentDigest,
  redactConversationRagSensitiveData,
} from "./workspaceConversationRag.ts";

type Upsert = Extract<OrchestrationCommand, { type: "project.knowledge.item.upsert" }>;
type Writer = NonNullable<Upsert["documentWrite"]>;
type List = NonNullable<ProjectionSnapshotQueryShape["listWorkspaceKnowledge"]>;
type Revision =
  (typeof OrchestrationRpcSchemas.listWorkspaceKnowledgeRevisions.output.Type)["revisions"][number];

/** Legacy editors send a full item. Ownership and provenance come from the stored source. */
export function legacyKnowledgeWriteCommand(command: Upsert): Upsert {
  const {
    provenance: _provenance,
    sourceItemId: _source,
    documentWrite: _intent,
    ...fields
  } = command;
  return { ...fields, documentWrite: { mode: "legacy" } };
}

export function knowledgeWriteCommand(
  input: { projectId: ProjectId; itemId: WorkspaceKnowledgeItemId; commandId: Upsert["commandId"] },
  intent: Writer,
  createdAt: string,
): Upsert {
  // The queue resolves these fields from the persisted source after the receipt check.
  return {
    projectId: input.projectId,
    itemId: input.itemId,
    commandId: input.commandId,
    type: "project.knowledge.item.upsert",
    documentWrite: intent,
    createdAt,
    title: "Document edit",
    content: "",
    origin: "user",
    kind: "directive",
    status: "active",
    relativeFolder: null,
    tags: [],
  };
}
export function userKnowledgeForkId(itemId: WorkspaceKnowledgeItemId) {
  return WorkspaceKnowledgeItemId.make("user-document-" + knowledgeContentDigest(itemId, 64));
}

export function makeKnowledgeDocumentQueries(sql: SqlClient.SqlClient, list: List) {
  const visible = (projectId: ProjectId, itemId: WorkspaceKnowledgeItemId) =>
    Effect.gen(function* () {
      const [project] =
        yield* sql`SELECT 1 FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
      if (!project) return undefined;
      const { items } = yield* list({ projectId, itemId, summariesOnly: true });
      return items.find((i) => i.projectId === projectId && i.id === itemId);
    });
  const listWorkspaceKnowledgeRevisions = (
    input: typeof OrchestrationRpcSchemas.listWorkspaceKnowledgeRevisions.input.Type,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* visible(input.projectId, input.itemId)))
            return { revisions: [], nextBeforeSequence: null };
          const size = input.limit ?? 30;
          const rows =
            yield* sql<Revision>`SELECT sequence, occurred_at AS occurredAt, event_type AS eventType
        FROM orchestration_events WHERE aggregate_kind='project' AND stream_id=${input.projectId}
        AND event_type IN ('project.knowledge-item-upserted','project.knowledge-item-archived')
        AND json_extract(payload_json,'$.itemId')=${input.itemId}
        AND (${input.beforeSequence ?? null} IS NULL OR sequence<${input.beforeSequence ?? null})
        ORDER BY sequence DESC LIMIT ${size + 1}`;
          const revisions = rows.slice(0, size);
          return {
            revisions,
            nextBeforeSequence: rows.length > size ? revisions.at(-1)!.sequence : null,
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("knowledgeDocuments.listRevisions")));
  const getWorkspaceKnowledgeRevision = (
    input: typeof OrchestrationRpcSchemas.getWorkspaceKnowledgeRevision.input.Type,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* visible(input.projectId, input.itemId))) return { revision: null };
          const [row] = yield* sql<Revision & { title: string | null; content: string | null }>`
        SELECT sequence, occurred_at AS occurredAt, event_type AS eventType,
          json_extract(payload_json,'$.title') AS title,json_extract(payload_json,'$.content') AS content
        FROM orchestration_events WHERE aggregate_kind='project' AND stream_id=${input.projectId}
        AND json_extract(payload_json,'$.itemId')=${input.itemId} AND sequence=${input.sequence}
        AND event_type IN ('project.knowledge-item-upserted','project.knowledge-item-archived')`;
          const mask = (s: string | null) =>
            s === null ? null : redactConversationRagSensitiveData(s).content;
          return {
            revision: row ? { ...row, title: mask(row.title), content: mask(row.content) } : null,
          };
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("knowledgeDocuments.getRevision")));
  const knowledgeWriteResult = (
    projectId: ProjectId,
    commandId: Upsert["commandId"],
    sequence: number,
  ) =>
    sql<{ itemId: WorkspaceKnowledgeItemId }>`SELECT json_extract(payload_json,'$.itemId') AS itemId
      FROM orchestration_events WHERE sequence=${sequence} AND command_id=${commandId}
      AND stream_id=${projectId} AND aggregate_kind='project' AND event_type='project.knowledge-item-upserted'`.pipe(
      Effect.map((rows) => rows[0]?.itemId),
      Effect.mapError(toPersistenceSqlError("knowledgeDocuments.writeResult")),
    );
  return { listWorkspaceKnowledgeRevisions, getWorkspaceKnowledgeRevision, knowledgeWriteResult };
}

function editedFields(row: WorkspaceKnowledgeItem, edit: WorkspaceKnowledgeEditInput | Upsert) {
  return {
    title: edit.title,
    content: edit.content,
    kind: edit.kind ?? row.kind,
    scope: edit.scope ?? row.scope ?? "project",
    appliesToFolder:
      edit.appliesToFolder === undefined ? (row.appliesToFolder ?? null) : edit.appliesToFolder,
    relativeFolder: edit.relativeFolder === undefined ? row.relativeFolder : edit.relativeFolder,
    tags: edit.tags ?? row.tags,
    research: edit.research === undefined ? (row.research ?? null) : edit.research,
  };
}

export const prepareKnowledgeDocumentWrite = Effect.fn("prepareKnowledgeDocumentWrite")(function* (
  sql: SqlClient.SqlClient,
  list: List,
  command: Upsert,
) {
  const intent = command.documentWrite;
  if (!intent) return command;
  const reject = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: command.type, detail });
  const { items } = yield* list({ projectId: command.projectId, itemId: command.itemId });
  const row = items.find((i) => i.id === command.itemId && i.projectId === command.projectId);
  if (!row) {
    const [existing] = yield* sql`SELECT 1 FROM projection_workspace_knowledge_items
      WHERE project_id=${command.projectId} AND item_id=${command.itemId}`;
    if (intent.mode !== "legacy" || existing || command.itemId.startsWith("user-document-"))
      return yield* reject("The source document is unavailable.");
    return { ...command, origin: "user" as const };
  }
  if (intent.mode === "edit") {
    const [last] = yield* sql<{
      seq: number;
    }>`SELECT coalesce(max(sequence),0) AS seq FROM orchestration_events
      WHERE aggregate_kind='project' AND stream_id=${row.projectId}
      AND event_type IN ('project.knowledge-item-upserted','project.knowledge-item-archived')
      AND json_extract(payload_json,'$.itemId')=${row.id}`;
    if (intent.edit.expectedSequence !== last?.seq)
      return yield* reject("Document changed. Reload before saving.");
  }
  const restore = intent.mode === "restore";
  if (row.status === "archived" && !restore)
    return yield* reject("Restore the archived document before editing.");
  if (restore && row.status !== "archived") return yield* reject("The document is already active.");
  const fork = !restore && isProtectedWorkspaceKnowledgeItem(row);
  const id = fork ? userKnowledgeForkId(row.id) : row.id;
  if (fork) {
    const [existing] =
      yield* sql`SELECT 1 FROM projection_workspace_knowledge_items WHERE project_id=${row.projectId}
      AND (item_id=${id} OR source_item_id=${row.id})`;
    if (existing)
      return yield* reject("A user document already exists for this source. Open it to edit.");
  }
  const fields = restore
    ? {
        title: row.title,
        content: row.content,
        kind: row.kind,
        scope: row.scope ?? "project",
        appliesToFolder: row.appliesToFolder ?? null,
        relativeFolder: row.relativeFolder,
        tags: row.tags,
        research: row.research ?? null,
      }
    : editedFields(row, intent.mode === "edit" ? intent.edit : command);
  return {
    ...command,
    ...fields,
    itemId: id,
    status: restore ? ("active" as const) : row.status,
    origin: fork ? ("user" as const) : row.origin,
    tags: fork
      ? fields.tags.filter(
          (t) =>
            !row.tags.includes(t) ||
            !/^(auto-|original-chars-|stored-chars-|run-|node-|agent-|confidence-|redacted-|deduplicated-|compacted$|bounded$)/u.test(
              t,
            ),
        )
      : fields.tags,
    ...(row.provenance ? { provenance: row.provenance } : {}),
    ...(fork || row.sourceItemId ? { sourceItemId: fork ? row.id : row.sourceItemId! } : {}),
    ...(restore && row.originalChars != null ? { originalChars: row.originalChars } : {}),
    ...(restore && row.storedChars != null ? { storedChars: row.storedChars } : {}),
  } satisfies Upsert;
});
