import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Locks stay registered while a holder or waiter exists, and leave no idle keys. */
export function makeKeyedLock() {
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

  const withKey = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const entry = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      entry.users += 1;
      locks.set(key, entry);
      return entry.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.users -= 1;
            if (entry.users === 0 && locks.get(key) === entry) locks.delete(key);
          }),
        ),
      );
    });

  return { withKey, activeKeyCount: Effect.sync(() => locks.size) };
}
