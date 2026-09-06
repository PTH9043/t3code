/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

/**
 * Create a drainable worker that serializes items per key while processing
 * different keys concurrently.
 *
 * Each key lazily gets its own long-lived worker (created in the scope this
 * constructor ran in), so items sharing a key run strictly in enqueue order
 * while distinct keys never wait on each other. The per-key fiber is
 * deliberately eternal — the same lifetime as `makeDrainableWorker`'s single
 * fiber — because handlers fork session-lifetime child fibers that must
 * outlive the item that spawned them; a short-lived per-item fiber would
 * interrupt those children the moment its item settled.
 *
 * `drain` resolves once every enqueued item, across all keys, has finished.
 *
 * Known trade-off: per-key workers are never reclaimed, so a long-lived
 * worker keyed by an unbounded identifier (thread ids, say) accumulates one
 * parked fiber and empty queue per key ever seen. Each costs only memory —
 * acceptable for the current consumers, but key by something bounded if that
 * ever changes.
 */
export const makeKeyedDrainableWorker = <A, E, R>(
  keyOf: (item: A) => string,
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Scope.Scope | R>();
    const outstanding = yield* TxRef.make(0);
    const workers = new Map<string, DrainableWorker<A>>();
    // Guards the check-then-create window below: concurrent enqueues for the
    // same fresh key would otherwise each build a worker and split the items
    // across two queues, silently breaking the per-key order contract.
    const workerCreation = yield* Semaphore.make(1);

    // Global accounting wraps the per-key workers' own (unused) counters so
    // drain() covers items regardless of which key they landed on.
    const counted = (item: A) =>
      Effect.ensuring(process(item), TxRef.update(outstanding, (n) => n - 1).pipe(Effect.tx));

    const workerForKey = (key: string) =>
      workerCreation.withPermit(
        Effect.gen(function* () {
          let worker = workers.get(key);
          if (worker === undefined) {
            worker = yield* makeDrainableWorker(counted).pipe(Effect.provide(context));
            workers.set(key, worker);
          }
          return worker;
        }),
      );

    const enqueue = (item: A) =>
      // Uninterruptible so the outstanding increment and the queue offer
      // cannot be separated by an interrupt — a bare increment would leave
      // drain() retrying forever.
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* TxRef.update(outstanding, (n) => n + 1).pipe(Effect.tx);
          const worker = yield* workerForKey(keyOf(item));
          yield* worker.enqueue(item);
        }),
      );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
