import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const visibleOriginal = (sql: SqlClient.SqlClient) => sql`(
            item_id NOT LIKE 'conversation-%' OR tags_json NOT LIKE '%"auto-conversation"%'
            OR NOT EXISTS (
              SELECT 1 FROM workspace_memory_v2 forgotten
              WHERE forgotten.project_id = projection_workspace_knowledge_items.project_id
                AND forgotten.status = 'forgotten'
                AND CASE WHEN json_valid(forgotten.source_json)
                  THEN json_extract(forgotten.source_json, '$.kind') END = 'message'
            )
            OR EXISTS (
              SELECT 1 FROM workspace_conversation_rag_sources source
              WHERE source.project_id = projection_workspace_knowledge_items.project_id
                AND source.item_id = projection_workspace_knowledge_items.item_id
                AND (source.source_kind <> 'message' OR (
                  EXISTS (SELECT 1 FROM projection_thread_messages message
                    JOIN projection_threads thread ON thread.thread_id = message.thread_id
                    WHERE message.message_id = source.source_id AND message.thread_id = source.thread_id
                      AND thread.project_id = source.project_id AND thread.deleted_at IS NULL)
                  AND NOT EXISTS (
                    SELECT 1 FROM workspace_memory_v2 forgotten
                    WHERE forgotten.project_id = source.project_id AND forgotten.status = 'forgotten'
                      AND CASE WHEN json_valid(forgotten.source_json)
                        AND json_extract(forgotten.source_json, '$.kind') = 'message'
                        THEN json_extract(forgotten.source_json, '$.id') END = source.source_id
                  )
                ))
            )
          )`;

export const knowledgeRevisionSequence = (sql: SqlClient.SqlClient) => sql`COALESCE((
  SELECT sequence FROM orchestration_events
  WHERE aggregate_kind='project' AND stream_id=projection_workspace_knowledge_items.project_id
    AND event_type IN ('project.knowledge-item-upserted','project.knowledge-item-archived')
    AND json_extract(payload_json,'$.itemId')=projection_workspace_knowledge_items.item_id
  ORDER BY sequence DESC LIMIT 1), 0)`;

export const visibleKnowledge = (sql: SqlClient.SqlClient) => sql`(${visibleOriginal(sql)}
  AND (source_item_id IS NULL OR EXISTS (
    SELECT 1 FROM (SELECT project_id,item_id FROM projection_workspace_knowledge_items
      WHERE ${visibleOriginal(sql)}) AS original
    WHERE original.project_id=projection_workspace_knowledge_items.project_id
      AND original.item_id=projection_workspace_knowledge_items.source_item_id)))`;
