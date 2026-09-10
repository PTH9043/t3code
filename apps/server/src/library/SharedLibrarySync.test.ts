import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { SharedLibraryRepositoryLive } from "../persistence/Layers/SharedLibrary.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { SharedLibraryRepository } from "../persistence/Services/SharedLibrary.ts";
import { SEEKER_REFERENCE_5494_HTML } from "./__fixtures__/theseekerReference5494.ts";
import {
  DEFAULT_SHARED_LIBRARY_SYNC_OPTIONS,
  DESIGN_LIBRARY_ID,
  SEEKER_SOURCE,
  SharedLibrarySync,
  makeSharedLibrarySync,
  type SharedLibrarySyncOptions,
} from "./SharedLibrarySync.ts";

const pageFor = (id: number) =>
  SEEKER_REFERENCE_5494_HTML.replace("post:$R[15]={id:5494,", `post:$R[15]={id:${id},`);

interface FakeSite {
  readonly pages: Set<number>;
  readonly listed: number[];
  readonly failing: boolean;
  readonly requests: string[];
}

const fakeSiteLayer = (site: FakeSite) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        site.requests.push(`${url.pathname}${url.search}`);
        if (site.failing) {
          return HttpClientResponse.fromWeb(request, new Response("busy", { status: 503 }));
        }
        const reference = /^\/r\/(\d+)$/u.exec(url.pathname);
        if (reference !== null) {
          const id = Number(reference[1]);
          return site.pages.has(id)
            ? HttpClientResponse.fromWeb(request, new Response(pageFor(id), { status: 200 }))
            : HttpClientResponse.fromWeb(request, new Response("찾을 수 없음", { status: 404 }));
        }
        const links = site.listed.map((id) => `<a href="/r/${id}">`).join("");
        return HttpClientResponse.fromWeb(request, new Response(links, { status: 200 }));
      }),
    ),
  );

const testOptions: SharedLibrarySyncOptions = {
  ...DEFAULT_SHARED_LIBRARY_SYNC_OPTIONS,
  fullScanMissLimit: 3,
  incrementalMissLimit: 3,
  concurrency: 3,
  batchPauseMillis: 0,
  retryBackoffMillis: 0,
  maxConsecutiveFailures: 3,
};

const harness = (site: FakeSite) =>
  Layer.effect(SharedLibrarySync, makeSharedLibrarySync(testOptions)).pipe(
    Layer.provideMerge(SharedLibraryRepositoryLive),
    Layer.provideMerge(fakeSiteLayer(site)),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

it.effect("scans past id gaps to the listed anchors and resumes incrementally", () => {
  const site: FakeSite = {
    pages: new Set([1, 2, 5, 9, 12]),
    listed: [9, 12],
    failing: false,
    requests: [],
  };
  return Effect.gen(function* () {
    const sync = yield* SharedLibrarySync;
    const repository = yield* SharedLibraryRepository;

    const first = yield* sync.runOnce();
    expect(first).toMatchObject({
      scannedFrom: 1,
      scannedTo: 15,
      stored: 5,
      completedFullScan: true,
    });
    expect(yield* repository.countItems()).toEqual([
      { libraryId: DESIGN_LIBRARY_ID, itemCount: 5 },
    ]);

    // A reference collected after a gap wider than the miss window is still
    // reached, because the listing page names it.
    site.pages.add(20);
    site.listed.push(20);
    const second = yield* sync.runOnce();
    expect(second).toMatchObject({ scannedFrom: 13, stored: 1, completedFullScan: false });

    const status = yield* sync.status();
    expect(status.libraries).toEqual([
      { libraryId: DESIGN_LIBRARY_ID, title: "공용 디자인 라이브러리", itemCount: 6 },
    ]);
    expect(status.sources[0]).toMatchObject({
      source: SEEKER_SOURCE,
      origin: "https://ref.theseeker.io",
      maxRef: 20,
      running: false,
      lastError: null,
    });
    expect(status.sources[0]?.fullScanCompletedAt).not.toBeNull();
  }).pipe(Effect.provide(harness(site)));
});

it.effect("stored references answer design searches with their source link", () => {
  const site: FakeSite = { pages: new Set([7]), listed: [7], failing: false, requests: [] };
  return Effect.gen(function* () {
    const sync = yield* SharedLibrarySync;
    const repository = yield* SharedLibraryRepository;
    yield* sync.runOnce();

    const strong = yield* repository.search({
      query: "채용 관리 대시보드를 카드 그리드로 만들어줘",
      requireStrongMatch: true,
    });
    expect(strong[0]).toMatchObject({
      itemId: "theseeker-7",
      sourceUrl: "https://ref.theseeker.io/r/7",
      author: "@vektorastudio",
      category: "dashboard",
    });
    expect(strong[0]?.content).toContain("팔레트:");

    // One incidental body word is not enough to pull a design into a prompt.
    const incidental = yield* repository.search({
      query: "지갑 추적 일정",
      requireStrongMatch: true,
    });
    expect(incidental).toEqual([]);
  }).pipe(Effect.provide(harness(site)));
});

it.effect("stops on a failing site and resumes from the first unread id", () => {
  const site: FakeSite = { pages: new Set([1]), listed: [], failing: true, requests: [] };
  return Effect.gen(function* () {
    const sync = yield* SharedLibrarySync;
    const repository = yield* SharedLibraryRepository;
    const error = yield* sync.runOnce().pipe(Effect.flip);
    expect(error._tag).toBe("SharedLibrarySyncError");

    const state = yield* repository.getSyncState(SEEKER_SOURCE);
    expect(Option.getOrThrow(state)).toMatchObject({ scanCursor: 0, fullScanCompletedAt: null });
    expect(Option.getOrThrow(state).lastError).toContain("다음 동기화가 이어서");
  }).pipe(Effect.provide(harness(site)));
});
