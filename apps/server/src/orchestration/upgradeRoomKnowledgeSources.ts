// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import {
  DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
  DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
  WorkspaceResearchRecord,
  type WorkspaceKnowledgeOrigin,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { buildSearchQuery, termCoverage } from "../persistence/searchText.ts";
import { matchedMemoryExcerpt } from "./memoryRetrieval.ts";
import { compactKnowledgeContent } from "./workspaceConversationRag.ts";

const decodeResearch = Schema.decodeUnknownSync(Schema.fromJsonString(WorkspaceResearchRecord));

export function normalizeRoot(input: string) {
  const windows = /^(?:[a-z]:[/\\]|[/\\]{2})/i.test(input);
  if (!windows && (NodePath.sep === "\\" || !NodePath.posix.isAbsolute(input))) return undefined;
  const flavor = windows ? NodePath.win32 : NodePath.posix;
  const normalized = flavor.resolve(input);
  const root = flavor.parse(normalized).root;
  const value = normalized === root ? root : normalized.replace(/[/\\]+$/, "");
  return windows ? value.toLowerCase() : value;
}

export function currentProject(db: NodeSqlite.DatabaseSync, root: string) {
  const expected = normalizeRoot(root);
  const matches = db
    .prepare("SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL")
    .all()
    .filter(
      (row) =>
        typeof row.workspace_root === "string" && normalizeRoot(row.workspace_root) === expected,
    );
  if (!expected || matches.length !== 1 || typeof matches[0]?.project_id !== "string") {
    throw new Error("Expected exactly one active project at the upgrade launcher root.");
  }
  return { id: matches[0].project_id };
}

export interface BridgeSource {
  source: string;
  id: string;
  title: string;
  content: string;
  origin: WorkspaceKnowledgeOrigin;
  updatedAt: string;
  originalChars: number;
  research?: WorkspaceResearchRecord;
  sourceItemId?: string;
}
export interface KnowledgeHit {
  projectId: string;
  source: string;
  id: string;
  title: string;
  excerpt: string;
  updatedAt: string;
  score: number;
  origin: WorkspaceKnowledgeOrigin;
  bridgeAncestorId?: string;
}

// Each branch is evaluated inside the same SQLite snapshot as the content read.
// For old conversation captures without a resolvable source, fail closed.
function visibilityCte(singleItem = false) {
  return `WITH RECURSIVE
  ${
    singleItem
      ? `ancestors(id) AS (SELECT $id UNION SELECT k.source_item_id
    FROM ancestors a JOIN projection_workspace_knowledge_items k ON k.item_id=a.id
    WHERE k.project_id=$project AND k.source_item_id IS NOT NULL),`
      : ""
  }
  hidden(kind,id) AS NOT MATERIALIZED (
    SELECT source_json->>'$.kind', source_json->>'$.id' FROM workspace_memory_v2
    WHERE project_id=$project AND status IN ('archived','forgotten') AND json_valid(source_json)
  ),
  live_threads AS NOT MATERIALIZED (
    SELECT thread_id FROM projection_threads WHERE project_id=$project
      AND archived_at IS NULL AND deleted_at IS NULL AND ($thread IS NULL OR thread_id=$thread)
  ),
  live_messages AS NOT MATERIALIZED (
    SELECT m.message_id, m.thread_id FROM projection_thread_messages m
    JOIN live_threads t ON t.thread_id=m.thread_id
    WHERE NOT EXISTS (SELECT 1 FROM hidden WHERE kind='message' AND id=m.message_id)
  ),
  control AS (SELECT workspace_control_json AS settings FROM projection_projects WHERE project_id=$project),
  base AS (
    SELECT k.item_id,k.source_item_id FROM projection_workspace_knowledge_items k,control
    WHERE k.project_id=$project AND k.status='active' AND k.superseded_by IS NULL AND k.scope='project'
      ${singleItem ? "AND k.item_id IN (SELECT id FROM ancestors)" : ""}
      AND NOT EXISTS (SELECT 1 FROM hidden WHERE kind='knowledge' AND id=k.item_id)
      AND (k.provenance_json->>'$.threadId' IS NULL OR k.provenance_json->>'$.threadId' IN (SELECT thread_id FROM live_threads))
      AND (k.research_json->>'$.attachment.messageId' IS NULL OR EXISTS (SELECT 1 FROM live_messages
        WHERE message_id=k.research_json->>'$.attachment.messageId' AND thread_id=k.research_json->>'$.attachment.threadId'))
      AND (k.research_json->>'$.lineage.validFrom' IS NULL OR julianday(k.research_json->>'$.lineage.validFrom') <= julianday('now'))
      AND (k.research_json->>'$.lineage.validTo' IS NULL OR julianday(k.research_json->>'$.lineage.validTo') > julianday('now'))
      AND (instr(k.tags_json,'"auto-agent-output"')=0 OR coalesce(settings->>'$.agentKnowledge.enabled',1)=1)
      AND (instr(k.tags_json,'"auto-conversation"')=0 OR (coalesce(settings->>'$.conversationRag.enabled',1)=1
        AND EXISTS (SELECT 1 FROM workspace_conversation_rag_sources s JOIN live_threads t ON t.thread_id=s.thread_id
          WHERE s.project_id=k.project_id AND s.item_id=k.item_id AND (s.source_kind='answer' OR
            (s.source_kind='message' AND EXISTS (SELECT 1 FROM live_messages m
              WHERE m.message_id=s.source_id AND m.thread_id=s.thread_id))))))
  ),
  eligible(id,bridge_id) AS (
    SELECT item_id,CASE WHEN item_id LIKE 'upgrade-room-%' THEN item_id END FROM base WHERE source_item_id IS NULL
    UNION ALL SELECT b.item_id,coalesce(e.bridge_id,CASE WHEN b.item_id LIKE 'upgrade-room-%' THEN b.item_id END)
      FROM base b JOIN eligible e ON b.source_item_id=e.id
  )`;
}
const knowledgeCte = visibilityCte();

