import type { SharedLibraryMatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { analyzeSearchText, buildSearchQuery, makeSnippet, termCoverage } from "../searchText.ts";
import {
  SharedLibraryRepository,
  type SharedLibraryRepositoryShape,
  type SharedLibrarySyncState,
} from "../Services/SharedLibrary.ts";

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;

const TagsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeTags = Schema.encodeSync(TagsJson);
const decodeTags = Schema.decodeUnknownOption(TagsJson);

const parseTags = (json: string): ReadonlyArray<string> =>
  Option.getOrElse(decodeTags(json), (): ReadonlyArray<string> => []);

interface SyncStateRow {
  readonly source: string;
  readonly libraryId: string;
  readonly maxRef: number;
  readonly scanCursor: number;
  readonly fullScanCompletedAt: string | null;
  readonly lastSyncAt: string | null;
  readonly lastError: string | null;
}

const toSyncState = (row: SyncStateRow): SharedLibrarySyncState => ({
  source: row.source,
  libraryId: row.libraryId,
  maxRef: Number(row.maxRef),
  scanCursor: Number(row.scanCursor),
  fullScanCompletedAt: row.fullScanCompletedAt,
  lastSyncAt: row.lastSyncAt,
  lastError: row.lastError,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertItem: SharedLibraryRepositoryShape["upsertItem"] = (item) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO shared_library_items (
              library_id, item_id, source, source_ref, source_url, title, content,
              tags_json, category, author, published_at, fetched_at
            ) VALUES (
              ${item.libraryId}, ${item.itemId}, ${item.source}, ${item.sourceRef},
              ${item.sourceUrl}, ${item.title}, ${item.content}, ${encodeTags(item.tags)},
              ${item.category}, ${item.author}, ${item.publishedAt}, ${item.fetchedAt}
            )
            ON CONFLICT (library_id, item_id) DO UPDATE SET
              source = excluded.source,
              source_ref = excluded.source_ref,
              source_url = excluded.source_url,
              title = excluded.title,
              content = excluded.content,
              tags_json = excluded.tags_json,
              category = excluded.category,
              author = excluded.author,
              published_at = excluded.published_at,
              fetched_at = excluded.fetched_at
          `;
          yield* sql`
            DELETE FROM shared_library_search
            WHERE library_id = ${item.libraryId} AND item_id = ${item.itemId}
          `;
          yield* sql`
            INSERT INTO shared_library_search (
              library_id, item_id, search_title, search_tags, search_body
            ) VALUES (
              ${item.libraryId}, ${item.itemId}, ${analyzeSearchText(item.title)},
              ${analyzeSearchText(item.tags.join(" "))},
              ${analyzeSearchText(`${item.content}\n${item.searchExtra}`)}
            )
          `;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("SharedLibrary.upsertItem")));

  const hasItem: SharedLibraryRepositoryShape["hasItem"] = (input) =>
    sql<{ readonly found: number }>`
      SELECT COUNT(*) AS found
      FROM shared_library_items
      WHERE library_id = ${input.libraryId} AND item_id = ${input.itemId}
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0),
      Effect.mapError(toPersistenceSqlError("SharedLibrary.hasItem")),
    );

  const search: SharedLibraryRepositoryShape["search"] = (input) => {
    const query = buildSearchQuery(input.query);
    if (query === null) return Effect.succeed([]);
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    return sql<{
      readonly libraryId: string;
      readonly itemId: string;
      readonly title: string;
      readonly content: string;
      readonly tagsJson: string;
      readonly sourceUrl: string;
      readonly author: string | null;
      readonly category: string | null;
      readonly score: number;
    }>`
      SELECT
        items.library_id AS "libraryId",
        items.item_id AS "itemId",
        items.title,
        items.content,
        items.tags_json AS "tagsJson",
        items.source_url AS "sourceUrl",
        items.author,
        items.category,
        -bm25(shared_library_search, 0.0, 0.0, 3.0, 2.0, 1.0) AS score
      FROM shared_library_search
      JOIN shared_library_items AS items
        ON items.library_id = shared_library_search.library_id
        AND items.item_id = shared_library_search.item_id
      WHERE shared_library_search MATCH ${query.match}
      ORDER BY bm25(shared_library_search, 0.0, 0.0, 3.0, 2.0, 1.0) ASC
      LIMIT ${limit * 5}
    `.pipe(
      Effect.map(
        (rows): ReadonlyArray<SharedLibraryMatch> =>
          rows
            .map((row) => {
              const tags = parseTags(row.tagsJson);
              const headline = `${row.title} ${tags.join(" ")}`;
              const coverage = termCoverage(query.terms, `${headline} ${row.content}`);
              return {
                row,
                tags,
                coverage,
                headlineHit: termCoverage(query.terms, headline) > 0,
                rank: Number(row.score) * (1 + coverage),
              };
            })
            .filter(
              (candidate) =>
                input.requireStrongMatch !== true ||
                candidate.coverage >= 2 ||
                candidate.headlineHit,
            )
            .toSorted((left, right) => right.rank - left.rank)
            .slice(0, limit)
            .map(({ row, tags, rank }) => ({
              libraryId: row.libraryId,
              itemId: row.itemId,
              title: row.title,
              snippet: makeSnippet(row.content, query.terms),
              content: row.content,
              sourceUrl: row.sourceUrl,
              author: row.author,
              category: row.category,
              tags,
              score: rank,
            })),
      ),
      Effect.mapError(toPersistenceSqlError("SharedLibrary.search")),
    );
  };

  const countItems: SharedLibraryRepositoryShape["countItems"] = () =>
    sql<{ readonly libraryId: string; readonly itemCount: number }>`
      SELECT library_id AS "libraryId", COUNT(*) AS "itemCount"
      FROM shared_library_items
      GROUP BY library_id
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ libraryId: row.libraryId, itemCount: Number(row.itemCount) })),
      ),
      Effect.mapError(toPersistenceSqlError("SharedLibrary.countItems")),
    );

  const selectSyncStates = (source: string | null) =>
    sql<SyncStateRow>`
      SELECT
        source,
        library_id AS "libraryId",
        max_ref AS "maxRef",
        scan_cursor AS "scanCursor",
        full_scan_completed_at AS "fullScanCompletedAt",
        last_sync_at AS "lastSyncAt",
        last_error AS "lastError"
      FROM shared_library_sync_state
      WHERE ${source} IS NULL OR source = ${source}
      ORDER BY source
    `.pipe(Effect.map((rows) => rows.map(toSyncState)));

  const getSyncState: SharedLibraryRepositoryShape["getSyncState"] = (source) =>
    selectSyncStates(source).pipe(
      Effect.map((states) => Option.fromNullishOr(states[0])),
      Effect.mapError(toPersistenceSqlError("SharedLibrary.getSyncState")),
    );

  const listSyncStates: SharedLibraryRepositoryShape["listSyncStates"] = () =>
    selectSyncStates(null).pipe(
      Effect.mapError(toPersistenceSqlError("SharedLibrary.listSyncStates")),
    );

  const saveSyncState: SharedLibraryRepositoryShape["saveSyncState"] = (state) =>
    sql`
      INSERT INTO shared_library_sync_state (
        source, library_id, max_ref, scan_cursor, full_scan_completed_at,
        last_sync_at, last_error, updated_at
      ) VALUES (
        ${state.source}, ${state.libraryId}, ${state.maxRef}, ${state.scanCursor},
        ${state.fullScanCompletedAt}, ${state.lastSyncAt}, ${state.lastError}, ${state.updatedAt}
      )
      ON CONFLICT (source) DO UPDATE SET
        library_id = excluded.library_id,
        max_ref = excluded.max_ref,
        scan_cursor = excluded.scan_cursor,
        full_scan_completed_at = excluded.full_scan_completed_at,
        last_sync_at = excluded.last_sync_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("SharedLibrary.saveSyncState")));

  return SharedLibraryRepository.of({
    upsertItem,
    hasItem,
    search,
    countItems,
    getSyncState,
    listSyncStates,
    saveSyncState,
  });
});

export const SharedLibraryRepositoryLive = Layer.effect(SharedLibraryRepository, make);
