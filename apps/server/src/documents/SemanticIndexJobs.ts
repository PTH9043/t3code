import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  OllamaEmbeddingError,
  isOllamaEmbeddingError,
  isOllamaEmbeddingFailureReason,
} from "./OllamaEmbeddings.ts";
import {
  cleanupSemanticVectors,
  semanticScopeKey,
  type makeSemanticSearch,
  type SemanticScope,
} from "./semanticSearch.ts";

type Job = {
  scope_key: string;
  project_id: string;
  endpoint: string;
  model: string;
  revision: number;
  after_rowid: number;
  through_rowid: number | null;
  failures: number;
  retry_at: number;
  updated_at: number;
};
type Row = { rowId: number; itemId: string; chunkId: string; title: string; content: string };

/** Durable coalesced project work; only one 64-row page and two embedding inputs are active. */
export const makeSemanticIndexJobs = Effect.fn("makeSemanticIndexJobs")(function* (options: {
  readonly stateDir: string;
  readonly vectors: ReturnType<typeof makeSemanticSearch>;
  readonly enabled: (job: Pick<Job, "endpoint" | "model">) => Effect.Effect<boolean>;
  readonly startWorker?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const clock = yield* Clock.Clock;
  const permit = yield* Semaphore.make(1);
  const wakeups = yield* Queue.sliding<void>(1);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const scope = (job: Pick<Job, "project_id" | "endpoint" | "model">): SemanticScope => ({
    stateDir: options.stateDir,
    projectId: job.project_id,
    endpoint: job.endpoint,
    model: job.model,
  });
  const enqueue = Effect.fn("SemanticIndexJobs.enqueue")(function* (
    request: Omit<SemanticScope, "stateDir">,
    changed = false,
  ) {
    const key = semanticScopeKey(request);
    const now = clock.currentTimeMillisUnsafe();
    if (changed) {
      yield* sql`INSERT INTO workspace_semantic_index_jobs(scope_key,project_id,endpoint,model,updated_at)
        VALUES (${key},${request.projectId},${new URL(request.endpoint).origin},${request.model},${now})
        ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1,after_rowid=0,through_rowid=NULL,
          failures=0,retry_at=0,failure_reason=NULL,updated_at=excluded.updated_at`;
    } else {
      yield* sql`INSERT OR IGNORE INTO workspace_semantic_index_jobs(scope_key,project_id,endpoint,model,updated_at)
        VALUES (${key},${request.projectId},${new URL(request.endpoint).origin},${request.model},${now})`;
    }
    Queue.offerUnsafe(wakeups, undefined);
  });
  const cleanup = Effect.fn("SemanticIndexJobs.cleanup")(function* (
    request: Omit<SemanticScope, "stateDir">,
    apply = false,
  ) {
    const key = semanticScopeKey(request);
    const [pending] =
      yield* sql`SELECT 1 FROM workspace_semantic_index_jobs WHERE scope_key=${key}`;
    const [indexed] =
      yield* sql`SELECT 1 FROM workspace_semantic_scope_state WHERE scope_key=${key}`;
    if (pending || !indexed)
      return { scanned: 0, eligibleFiles: 0, eligibleBytes: 0, removedFiles: 0, removedBytes: 0 };
    const result = yield* Effect.tryPromise((signal) =>
      cleanupSemanticVectors({
        ...request,
        stateDir: options.stateDir,
        apply,
        olderThan: clock.currentTimeMillisUnsafe() - 24 * 60 * 60 * 1000,
        signal,
        referenced: async (contentKey) => {
          const rows = await runPromise(
            sql`SELECT 1 FROM workspace_semantic_vector_refs
          WHERE scope_key=${key} AND content_key=${contentKey} LIMIT 1`,
            { signal },
          );
          return rows.length > 0;
        },
      }),
    );
    if (apply)
      yield* sql`UPDATE workspace_semantic_scope_state SET
      cleanup_at=${clock.currentTimeMillisUnsafe()},reclaimed_bytes=reclaimed_bytes+${result.removedBytes}
      WHERE scope_key=${key}`;
    return result;
  });
  const status = Effect.fn("SemanticIndexJobs.status")(function* (
    request: Omit<SemanticScope, "stateDir">,
  ) {
    const [row] = yield* sql<{
      failures: number;
      retry_at: number;
      failure_reason: string | null;
    }>`SELECT failures,retry_at,failure_reason
      FROM workspace_semantic_index_jobs WHERE scope_key=${semanticScopeKey(request)}`;
    const enabled = row ? yield* options.enabled(request) : true;
    const state =
      row === undefined
        ? "idle"
        : !enabled
          ? "disabled"
          : row.failures > 0
            ? "retrying"
            : "pending";
    return {
      pending: row !== undefined,
      state,
      failures: row?.failures ?? 0,
      retryAt: row?.retry_at ?? null,
      failureMessage: isOllamaEmbeddingFailureReason(row?.failure_reason)
        ? new OllamaEmbeddingError({ model: request.model, reason: row.failure_reason }).message
        : null,
    };
  });
  const processPage = Effect.fn("SemanticIndexJobs.processPage")(function* (job: Job) {
    let through = job.through_rowid;
    if (through === null) {
      const [boundary] = yield* sql<{ last: number | null }>`SELECT max(rowid) AS last
        FROM projection_workspace_rag_chunks WHERE project_id=${job.project_id}`;
      through = boundary?.last ?? 0;
      yield* sql`UPDATE workspace_semantic_index_jobs SET through_rowid=${through}
        WHERE scope_key=${job.scope_key} AND revision=${job.revision}`;
    }
    const rows = yield* sql<Row>`SELECT rowid AS "rowId",item_id AS "itemId",
      CAST(chunk_index AS TEXT) AS "chunkId",title,content FROM projection_workspace_rag_chunks
      WHERE project_id=${job.project_id} AND rowid>${job.after_rowid} AND rowid<=${through}
      ORDER BY rowid LIMIT 64`;
    if (rows.length) {
      const indexed = yield* Effect.tryPromise({
        try: (signal) =>
          options.vectors.index({
            ...scope(job),
            signal,
            candidates: rows.map((row) => ({ ...row, id: String(row.rowId) })),
          }),
        catch: (cause) =>
          isOllamaEmbeddingError(cause)
            ? cause
            : new OllamaEmbeddingError({ model: job.model, reason: "request" }),
      });
      const keys = new Map(indexed.references.map((entry) => [entry.id, entry.key]));
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const row of rows) {
            yield* sql`INSERT INTO workspace_semantic_vector_refs(scope_key,source_rowid,project_id,item_id,chunk_index,content_key)
            SELECT ${job.scope_key},${row.rowId},${job.project_id},${row.itemId},${row.chunkId},${keys.get(String(row.rowId))!}
            WHERE EXISTS(SELECT 1 FROM projection_workspace_rag_chunks WHERE rowid=${row.rowId}
              AND project_id=${job.project_id} AND item_id=${row.itemId} AND CAST(chunk_index AS TEXT)=${row.chunkId}
              AND title=${row.title} AND content=${row.content})
            ON CONFLICT(scope_key,source_rowid) DO UPDATE SET project_id=excluded.project_id,
              item_id=excluded.item_id,chunk_index=excluded.chunk_index,content_key=excluded.content_key`;
          }
          yield* sql`UPDATE workspace_semantic_index_jobs SET after_rowid=${rows.at(-1)!.rowId},
          failures=0,retry_at=0,failure_reason=NULL,updated_at=${clock.currentTimeMillisUnsafe()}
          WHERE scope_key=${job.scope_key} AND revision=${job.revision}`;
        }),
      );
      return;
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM workspace_semantic_vector_refs WHERE scope_key=${job.scope_key}
        AND NOT EXISTS(SELECT 1 FROM projection_workspace_rag_chunks c WHERE c.rowid=source_rowid
          AND c.project_id=workspace_semantic_vector_refs.project_id
          AND c.item_id=workspace_semantic_vector_refs.item_id
          AND CAST(c.chunk_index AS TEXT)=workspace_semantic_vector_refs.chunk_index)`;
        yield* sql`DELETE FROM workspace_semantic_index_jobs WHERE scope_key=${job.scope_key} AND revision=${job.revision}`;
        yield* sql`INSERT INTO workspace_semantic_scope_state(scope_key,indexed_at) VALUES(${job.scope_key},${clock.currentTimeMillisUnsafe()})
        ON CONFLICT(scope_key) DO UPDATE SET indexed_at=excluded.indexed_at`;
      }),
    );
    const [pending] =
      yield* sql`SELECT 1 FROM workspace_semantic_index_jobs WHERE scope_key=${job.scope_key}`;
    const [state] = yield* sql<{
      cleanup_at: number;
    }>`SELECT cleanup_at FROM workspace_semantic_scope_state WHERE scope_key=${job.scope_key}`;
    if (
      !pending &&
      (!state?.cleanup_at ||
        clock.currentTimeMillisUnsafe() - state.cleanup_at >= 24 * 60 * 60 * 1000)
    )
      yield* cleanup({ projectId: job.project_id, endpoint: job.endpoint, model: job.model }, true);
  });
  const drain = permit.withPermits(1)(
    Effect.gen(function* () {
      let pages = 0;
      while (true) {
        const [job] = yield* sql<Job>`SELECT * FROM workspace_semantic_index_jobs
        WHERE retry_at<=${clock.currentTimeMillisUnsafe()} ORDER BY updated_at,scope_key LIMIT 1`;
        if (!job) return { pages };
        if (!(yield* options.enabled(job))) {
          yield* sql`UPDATE workspace_semantic_index_jobs SET retry_at=${clock.currentTimeMillisUnsafe() + 30_000}
          WHERE scope_key=${job.scope_key} AND revision=${job.revision}`;
          continue;
        }
        const result = yield* processPage(job).pipe(Effect.result);
        if (result._tag === "Failure") {
          const delay = Math.min(300_000, 30_000 * 2 ** Math.min(job.failures, 4));
          const reason = isOllamaEmbeddingError(result.failure) ? result.failure.reason : "request";
          yield* sql`UPDATE workspace_semantic_index_jobs SET failures=failures+1,retry_at=${clock.currentTimeMillisUnsafe() + delay},failure_reason=${reason}
          WHERE scope_key=${job.scope_key} AND revision=${job.revision}`;
          yield* Effect.logWarning("Background semantic indexing deferred", {
            projectId: job.project_id,
            failures: job.failures + 1,
            reason,
          });
        }
        pages++;
        yield* Effect.yieldNow;
      }
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(options.vectors.clear));
  if (options.startWorker !== false)
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.raceFirst(Queue.take(wakeups), Effect.sleep("30 seconds"));
          yield* drain.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Semantic indexing worker could not drain", { cause }),
            ),
          );
        }
      }),
    );
  Queue.offerUnsafe(wakeups, undefined);
  return { enqueue, drain, cleanup, status };
});