const knowledge = `SELECT 'knowledge' AS source,k.item_id AS id,k.title,k.content,k.origin,k.updated_at AS updatedAt,
    e.bridge_id AS bridgeId,k.research_json->'$.contextTopics' AS contextTopics
  FROM projection_workspace_knowledge_items k JOIN eligible e ON e.id=k.item_id
  WHERE k.project_id=$project`;

const manual = `SELECT 'manual' AS source,r.id,r.topic AS title,r.text AS content,
  CASE WHEN r.origin='user-requested' THEN 'user' ELSE 'agent' END AS origin,r.updated_at AS updatedAt,NULL AS bridgeId,NULL AS contextTopics
  FROM workspace_memory_v2 r WHERE r.project_id=$project AND r.scope='project'
    AND r.status IN ('pending','consolidated','observed') AND r.source_json->>'$.kind'='manual'
    AND coalesce(r.source_json->>'$.projectId',$project)=$project
    AND coalesce(r.source_json->>'$.folder','')=''`;

// Conversation inputs and question answers use the normal auto-conversation projector.
// The assistant's final reply is a separate source; partial provider deltas never enter it.
const replies = `SELECT 'reply' AS source,m.message_id AS id,'Upgrade room · assistant' AS title,
    m.text AS content,'agent' AS origin,m.updated_at AS updatedAt,NULL AS bridgeId,NULL AS contextTopics
  FROM projection_thread_messages m JOIN live_messages l ON l.message_id=m.message_id, control
  WHERE m.thread_id=$thread AND m.role='assistant' AND m.is_streaming=0
    AND coalesce(settings->>'$.conversationRag.enabled',1)=1
    AND coalesce(settings->>'$.agentKnowledge.enabled',1)=1
    AND EXISTS (SELECT 1 FROM projection_turns turn WHERE turn.thread_id=m.thread_id
      AND turn.turn_id=m.turn_id AND turn.state='completed' AND turn.assistant_message_id=m.message_id)`;

const roomSources = `${knowledge} UNION ALL ${manual} UNION ALL ${replies}`;

export function listRoomSources(db: NodeSqlite.DatabaseSync, project: string, thread: string) {
  return db
    .prepare(`${knowledgeCte} SELECT source,id FROM (${roomSources})`)
    .all({ project, thread }) as { source: string; id: string }[];
}

function toSource(row: Record<string, unknown>): BridgeSource {
  const { id, title, content, origin, updatedAt, source } = row;
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof content !== "string" ||
    typeof updatedAt !== "string" ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    (origin !== "user" && origin !== "agent" && origin !== "imported") ||
    typeof source !== "string"
  ) {
    throw new Error("Invalid projected upgrade source.");
  }
  return { id, title, content, updatedAt, source, origin, originalChars: content.length };
}

