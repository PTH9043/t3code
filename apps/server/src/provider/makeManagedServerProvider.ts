import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  ServerSettingsError,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { activeWorkRegistry } from "../orchestration/ActiveWorkTracker.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

const MAX_PROVIDER_REFRESH_BACKOFF_MS = 30 * 60_000;
/** Minimum interval for default periodic health probes to avoid excessive hidden CLI spawning. */
export const MIN_DEFAULT_PERIODIC_REFRESH_INTERVAL_MS = 3 * 60_000;
/** Reuse a recently probed healthy snapshot during periodic sweeps within this TTL window. */
const PERIODIC_SNAPSHOT_REUSE_TTL_MS = 2.5 * 60_000;

function hasQuotaUsage(snapshot: ServerProvider): boolean {
  return (
    snapshot.usage?.primary !== undefined ||
    snapshot.usage?.secondary !== undefined ||
    (snapshot.usage?.extraWindows?.length ?? 0) > 0
  );
}

function hasExpiredQuotaWindow(snapshot: ServerProvider, nowMs: number): boolean {
  const windows = [
    snapshot.usage?.primary,
    snapshot.usage?.secondary,
    ...(snapshot.usage?.extraWindows ?? []),
  ];
  return windows.some(
    (window) =>
      window?.resetsAt !== undefined &&
      Number.isFinite(window.resetsAt) &&
      window.resetsAt > 0 &&
      window.resetsAt * 1_000 <= nowMs,
  );
}

export function computeProviderRefreshIntervalMs(
  baseIntervalMs: number,
  consecutiveUnreadyCount: number,
): number {
  if (baseIntervalMs <= 0 || consecutiveUnreadyCount <= 0) {
    return baseIntervalMs;
  }
  const multiplier = consecutiveUnreadyCount === 1 ? 3 : consecutiveUnreadyCount === 2 ? 6 : 10;
  const capMs = Math.max(baseIntervalMs, MAX_PROVIDER_REFRESH_BACKOFF_MS);
  return Math.min(capMs, baseIntervalMs * multiplier);
}

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

type ProviderRefreshReason = "initial" | "settings" | "manual" | "periodic";

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly maintenanceCapabilities: ServerProviderShape["maintenanceCapabilities"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly beforeManualRefresh?: Effect.Effect<void>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
}): Effect.fn.Return<
  ServerProviderShape,
  ServerSettingsError,
  Scope.Scope | BackgroundPolicy.BackgroundPolicy | ServerSettingsService
