import { runBackgroundModelJob } from "../background/backgroundModelQueue.ts";
import { DEFAULT_USER_IDLE_WINDOW_MS, vramArbiter } from "../background/VramArbiter.ts";
import { activeWorkRegistry } from "../orchestration/ActiveWorkTracker.ts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  OllamaEmbeddingError,
  isOllamaEmbeddingError,
  isOllamaEmbeddingFailureReason,
} from "./OllamaEmbeddings.ts";
import {
  RegisteredSemanticError,
  RegisteredSemanticFailureReason,
  isRegisteredSemanticError,
} from "./RegisteredSemanticModels.ts";
import {
  buildRagSemanticEnvelope,
  cleanupSemanticVectors,
  normalizeSemanticEndpoint,
  parseProviderEmbeddingInstanceId,
  semanticScopeKey,
  syncNativeVectorPoolForScope,
  type makeSemanticSearch,
  type SemanticScope,
} from "./semanticSearch.ts";
import * as Schema from "effect/Schema";

const isRegisteredSemanticFailureReason = Schema.is(RegisteredSemanticFailureReason);

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
type Row = {
  rowId: number;
  itemId: string;
  chunkId: string;
  title: string;
  content: string;
  tagsText: string;
  scope: string | null;
  appliesToFolder: string | null;
  updatedAt: string;
};

