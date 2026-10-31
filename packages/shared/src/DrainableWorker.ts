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
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
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

export interface KeyedDrainableWorker<A> extends DrainableWorker<A> {
  readonly activeKeyCount: Effect.Effect<number>;
}

/**
 * Serialize queued items per key and release idle queues and fibers.
 * Session-lifetime work must fork into its owning session scope; handlers
 * still receive the constructor's context for scoped effects.
 */
export const makeKeyedDrainableWorker = <A, E, R>(
  keyOf: (item: A) => string,
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<KeyedDrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Scope.Scope | R>();
    const owner = yield* Scope.Scope;
    const outstanding = yield* TxRef.make(0);
    const queues = new Map<string, TxQueue.TxQueue<A>>();
    const gate = yield* Semaphore.make(1);
    let closed = false;

    yield* Effect.addFinalizer(() =>
      gate.withPermit(
        Effect.gen(function* () {
          closed = true;
          for (const queue of queues.values()) yield* TxQueue.shutdown(queue);
          queues.clear();
          yield* TxRef.set(outstanding, 0).pipe(Effect.tx);
        }),
      ),
    );

    const runKey = (key: string, queue: TxQueue.TxQueue<A>) =>
      Effect.gen(function* () {
        while (true) {
          const next = yield* gate.withPermit(
            Effect.gen(function* () {
              const item = yield* TxQueue.poll(queue).pipe(Effect.tx);
              if (Option.isNone(item)) {
                if (queues.get(key) === queue) queues.delete(key);
                yield* TxQueue.shutdown(queue);
              }
              return item;
            }),
          );
          if (Option.isNone(next)) return;
          let idle = false;
          yield* process(next.value).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("Keyed worker item failed", { cause: Cause.pretty(cause) }),
            ),
            Effect.ensuring(
              gate.withPermit(
                Effect.gen(function* () {
                  idle = (yield* TxQueue.size(queue)) === 0;
                  if (idle) {
                    if (queues.get(key) === queue) queues.delete(key);
                    yield* TxQueue.shutdown(queue);
                  }
                  yield* TxRef.update(outstanding, (n) => n - 1).pipe(Effect.tx);
                }),
              ),
            ),
          );
          if (idle) return;
        }
      });

    const enqueue = (item: A) =>
      gate.withPermit(
        Effect.gen(function* () {
          if (closed) return;
          const key = keyOf(item);
          let queue = queues.get(key);
          const create = queue === undefined;
          if (queue === undefined) {
            queue = yield* TxQueue.unbounded<A>();
            queues.set(key, queue);
          }
          yield* TxQueue.offer(queue, item).pipe(
            Effect.andThen(TxRef.update(outstanding, (n) => n + 1)),
            Effect.tx,
          );
          if (create)
            yield* runKey(key, queue).pipe(
              Effect.provide(context),
              Effect.forkIn(owner, { uninterruptible: false }),
            );
        }).pipe(Effect.uninterruptible),
      );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    return {
      enqueue,
      drain,
      activeKeyCount: Effect.sync(() => queues.size),
    } satisfies KeyedDrainableWorker<A>;
  });
