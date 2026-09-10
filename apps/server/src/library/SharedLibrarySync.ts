import type { SharedLibraryStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  SharedLibraryRepository,
  type SharedLibrarySyncState,
} from "../persistence/Services/SharedLibrary.ts";
import { forkParked } from "../serverActivation.ts";
import {
  SEEKER_ORIGIN,
  parseSeekerReferencePage,
  toSeekerLibraryDocument,
} from "./theseekerReference.ts";

export const DESIGN_LIBRARY_ID = "design-references";
export const DESIGN_LIBRARY_TITLE = "공용 디자인 라이브러리";
export const SEEKER_SOURCE = "ref.theseeker.io";

const USER_AGENT = "NewAutoUsage-SharedLibrary/1.0 (personal design reference index)";
const MAX_REQUEST_ATTEMPTS = 3;
/** Listing pages whose links anchor a scan past gaps in the reference ids. */
const LISTING_PATHS = ["/", "/?sort=popular"] as const;
const REFERENCE_LINK = /href="\/r\/(\d+)"/gu;

export interface SharedLibrarySyncOptions {
  /**
   * Consecutive missing ids that end a scan. Ids are assigned in collection
   * order with gaps (5677–5699 do not exist, 5700 does), so the full scan is
   * generous; the daily scan only has to clear the gaps above the last hit.
   */
  readonly fullScanMissLimit: number;
  readonly incrementalMissLimit: number;
  /** Requests in flight at once — kept low: this is someone else's site. */
  readonly concurrency: number;
  readonly batchPauseMillis: number;
  readonly retryBackoffMillis: number;
  readonly requestTimeoutMillis: number;
  readonly maxConsecutiveFailures: number;
  readonly startupDelayMillis: number;
  readonly checkIntervalMillis: number;
  readonly syncEveryMillis: number;
}

export const DEFAULT_SHARED_LIBRARY_SYNC_OPTIONS: SharedLibrarySyncOptions = {
  fullScanMissLimit: 400,
  incrementalMissLimit: 200,
  concurrency: 3,
  batchPauseMillis: 350,
  retryBackoffMillis: 2_000,
  requestTimeoutMillis: 20_000,
  maxConsecutiveFailures: 12,
  startupDelayMillis: 90_000,
  checkIntervalMillis: 60 * 60 * 1000,
  syncEveryMillis: 24 * 60 * 60 * 1000,
};

export interface SharedLibrarySyncReport {
  readonly scannedFrom: number;
  readonly scannedTo: number;
  readonly stored: number;
  readonly missing: number;
  readonly unparsed: number;
  readonly failed: number;
  readonly completedFullScan: boolean;
}

export class SharedLibrarySyncError extends Data.TaggedError("SharedLibrarySyncError")<{
  readonly message: string;
}> {}

export interface SharedLibrarySyncShape {
  /** Begin the startup check and the hourly "has a day passed?" loop. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Start a sync in the background unless one is running; true when started. */
  readonly syncNow: () => Effect.Effect<boolean>;
  /** Run one sync to completion — the scheduled path, and what tests drive. */
  readonly runOnce: () => Effect.Effect<
    SharedLibrarySyncReport,
    SharedLibrarySyncError | ProjectionRepositoryError
  >;
  readonly status: () => Effect.Effect<SharedLibraryStatus, ProjectionRepositoryError>;
}

/**
 * Keeps the shared design library in step with ref.theseeker.io.
 *
 * The site lists references through a hashed server function that changes on
 * every deploy, so the stable surface is the public `/r/<id>` page. The first
 * run scans ids upward until a long run of misses (resuming from its cursor
 * after a restart); later runs only probe above the highest stored id. The
 * newest and most popular listing pages supply anchor ids, so a scan never
 * stops short of a reference the site is showing.
 */
