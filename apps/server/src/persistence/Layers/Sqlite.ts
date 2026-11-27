import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

/**
 * Memory-bounded WAL tuning for T3's SQLite state store:
 * - `wal_autocheckpoint = 1000` (~4 MiB) prevents 90+ MiB WAL buildup.
 * - `journal_size_limit = 64 MiB` truncates overgrown WAL files after checkpoint.
 * - `cache_size = -32768` caps per-connection page cache at 32 MiB.
 * - `mmap_size = 256 MiB` bounds memory-mapped read footprint.
 */
export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
export const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024;
export const SQLITE_CACHE_SIZE_KIB = -32_768;
export const SQLITE_PASSIVE_CHECKPOINT_INTERVAL = Duration.minutes(10);

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

export const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

const makeSetup = (options: { readonly enablePeriodicCheckpoint: boolean }) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* sql`PRAGMA synchronous = NORMAL;`;
      yield* sql`PRAGMA wal_autocheckpoint = 1000;`;
      yield* sql`PRAGMA journal_size_limit = 67108864;`;
      yield* sql`PRAGMA mmap_size = 268435456;`;
      yield* sql`PRAGMA temp_store = MEMORY;`;
      yield* sql`PRAGMA cache_size = -32768;`;
      yield* runMigrations();
      if (options.enablePeriodicCheckpoint) {
        yield* sql`PRAGMA wal_checkpoint(PASSIVE);`.pipe(
          Effect.ignore,
          Effect.repeat(Schedule.spaced(SQLITE_PASSIVE_CHECKPOINT_INTERVAL)),
          Effect.forkScoped,
        );
      }
    }),
  );

const setupLive = makeSetup({ enablePeriodicCheckpoint: true });
const setupMemory = makeSetup({ enablePeriodicCheckpoint: false });

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setupLive,
    makeRuntimeSqliteLayer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setupMemory,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return makeSqlitePersistenceLive(dbPath);
  }),
);