function compact(db: NodeSqlite.DatabaseSync, project: string, row: BridgeSource) {
  const limits = db
    .prepare(`SELECT
    workspace_control_json->>'$.conversationRag.redactSensitiveData' AS redactInput,
    workspace_control_json->>'$.conversationRag.maxInputChars' AS maxInput,
    workspace_control_json->>'$.agentKnowledge.redactSensitiveData' AS redactOutput,
    workspace_control_json->>'$.agentKnowledge.maxOutputChars' AS maxOutput
    FROM projection_projects WHERE project_id=?`)
    .get(project)!;
  const agent = row.origin === "agent";
  const limit = agent ? limits.maxOutput : limits.maxInput;
  const settings = {
    redactSensitiveData: (agent ? limits.redactOutput : limits.redactInput) !== 0,
    maxChars:
      typeof limit === "number"
        ? limit
        : agent
          ? DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS.maxOutputChars
          : DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS.maxInputChars,
  };
  const body = compactKnowledgeContent(row.content, settings);
  const title = compactKnowledgeContent(row.title, settings)?.content;
  return body && title ? { ...row, title, content: body.content } : undefined;
}

function roomSourceRow(
  db: NodeSqlite.DatabaseSync,
  project: string,
  thread: string | null,
  source: string,
  id: string,
  fields: "*" | "1",
) {
  if (source === "knowledge") {
    return db
      .prepare(`${visibilityCte(true)} SELECT ${fields} FROM (${knowledge} AND k.item_id=$id)`)
      .get({ project, thread, id });
  } else if (source === "reply") {
    return db
      .prepare(`${knowledgeCte} SELECT ${fields} FROM (${replies} AND m.message_id=$id)`)
      .get({ project, thread, id });
  } else if (source === "manual") {
    return db.prepare(`SELECT ${fields} FROM (${manual} AND r.id=$id)`).get({ project, id });
  }
  return undefined;
}

export function roomSourceExists(
  db: NodeSqlite.DatabaseSync,
  project: string,
  thread: string | null,
  source: string,
  id: string,
) {
  return !!roomSourceRow(db, project, thread, source, id, "1");
}

export function knowledgeAncestors(db: NodeSqlite.DatabaseSync, project: string, id: string) {
  return db
    .prepare(`WITH RECURSIVE parents(id) AS (
    SELECT source_item_id FROM projection_workspace_knowledge_items WHERE project_id=? AND item_id=?
    UNION SELECT k.source_item_id FROM projection_workspace_knowledge_items k JOIN parents p ON p.id=k.item_id
    WHERE k.project_id=? AND k.source_item_id IS NOT NULL)
    SELECT id FROM parents WHERE id IS NOT NULL`)
    .all(project, id, project)
    .map((row) => String(row.id));
}

export function getRoomSource(
  db: NodeSqlite.DatabaseSync,
  project: string,
  thread: string,
  source: string,
  id: string,
) {
  const row = roomSourceRow(db, project, thread, source, id, "*");
  if (!row) return undefined;
  const item = compact(db, project, toSource(row));
  if (!item || source !== "knowledge") return item;
  const metadata = db
    .prepare(`SELECT research_json,source_item_id,original_chars FROM projection_workspace_knowledge_items
    WHERE project_id=? AND item_id=?`)
    .get(project, id);
  if (typeof metadata?.research_json === "string") {
    item.research = decodeResearch(metadata.research_json);
  }
  if (typeof metadata?.source_item_id === "string") item.sourceItemId = metadata.source_item_id;
  if (typeof metadata?.original_chars === "number") item.originalChars = metadata.original_chars;
  return item;
}

