import {
  OrchestrationThreadActivity,
  ToolActivitySummaryFact,
  type ToolActivitySummaryInput,
  type ToolActivitySummaryResult,
} from "@t3tools/contracts";
import { buildToolActivityFacts, groupToolActivities } from "@t3tools/shared/toolActivity";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  projectActivityPayload,
  projectThreadActivities,
} from "../orchestration/ActivityPayloadProjection.ts";
import { withSavedToolActivityEvidence } from "../orchestration/SavedToolActivityEvidence.ts";
import { factualToolActivitySummary, makeToolActivitySummarizer } from "../toolActivitySummary.ts";

const decodeActivity = Schema.decodeUnknownSync(OrchestrationThreadActivity);
const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeFact = Schema.decodeUnknownSync(ToolActivitySummaryFact);
const summarizers = new WeakMap<
  SqlClient.SqlClient,
  ReturnType<typeof makeToolActivitySummarizer>
>();

export const readSavedToolActivityFact = Effect.fn("readSavedToolActivityFact")(
  function* (sql: SqlClient.SqlClient, input: ToolActivitySummaryInput) {
    // Resolve the anchor and its own turn within the same read snapshot. A legacy activity
    // without a turn can only describe itself. The room and the project must still exist.
    const rows = yield* sql<{
      id: string;
      tone: string;
      kind: string;
      summary: string;
      payload: string;
      turnId: string | null;
      sequence: number | null;
      createdAt: string;
    }>`
    WITH anchor AS (
      SELECT a.activity_id, a.thread_id, a.turn_id FROM projection_thread_activities a
      JOIN projection_threads t ON t.thread_id = a.thread_id AND t.deleted_at IS NULL
      JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
      WHERE a.activity_id = ${input.activityId} AND a.thread_id = ${input.threadId}
        AND a.kind IN ('tool.started', 'tool.progress', 'tool.updated', 'tool.completed')
    )
    SELECT a.activity_id AS id, a.tone, a.kind, a.summary, a.payload_json AS payload,
           a.turn_id AS turnId, a.sequence, a.created_at AS createdAt
    FROM anchor JOIN projection_thread_activities a ON a.thread_id = anchor.thread_id
    WHERE (a.turn_id = anchor.turn_id OR a.activity_id = anchor.activity_id)
      AND a.kind IN ('tool.started', 'tool.progress', 'tool.updated', 'tool.completed')
    ORDER BY a.sequence, a.created_at, a.activity_id
  `;
    const activities = yield* Effect.try(() =>
      rows.map((row) =>
        decodeActivity({
          ...row,
          sequence: row.sequence ?? undefined,
          payload: decodePayload(row.payload),
        }),
      ),
    );
    if (activities.length === 0) return null;
    const enriched = yield* withSavedToolActivityEvidence(input.threadId, activities);
    return yield* Effect.try(() => {
      const requested = decodeFact(input.fact);
      const match = (projected: readonly OrchestrationThreadActivity[]) => {
        const group = groupToolActivities(projected).find((item) => item.id === input.activityId);
        if (!group) return null;
        const [verified] = buildToolActivityFacts([group]);
        return verified && Equal.equals(decodeFact(verified), requested) ? verified : null;
      };
      const matchViews = (items: readonly OrchestrationThreadActivity[]) =>
        match(projectThreadActivities(items)) ?? match(items.map(projectActivityPayload));
      // A live client may already hold receipts from before history was enriched.
      return matchViews(enriched) ?? (enriched === activities ? null : matchViews(activities));
    });
  },
  Effect.orElseSucceed(() => null),
);

function forEnvironment(sql: SqlClient.SqlClient) {
  const prior = summarizers.get(sql);
  if (prior) return prior;
  const summarize = makeToolActivitySummarizer();
  summarizers.set(sql, summarize);
  return summarize;
}

export const summarizeSavedToolActivity = Effect.fn("summarizeSavedToolActivity")(function* (
  sql: SqlClient.SqlClient,
  input: ToolActivitySummaryInput,
  summarize: ReturnType<typeof makeToolActivitySummarizer> = forEnvironment(sql),
): Effect.fn.Return<ToolActivitySummaryResult> {
  const fact = yield* readSavedToolActivityFact(sql, input);
  if (!fact) return factualToolActivitySummary;
  return yield* Effect.promise(() => summarize({ ...input, fact }));
});
