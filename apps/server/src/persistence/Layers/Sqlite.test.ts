import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SQLITE_CACHE_SIZE_KIB,
  SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
  SQLITE_WAL_AUTOCHECKPOINT_PAGES,
} from "./Sqlite.ts";

describe("Sqlite persistence WAL and memory PRAGMA tuning", () => {
  it.live(
    "applies WAL autocheckpoint, journal size limit, synchronous=NORMAL, and bounded cache_size",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-wal-" });
          const dbPath = path.join(dir, "state.sqlite");

          const result = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [journalMode] = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode;`;
            const [walAuto] = yield* sql<{
              wal_autocheckpoint: number;
            }>`PRAGMA wal_autocheckpoint;`;
            const [journalLimit] = yield* sql<{
              journal_size_limit: number;
            }>`PRAGMA journal_size_limit;`;
            const [synchronous] = yield* sql<{ synchronous: number }>`PRAGMA synchronous;`;
            const [cacheSize] = yield* sql<{ cache_size: number }>`PRAGMA cache_size;`;
            const [foreignKeys] = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys;`;
            return {
              journalMode: journalMode?.journal_mode,
              walAuto: walAuto?.wal_autocheckpoint,
              journalLimit: journalLimit?.journal_size_limit,
              synchronous: synchronous?.synchronous,
              cacheSize: cacheSize?.cache_size,
              foreignKeys: foreignKeys?.foreign_keys,
            };
          }).pipe(Effect.provide(makeSqlitePersistenceLive(dbPath)));

          expect(result.journalMode?.toLowerCase()).toBe("wal");
          expect(result.walAuto).toBe(SQLITE_WAL_AUTOCHECKPOINT_PAGES);
          expect(result.journalLimit).toBe(SQLITE_JOURNAL_SIZE_LIMIT_BYTES);
          // SQLite PRAGMA synchronous: 1 === NORMAL
          expect(result.synchronous).toBe(1);
          expect(result.cacheSize).toBe(SQLITE_CACHE_SIZE_KIB);
          expect(result.foreignKeys).toBe(1);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