> {
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const serverSettings = yield* ServerSettingsService;
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const consecutiveUnreadyRef = yield* Ref.make(0);
  const lastLiveProbeAtMsRef = yield* Ref.make(0);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation || Equal.equals(state.snapshot, nextSnapshot)) {
        return [null, state] as const;
      }
      return [
        nextSnapshot,
        {
          ...state,
          snapshot: nextSnapshot,
        },
      ] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: {
      readonly forceRefresh?: boolean;
      readonly reason?: ProviderRefreshReason;
    },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const reason: ProviderRefreshReason = options?.reason ?? "settings";
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    // Reuse fresh ready snapshots during periodic refreshes within 80% of the active interval
    // (capped at 2.5 minutes) so bursty/redundant periodic checks don't respawn CLIs.
    if (reason === "periodic" && input.refreshInterval === undefined) {
      const [lastProbeAtMs, currentState, nowMs, configuredInterval] = yield* Effect.all([
        Ref.get(lastLiveProbeAtMsRef),
        Ref.get(snapshotStateRef),
        Clock.currentTimeMillis,
        getRefreshInterval,
      ]);
      const intervalMs = Duration.toMillis(Duration.fromInputUnsafe(configuredInterval));
      const effectiveReuseTtlMs = Math.min(
        PERIODIC_SNAPSHOT_REUSE_TTL_MS,
        Math.max(0, Math.floor(intervalMs * 0.8)),
      );
      if (
        lastProbeAtMs > 0 &&
        effectiveReuseTtlMs > 0 &&
        currentState.snapshot.status === "ready" &&
        nowMs - lastProbeAtMs < effectiveReuseTtlMs &&
        !hasExpiredQuotaWindow(currentState.snapshot, nowMs)
      ) {
        return currentState.snapshot;
      }
    }

    let resetBackoffRequested = false;
    if (reason === "manual" || reason === "settings") {
      if (input.beforeManualRefresh) {
        yield* input.beforeManualRefresh.pipe(Effect.ignore);
      }
      const previousUnready = yield* Ref.getAndSet(consecutiveUnreadyRef, 0);
      resetBackoffRequested = previousUnready > 0;
    }

    const nextSnapshot = yield* input.checkProvider;
    const probedAtMs = yield* Clock.currentTimeMillis;
    yield* Ref.set(lastLiveProbeAtMsRef, probedAtMs);
    if (!nextSnapshot.enabled || nextSnapshot.status === "ready") {
      const previousUnready = yield* Ref.getAndSet(consecutiveUnreadyRef, 0);
      if (previousUnready > 0 || resetBackoffRequested) {
        yield* Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid);
      }
    } else if (reason === "periodic" || reason === "initial") {
      yield* Ref.update(consecutiveUnreadyRef, (count) => Math.min(count + 1, 10));
    } else if (resetBackoffRequested) {
      yield* Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid);
    }

    const nextGeneration = yield* Ref.modify(snapshotStateRef, (state) => {
      const generation = input.enrichSnapshot
        ? state.enrichmentGeneration + 1
        : state.enrichmentGeneration;
      return [
        generation,
        {
          snapshot: nextSnapshot,
          enrichmentGeneration: generation,
        },
      ] as const;
    });
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean; readonly reason?: ProviderRefreshReason },
  ) => refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* (
    reason: ProviderRefreshReason = "manual",
  ) {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true, reason });
  });

  const hasProviderStatusDemand = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status" }),
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status", instanceId }),
    ]);
    if (genericDemand || instanceDemand) {
      return true;
    }
    // Keep subscription quota windows fresh whenever at least one connected client
    // holds a provider-status lease and the host is awake, even if the user briefly
    // switched focus to another window when the periodic tick fired.
    if (!hasQuotaUsage(state.snapshot)) {
      return false;
    }
    const [hasGenericLease, hasInstanceLease, policySnapshot] = yield* Effect.all([
      backgroundPolicy.hasDemand({ type: "provider-status" }),
      backgroundPolicy.hasDemand({ type: "provider-status", instanceId }),
      backgroundPolicy.snapshot,
    ]);
    if (!hasGenericLease && !hasInstanceLease) {
      return false;
    }
    if (
      !policySnapshot.hostPower.stale &&
      (policySnapshot.hostPower.suspended ||
        policySnapshot.hostPower.thermalState === "serious" ||
        policySnapshot.hostPower.thermalState === "critical")
    ) {
      return false;
    }
    return true;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : serverSettings.getSettings.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* serverSettings.subscribeChanges;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings, { reason: "settings" })),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    Effect.all([getRefreshInterval, Ref.get(consecutiveUnreadyRef)]).pipe(
      Effect.flatMap(([refreshInterval, consecutiveUnready]) => {
        const baseIntervalMs = Duration.toMillis(Duration.fromInputUnsafe(refreshInterval));
        const effectiveIntervalMs = computeProviderRefreshIntervalMs(
          baseIntervalMs,
          consecutiveUnready,
        );
        return Effect.raceFirst(
          Effect.sleep(
            effectiveIntervalMs <= 0 ? "60 seconds" : Duration.millis(effectiveIntervalMs),
          ).pipe(Effect.as(true)),
          Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
        ).pipe(
          Effect.flatMap((intervalElapsed) => {
            if (!intervalElapsed || baseIntervalMs <= 0) return Effect.void;
            // Defer bursty periodic CLI probes while active chat turns / workers are running,
            // but never starve subscription quota refreshes (or overdue probes) indefinitely
            // during long continuous agent sessions.
            const shouldSkipForActiveWork =
              input.refreshInterval === undefined && activeWorkRegistry.snapshot().totalActive > 0
                ? Effect.all([
                    Ref.get(lastLiveProbeAtMsRef),
                    Ref.get(snapshotStateRef),
                    Clock.currentTimeMillis,
                  ]).pipe(
                    Effect.map(([lastProbeAtMs, currentState, nowMs]) => {
                      if (hasExpiredQuotaWindow(currentState.snapshot, nowMs)) {
                        return false;
                      }
                      if (
                        hasQuotaUsage(currentState.snapshot) &&
                        (lastProbeAtMs <= 0 || nowMs - lastProbeAtMs >= baseIntervalMs)
                      ) {
                        return false;
                      }
                      const overdueMs = Math.max(baseIntervalMs * 2, 20 * 60_000);
                      if (lastProbeAtMs > 0 && nowMs - lastProbeAtMs >= overdueMs) {
                        return false;
                      }
                      return true;
                    }),
                  )
                : Effect.succeed(false);
            return shouldSkipForActiveWork.pipe(
              Effect.flatMap((skipForActiveWork) =>
                skipForActiveWork
                  ? Effect.void
                  : hasProviderStatusDemand.pipe(
                      Effect.flatMap((shouldRefresh) =>
                        shouldRefresh
                          ? refreshSnapshot("periodic").pipe(Effect.asVoid)
                          : Effect.void,
                      ),
                    ),
              ),
            );
          }),
        );
      }),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* applySnapshot(initialSettings, { forceRefresh: true, reason: "initial" }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    maintenanceCapabilities: input.maintenanceCapabilities,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot("manual").pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