export const makeSharedLibrarySync = (
  options: SharedLibrarySyncOptions = DEFAULT_SHARED_LIBRARY_SYNC_OPTIONS,
) =>
  Effect.gen(function* () {
    const repository = yield* SharedLibraryRepository;
    const httpClient = yield* HttpClient.HttpClient;
    const running = yield* Ref.make(false);
    const hostScope = yield* Ref.make(Option.none<Scope.Scope>());
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const emptyState = (): SharedLibrarySyncState => ({
      source: SEEKER_SOURCE,
      libraryId: DESIGN_LIBRARY_ID,
      maxRef: 0,
      scanCursor: 0,
      fullScanCompletedAt: null,
      lastSyncAt: null,
      lastError: null,
    });

    type Attempt =
      | { readonly kind: "page"; readonly html: string }
      | { readonly kind: "missing" }
      | { readonly kind: "retry"; readonly detail: string };

    const fetchOnce = (path: string): Effect.Effect<Attempt> =>
      httpClient
        .execute(
          HttpClientRequest.get(`${SEEKER_ORIGIN}${path}`).pipe(
            HttpClientRequest.setHeaders({ "user-agent": USER_AGENT, accept: "text/html" }),
          ),
        )
        .pipe(
          Effect.flatMap((response): Effect.Effect<Attempt, unknown> => {
            if (response.status === 404) return Effect.succeed({ kind: "missing" });
            if (response.status === 200) {
              return response.text.pipe(Effect.map((html): Attempt => ({ kind: "page", html })));
            }
            return Effect.succeed({ kind: "retry", detail: `HTTP ${response.status}` });
          }),
          Effect.timeoutOption(Duration.millis(options.requestTimeoutMillis)),
          Effect.map(Option.getOrElse((): Attempt => ({ kind: "retry", detail: "timeout" }))),
          Effect.catch((error) =>
            Effect.succeed<Attempt>({ kind: "retry", detail: String(error) }),
          ),
        );

    /** One page with bounded retries; throttling, 5xx and timeouts back off first. */
    const fetchPath = Effect.fn("SharedLibrarySync.fetchPath")(function* (path: string) {
      let detail = "";
      for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
        const outcome = yield* fetchOnce(path);
        if (outcome.kind !== "retry") return outcome;
        detail = outcome.detail;
        if (attempt < MAX_REQUEST_ATTEMPTS && options.retryBackoffMillis > 0) {
          yield* Effect.sleep(Duration.millis(options.retryBackoffMillis * attempt));
        }
      }
      return { kind: "failed" as const, detail };
    });

    const processId = Effect.fn("SharedLibrarySync.processId")(function* (id: number) {
      const outcome = yield* fetchPath(`/r/${id}`);
      if (outcome.kind === "missing") return "missing" as const;
      if (outcome.kind === "failed") return "failed" as const;
      const reference = parseSeekerReferencePage(outcome.html, id);
      if (reference === null) return "unparsed" as const;
      yield* repository.upsertItem({
        libraryId: DESIGN_LIBRARY_ID,
        source: SEEKER_SOURCE,
        ...toSeekerLibraryDocument(reference),
        fetchedAt: yield* nowIso,
      });
      return "stored" as const;
    });

    const discoverListedIds = Effect.fn("SharedLibrarySync.discoverListedIds")(function* () {
      const ids = new Set<number>();
      for (const path of LISTING_PATHS) {
        const outcome = yield* fetchPath(path);
        if (outcome.kind !== "page") continue;
        for (const match of outcome.html.matchAll(REFERENCE_LINK)) {
          const id = Number(match[1]);
          if (Number.isSafeInteger(id) && id > 0) ids.add(id);
        }
      }
      return [...ids].toSorted((left, right) => left - right);
    });

    const runOnce: SharedLibrarySyncShape["runOnce"] = Effect.fn("SharedLibrarySync.runOnce")(
      function* () {
        const state = Option.getOrElse(yield* repository.getSyncState(SEEKER_SOURCE), emptyState);
        const fullScan = state.fullScanCompletedAt === null;
        const listed = yield* discoverListedIds();
        const anchor = listed.reduce((highest, id) => Math.max(highest, id), state.maxRef);
        const missLimit = fullScan ? options.fullScanMissLimit : options.incrementalMissLimit;
        let cursor = fullScan ? state.scanCursor : state.maxRef;
        const scannedFrom = cursor + 1;
        let maxRef = state.maxRef;
        let misses = 0;
        let stored = 0;
        let missing = 0;
        let unparsed = 0;
        let consecutiveFailures = 0;
        let firstFailureInStreak = 0;
        const failed: number[] = [];

        const checkpoint = (lastError: string | null) =>
          Effect.gen(function* () {
            yield* repository.saveSyncState({
              ...state,
              maxRef,
              scanCursor: cursor,
              lastError,
              updatedAt: yield* nowIso,
            });
          });

        while (misses < missLimit || cursor < anchor) {
          const ids = Array.from(
            { length: options.concurrency },
            (_, offset) => cursor + 1 + offset,
          );
          const outcomes = yield* Effect.forEach(ids, processId, {
            concurrency: options.concurrency,
          });
          outcomes.forEach((outcome, index) => {
            const id = ids[index] ?? cursor;
            if (outcome === "failed") {
              if (consecutiveFailures === 0) firstFailureInStreak = id;
              consecutiveFailures += 1;
              failed.push(id);
              return;
            }
            consecutiveFailures = 0;
            if (outcome === "stored") {
              stored += 1;
              misses = 0;
              maxRef = Math.max(maxRef, id);
            } else {
              if (outcome === "unparsed") unparsed += 1;
              else missing += 1;
              misses += 1;
            }
          });
          cursor = ids.at(-1) ?? cursor;
          if (consecutiveFailures >= options.maxConsecutiveFailures) {
            // Resume from the first id of the failing streak: an outage must
            // not silently skip references it never managed to read.
            cursor = Math.max(0, firstFailureInStreak - 1);
            const message = `요청이 연속 ${consecutiveFailures}회 실패해 ${firstFailureInStreak}번에서 멈췄습니다. 다음 동기화가 이어서 진행합니다.`;
            yield* checkpoint(message);
            return yield* new SharedLibrarySyncError({ message });
          }
          yield* checkpoint(null);
          if (options.batchPauseMillis > 0) {
            yield* Effect.sleep(Duration.millis(options.batchPauseMillis));
          }
        }

        // A listed reference the scan could not store (a transient failure)
        // gets one more try before the run is recorded.
        let stillFailed = 0;
        for (const id of new Set([...listed, ...failed])) {
          const itemId = `theseeker-${id}`;
          if (yield* repository.hasItem({ libraryId: DESIGN_LIBRARY_ID, itemId })) continue;
          const outcome = yield* processId(id);
          if (outcome === "stored") {
            stored += 1;
            maxRef = Math.max(maxRef, id);
          } else if (outcome === "failed") {
            stillFailed += 1;
          }
        }

        const notes: string[] = [];
        if (stillFailed > 0) notes.push(`${stillFailed}건은 요청 실패로 건너뜀`);
        // Pages that exist but no longer parse mean the site changed shape;
        // never call a scan that stored nothing complete on that evidence.
        const formatBroken = unparsed > 0 && stored === 0;
        if (formatBroken)
          notes.push(`페이지 ${unparsed}건의 형식을 인식하지 못함 — 파서 점검 필요`);
        const completedAt = yield* nowIso;
        yield* repository.saveSyncState({
          source: SEEKER_SOURCE,
          libraryId: DESIGN_LIBRARY_ID,
          maxRef,
          scanCursor: cursor,
          fullScanCompletedAt: fullScan && !formatBroken ? completedAt : state.fullScanCompletedAt,
          lastSyncAt: completedAt,
          lastError: notes.length === 0 ? null : notes.join(" · "),
          updatedAt: completedAt,
        });
        return {
          scannedFrom,
          scannedTo: cursor,
          stored,
          missing,
          unparsed,
          failed: stillFailed,
          completedFullScan: fullScan && !formatBroken,
        };
      },
    );

    const runGuarded = Effect.gen(function* () {
      const claimed = yield* Ref.modify(running, (busy) => [!busy, true] as const);
      if (!claimed) return;
      yield* runOnce().pipe(
        Effect.tap((report) => Effect.logInfo("shared library sync finished", report)),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("shared library sync failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.ensuring(Ref.set(running, false)),
      );
    });

    const isDue = Effect.gen(function* () {
      const state = yield* repository
        .getSyncState(SEEKER_SOURCE)
        .pipe(Effect.orElseSucceed(() => Option.none<SharedLibrarySyncState>()));
      const now = yield* Clock.currentTimeMillis;
      return Option.match(state, {
        onNone: () => true,
        onSome: (current) =>
          current.fullScanCompletedAt === null ||
          current.lastSyncAt === null ||
          now - Date.parse(current.lastSyncAt) >= options.syncEveryMillis,
      });
    });

    const start: SharedLibrarySyncShape["start"] = () =>
      Effect.gen(function* () {
        yield* Ref.set(hostScope, Option.some(yield* Effect.scope));
        yield* forkParked(
          Effect.sleep(Duration.millis(options.startupDelayMillis)).pipe(
            Effect.andThen(
              Effect.forever(
                isDue.pipe(
                  Effect.flatMap((due) => (due ? runGuarded : Effect.void)),
                  Effect.andThen(Effect.sleep(Duration.millis(options.checkIntervalMillis))),
                ),
              ),
            ),
          ),
        );
      });

    const syncNow: SharedLibrarySyncShape["syncNow"] = () =>
      Effect.gen(function* () {
        if (yield* Ref.get(running)) return false;
        const scope = yield* Ref.get(hostScope);
        if (Option.isSome(scope)) yield* runGuarded.pipe(Effect.forkIn(scope.value));
        else yield* Effect.forkDetach(runGuarded);
        return true;
      });

    const status: SharedLibrarySyncShape["status"] = () =>
      Effect.gen(function* () {
        const counts = yield* repository.countItems();
        const states = yield* repository.listSyncStates();
        const busy = yield* Ref.get(running);
        const seeker = states.find((state) => state.source === SEEKER_SOURCE) ?? emptyState();
        const sources = [seeker, ...states.filter((state) => state.source !== SEEKER_SOURCE)];
        return {
          libraries: [
            {
              libraryId: DESIGN_LIBRARY_ID,
              title: DESIGN_LIBRARY_TITLE,
              itemCount:
                counts.find((count) => count.libraryId === DESIGN_LIBRARY_ID)?.itemCount ?? 0,
            },
          ],
          sources: sources.map((state) => ({
            source: state.source,
            origin: `https://${state.source}`,
            libraryId: state.libraryId,
            maxRef: state.maxRef,
            scanCursor: state.scanCursor,
            fullScanCompletedAt: state.fullScanCompletedAt,
            lastSyncAt: state.lastSyncAt,
            lastError: state.lastError,
            running: busy && state.source === SEEKER_SOURCE,
          })),
        } satisfies SharedLibraryStatus;
      });

    return SharedLibrarySync.of({ start, syncNow, runOnce, status });
  });

export class SharedLibrarySync extends Context.Service<SharedLibrarySync, SharedLibrarySyncShape>()(
  "t3/library/SharedLibrarySync",
) {}

export const SharedLibrarySyncLive = Layer.effect(SharedLibrarySync, makeSharedLibrarySync());