// Ranked FTS passages cover the complete indexed primary RAG corpus. Never select a
// chunk independently of its current owning knowledge row and revision.
export function findKnowledge(
  db: NodeSqlite.DatabaseSync,
  project: string,
  query: string,
  thread: string | null = null,
  forPrompt = false,
): KnowledgeHit[] {
  const parsed = buildSearchQuery(query);
  if (!parsed) return [];
  const params = { project, thread, match: parsed.match };
  const indexed = db
    .prepare(`${knowledgeCte} SELECT 'knowledge' AS source,k.item_id AS id,
    k.title,c.content,k.origin,k.updated_at AS updatedAt,e.bridge_id AS bridgeId,k.research_json->'$.contextTopics' AS contextTopics FROM projection_workspace_rag_chunks c
    JOIN eligible e ON e.id=c.item_id JOIN projection_workspace_knowledge_items k ON k.item_id=c.item_id AND k.project_id=c.project_id
    WHERE c.project_id=$project AND c.updated_at=k.updated_at AND projection_workspace_rag_chunks MATCH $match
    ORDER BY bm25(projection_workspace_rag_chunks) LIMIT 64`)
    .all(params);
  const memoryVisibility = ` AND r.project_id=$project AND r.scope='project'
      AND r.status IN ('pending','consolidated') AND r.source_json->>'$.kind'='message'
      AND coalesce(settings->>'$.conversationRag.enabled',1)=1
      AND $thread IS NULL AND EXISTS (SELECT 1 FROM workspace_memory_v2_message_folders folder
        WHERE folder.project_id=$project AND folder.folder='' AND folder.message_id=(
          SELECT u.message_id FROM projection_thread_messages u
          WHERE u.thread_id=m.thread_id AND u.role='user' AND u.rowid<=(
            SELECT rowid FROM projection_thread_messages WHERE message_id=m.message_id)
          ORDER BY u.rowid DESC LIMIT 1))
      AND NOT EXISTS (SELECT 1 FROM workspace_conversation_rag_sources s
        WHERE s.project_id=$project AND s.source_kind='message' AND s.source_id=m.message_id AND s.item_id NOT IN (SELECT id FROM eligible))`;
  function memoryMatches(long: boolean) {
    // Legacy memory cards contain only the leading excerpt of long messages.
    // The chunk-state version must still identify the live message.
    const table = long ? "workspace_memory_v2_chunks" : "workspace_memory_v2_fts";
    const field = long ? "f.chunk_text" : "r.text";
    return db
      .prepare(`${knowledgeCte} SELECT 'message' AS source,r.id,r.topic AS title,${field} AS content,
      CASE WHEN r.origin='user' THEN 'user' ELSE 'agent' END AS origin,r.updated_at AS updatedAt
      FROM ${table} f JOIN workspace_memory_v2 r ON r.id=${long ? "f.memory_id" : "f.id"}
      JOIN live_messages m ON m.message_id=r.source_json->>'$.id' AND m.thread_id=r.source_json->>'$.threadId'
      ${
        long
          ? `JOIN workspace_memory_v2_chunk_state state ON state.memory_id=r.id AND state.project_id=r.project_id
        AND state.source_kind='message' AND state.source_id=m.message_id
        JOIN projection_thread_messages raw ON raw.message_id=m.message_id AND state.source_version=raw.updated_at ||
          CASE WHEN instr(raw.text,char(0))>0 THEN ':nul-v1:' || length(CAST(raw.text AS BLOB)) ELSE ':' || length(raw.text) END`
          : ""
      }
      ,control WHERE ${table} MATCH $match ${memoryVisibility}
      ORDER BY bm25(${table}) LIMIT 64`)
      .all(params);
  }
  const memory = thread === null ? [...memoryMatches(false), ...memoryMatches(true)] : [];
  // Core knowledge kinds have no RAG chunk index. Search them together with explicit notes.
  const other = db
    .prepare(`${knowledgeCte} SELECT * FROM (
    ${knowledge} AND k.kind NOT IN ('rag-source','long-term-memory')
    UNION ALL ${manual} ${thread ? "UNION ALL " + replies : ""})
    WHERE EXISTS (SELECT 1 FROM json_each($terms) WHERE instr(lower(title || ' ' || content),value)>0)
    ORDER BY updatedAt DESC,id LIMIT 64`)
    .all({ project, thread, terms: JSON.stringify(parsed.terms) });
  const hits = new Map<string, KnowledgeHit>();
  for (const row of [...indexed, ...memory, ...other]) {
    const raw = toSource(row);
    if (forPrompt && typeof row.contextTopics === "string") {
      const topics: unknown = JSON.parse(row.contextTopics);
      const task = query.normalize("NFKC").toLowerCase();
      if (
        !Array.isArray(topics) ||
        !topics.some(
          (t) => typeof t === "string" && task.includes(t.normalize("NFKC").toLowerCase()),
        )
      )
        continue;
    }
    const item = thread ? compact(db, project, raw) : raw;
    if (!item) continue;
    const key = JSON.stringify([item.source, item.id]);
    const score = termCoverage(parsed.terms, item.content) + termCoverage(parsed.terms, item.title);
    if ((hits.get(key)?.score ?? -1) >= score) continue;
    hits.set(key, {
      projectId: project,
      source: item.source,
      id: item.id,
      title: item.title,
      origin: item.origin,
      ...(typeof row.bridgeId === "string" ? { bridgeAncestorId: row.bridgeId } : {}),
      excerpt: matchedMemoryExcerpt(item.content, parsed.terms, 1000),
      updatedAt: item.updatedAt,
      score,
    });
  }
  return [...hits.values()];
}