/** Durable coalesced project work; only one 64-row page and two embedding inputs are active. */
export const makeSemanticIndexJobs = Effect.fn("makeSemanticIndexJobs")(function* (options: {
  readonly stateDir: string;
  readonly vectors: ReturnType<typeof makeSemanticSearch>;
  readonly enabled: (job: Pick<Job, "endpoint" | "model">) => Effect.Effect<boolean>;
  readonly startWorker?: boolean;
  readonly idleWaitMs?: number;
}) {
  const idleWaitMs = options.idleWaitMs ?? DEFAULT_USER_IDLE_WINDOW_MS;
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
    const normalizedEndpoint = normalizeSemanticEndpoint(request.endpoint);
    const now = clock.currentTimeMillisUnsafe();
    if (changed) {
      yield* sql`INSERT INTO workspace_semantic_index_jobs(scope_key,project_id,endpoint,model,updated_at)
        VALUES (${key},${request.projectId},${normalizedEndpoint},${request.model},${now})
        ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1,after_rowid=0,through_rowid=NULL,
          failures=0,retry_at=0,failure_reason=NULL,updated_at=excluded.updated_at`;
    } else {
      yield* sql`INSERT OR IGNORE INTO workspace_semantic_index_jobs(scope_key,project_id,endpoint,model,updated_at)
        VALUES (${key},${request.projectId},${normalizedEndpoint},${request.model},${now})`;
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
    const providerInstanceId = parseProviderEmbeddingInstanceId(request.endpoint);
    const failureMessage =
      providerInstanceId !== null && isRegisteredSemanticFailureReason(row?.failure_reason)
        ? new RegisteredSemanticError({
            providerLabel: providerInstanceId,
            model: request.model,
            reason: row.failure_reason,
          }).message
        : isOllamaEmbeddingFailureReason(row?.failure_reason)
          ? new OllamaEmbeddingError({ model: request.model, reason: row.failure_reason }).message
          : null;
    return {
      pending: row !== undefined,
      state,
      failures: row?.failures ?? 0,
      retryAt: row?.retry_at ?? null,
      failureMessage,
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
    // Wave 5-A4: Bound per-page chunk batch to 12 (from 24) and enforce 25s embedding timeout
    // so single pages don't stall 47-75s or starve interactive chat embeddings.
    const rows = yield* sql<Row>`SELECT rowid AS "rowId",item_id AS "itemId",
      CAST(chunk_index AS TEXT) AS "chunkId",title,content,
      tags_text AS "tagsText",scope,applies_to_folder AS "appliesToFolder",updated_at AS "updatedAt"
      FROM projection_workspace_rag_chunks
      WHERE project_id=${job.project_id} AND rowid>${job.after_rowid} AND rowid<=${through}
      ORDER BY rowid LIMIT 12`;
    if (rows.length) {
      const indexedOpt = yield* Effect.tryPromise({
        try: (signal) =>
          runBackgroundModelJob(signal, () =>
            options.vectors.index({
              ...scope(job),
              signal,
              candidates: rows.map((row) => ({
                ...row,
                ...buildRagSemanticEnvelope(row),
                id: String(row.rowId),
              })),
            }),
          ),
        catch: (cause) => {
          if (isRegisteredSemanticError(cause)) return cause;
          if (isOllamaEmbeddingError(cause)) return cause;
          if (typeof cause === "object" && cause !== null && "cause" in cause) {
            const inner = (cause as { readonly cause?: unknown }).cause;
            if (isRegisteredSemanticError(inner)) return inner;
            if (isOllamaEmbeddingError(inner)) return inner;
          }
          return new OllamaEmbeddingError({ model: job.model, reason: "request" });
        },
      }).pipe(Effect.timeoutOption("25 seconds"));
      if (Option.isNone(indexedOpt)) {
        return yield* new OllamaEmbeddingError({ model: job.model, reason: "request" });
      }
      const indexed = indexedOpt.value;
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
    if (!pending) {
      yield* Effect.sync(() => {
        try {
          syncNativeVectorPoolForScope(options.stateDir, job.scope_key);
        } catch {
          // Native mmap vector pool sync is strictly best-effort; SQLite v4 remains SSOT.
        }
      });
    }
  });
  const processNextPage = permit.withPermits(1)(
    Effect.gen(function* () {
      const nowMs = clock.currentTimeMillisUnsafe();
      if (vramArbiter.isBackgroundPaused(options.stateDir, nowMs)) {
        return "paused" as const;
      }
      // Yield background indexing while any live chat turn, delegation, or council run is active.
      if (activeWorkRegistry.snapshot(nowMs).totalActive > 0) {
        return "paused" as const;
      }
      const [job] = yield* sql<Job>`SELECT * FROM workspace_semantic_index_jobs
      WHERE retry_at<=${nowMs} ORDER BY updated_at,scope_key LIMIT 1`;
      if (!job) return "idle" as const;
      if (!(yield* options.enabled(job))) {
        yield* sql`UPDATE workspace_semantic_index_jobs SET retry_at=${nowMs + 30_000}
        WHERE scope_key=${job.scope_key} AND revision=${job.revision}`;
        return "skipped" as const;
      }
      const result = yield* processPage(job).pipe(Effect.result);
      if (result._tag === "Failure") {
        const delay = Math.min(300_000, 30_000 * 2 ** Math.min(job.failures, 4));
        const reason = isRegisteredSemanticError(result.failure)
          ? result.failure.reason
          : isOllamaEmbeddingError(result.failure)
            ? result.failure.reason
            : "request";
        yield* sql`UPDATE workspace_semantic_index_jobs SET failures=failures+1,retry_at=${clock.currentTimeMillisUnsafe() + delay},failure_reason=${reason}
        WHERE scope_key=${job.scope_key} AND revision=${job.revision}`;
        yield* Effect.logWarning("Background semantic indexing deferred", {
          projectId: job.project_id,
          failures: job.failures + 1,
          reason,
        });
      }
      return "processed" as const;
    }),
  );
  const drain = Effect.gen(function* () {
    let pages = 0;
    while (true) {
      const step = yield* processNextPage;
      if (step === "idle" || step === "paused") return { pages };
      if (step === "processed") {
        pages++;
        yield* Effect.yieldNow;
      }
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(options.vectors.clear));
  if (options.startWorker !== false)
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.raceFirst(Queue.take(wakeups), Effect.sleep("30 seconds"));
          while (true) {
            const waitMs = vramArbiter.msUntilUserIdle(clock.currentTimeMillisUnsafe(), idleWaitMs);
            if (waitMs > 0) {
              yield* Effect.sleep(Duration.millis(Math.min(waitMs, 30_000)));
              continue;
            }
            const step = yield* processNextPage.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Semantic indexing worker could not drain", { cause }).pipe(
                  Effect.as("idle" as const),
                ),
              ),
            );
            if (step === "idle") break;
            if (step === "paused") {
              yield* Effect.sleep("15 seconds");
              break;
            }
            if (step === "processed") {
              // Pace background indexing pages outside the permit so local Ollama stays responsive
              // for live chat RAG without blocking explicit drain calls under TestClock.
              yield* Effect.sleep("3000 millis");
            }
          }
        }
      }),
    );
  Queue.offerUnsafe(wakeups, undefined);
  return { enqueue, drain, cleanup, status };
});
