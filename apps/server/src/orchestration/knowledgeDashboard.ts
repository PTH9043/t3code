import {
  WorkspaceKnowledgeDashboard,
  WorkspaceKnowledgeDashboardFilters,
  type WorkspaceKnowledgeDashboardInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Fragment } from "effect/unstable/sql/Statement";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { knowledgeRevisionSequence, visibleKnowledge } from "../persistence/knowledgeVisibility.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

export const readKnowledgeDashboard = (
  sql: SqlClient.SqlClient,
  input: WorkspaceKnowledgeDashboardInput,
) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        const activeProject = sql`EXISTS (SELECT 1 FROM projection_projects WHERE project_id=${input.projectId} AND deleted_at IS NULL)`;
        const scope = sql`FROM projection_workspace_knowledge_items
      WHERE project_id = ${input.projectId} AND ${activeProject} AND ${visibleKnowledge(sql)}`;
        const limit = input.limit ?? 50;
        const offset = input.offset ?? 0;
        const page = (condition: Fragment, ordering: Fragment) =>
          Effect.gen(function* () {
            const [count] = yield* sql<{
              total: number;
            }>`SELECT COUNT(*) AS total ${scope} AND ${condition}`;
            const items =
              yield* sql`SELECT item_id AS id, title, kind, status, prompt_uses AS promptUses,
          last_used_at AS lastUsedAt, created_at AS createdAt, updated_at AS updatedAt,
          content_hash AS contentHash, superseded_by AS supersededBy, ${knowledgeRevisionSequence(sql)} AS revisionSequence
          ${scope} AND ${condition} ORDER BY ${ordering}, item_id LIMIT ${limit} OFFSET ${offset}`;
            return { total: count!.total, items };
          });
        const byKind = yield* sql<{
          kind: string;
          count: number;
        }>`SELECT kind, count(*) AS count ${scope} GROUP BY kind ORDER BY kind`;
        const byStatus =
          yield* sql`SELECT status, count(*) AS count ${scope} GROUP BY status ORDER BY status`;
        const growth =
          yield* sql`SELECT date(created_at) AS day, count(*) AS count ${scope} GROUP BY day HAVING day IS NOT NULL ORDER BY day`;
        const [compaction] = yield* sql<{
          measuredItems: number;
          originalChars: number;
          storedChars: number;
        }>`
      SELECT count(*) AS measuredItems, COALESCE(sum(original_chars),0) AS originalChars,
        COALESCE(sum(stored_chars),0) AS storedChars ${scope} AND original_chars IS NOT NULL AND stored_chars IS NOT NULL`;
        const query = input.query?.trim() ?? "";
        const filters = sql`${input.kind ? sql`kind = ${input.kind}` : sql`1`}
      AND ${input.origin ? sql`origin = ${input.origin}` : sql`1`}
      AND ${input.status ? sql`status = ${input.status}` : sql`1`}
      AND ${input.usage === "used" ? sql`prompt_uses > 0` : input.usage === "unused" ? sql`prompt_uses = 0` : sql`1`}
      AND ${input.contentHash !== undefined ? sql`content_hash = ${input.contentHash}` : sql`1`}
      AND ${query ? sql`(instr(lower(title),lower(${query})) > 0 OR instr(lower(content),lower(${query})) > 0)` : sql`1`}`;
        const matching = yield* page(filters, sql`updated_at DESC`);
        const candidates = yield* page(sql`status='candidate'`, sql`created_at ASC`);
        const mostUsed = yield* page(
          sql`prompt_uses > 0`,
          sql`prompt_uses DESC, last_used_at DESC`,
        );
        const unused = yield* page(sql`prompt_uses = 0`, sql`created_at ASC`);
        const clusters = sql`${scope} AND content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1`;
        const [duplicateCount] = yield* sql<{
          total: number;
        }>`SELECT COUNT(*) AS total FROM (SELECT 1 ${clusters})`;
        const duplicates =
          yield* sql`SELECT content_hash AS contentHash, COUNT(*) AS count ${clusters}
      ORDER BY count DESC, content_hash LIMIT ${limit} OFFSET ${offset}`;
        const saved = yield* sql<{ id: string; name: string; filters: string; updatedAt: string }>`
      SELECT id, name, filters_json AS filters, updated_at AS updatedAt FROM workspace_knowledge_saved_searches
      WHERE project_id=${input.projectId} AND ${activeProject} ORDER BY name, id`;
        const savedSearches = yield* Effect.forEach(saved, (row) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceKnowledgeDashboardFilters))(
            row.filters,
          ).pipe(Effect.map((filters) => ({ ...row, filters }))),
        );
        return yield* Schema.decodeUnknownEffect(WorkspaceKnowledgeDashboard)({
          projectId: input.projectId,
          measuredAt: DateTime.formatIso(yield* DateTime.now),
          total: byKind.reduce((sum, group) => sum + group.count, 0),
          byKind,
          byStatus,
          growth,
          compaction: {
            ...compaction,
            reductionRatio:
              compaction!.originalChars > 0
                ? 1 - compaction!.storedChars / compaction!.originalChars
                : null,
          },
          matching,
          candidates,
          mostUsed,
          unused,
          duplicates: { total: duplicateCount!.total, items: duplicates },
          savedSearches,
        });
      }),
    )
    .pipe(Effect.mapError(toPersistenceSqlError("KnowledgeDashboard.read")));
