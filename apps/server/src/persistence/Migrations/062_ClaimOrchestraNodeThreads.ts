import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Reads one string field out of a projected JSON blob, tolerating anything odd. */
function readString(json: string | null, read: (value: Record<string, unknown>) => unknown) {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = read(parsed as Record<string, unknown>);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function nodeThreadIds(graphJson: string | null): ReadonlyArray<string> {
  if (graphJson === null) return [];
  try {
    const parsed: unknown = JSON.parse(graphJson);
    if (typeof parsed !== "object" || parsed === null) return [];
    const nodes = (parsed as { readonly nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) return [];
    const ids: string[] = [];
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const threadId = (node as { readonly threadId?: unknown }).threadId;
      if (typeof threadId === "string" && threadId.length > 0) ids.push(threadId);
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * Orchestra runs that executed before `orchestra_run_thread_id` existed already
 * left their node conversations behind. Claim them, or the lists that now hide
 * node conversations would still show every one made until today.
 *
 * Separate from 061, which added the column: a database that took 061 while it
 * was still column-only would never see a backfill bolted onto it afterwards.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* sql<{
    readonly meetingJson: string | null;
    readonly graphJson: string | null;
  }>`
    SELECT meeting_json AS "meetingJson", graph_json AS "graphJson"
    FROM projection_workspace_collaboration_runs
    WHERE orchestra_json IS NOT NULL AND meeting_json IS NOT NULL AND graph_json IS NOT NULL
  `;
  for (const run of runs) {
    const ownerThreadId = readString(run.meetingJson, (meeting) => meeting["threadId"]);
    if (ownerThreadId === null) continue;
    for (const threadId of nodeThreadIds(run.graphJson)) {
      // The run's own conversation is the person's; only what it spawned hides.
      if (threadId === ownerThreadId) continue;
      yield* sql`
        UPDATE projection_threads
        SET orchestra_run_thread_id = ${ownerThreadId}
        WHERE thread_id = ${threadId} AND orchestra_run_thread_id IS NULL
      `;
    }
  }
});
