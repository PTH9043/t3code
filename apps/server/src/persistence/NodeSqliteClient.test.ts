import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("streams a large query completely and releases a cancelled iterator", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = sql<{
        n: number;
        text: string;
      }>`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<10000) SELECT n,printf('%04096d',n) AS text FROM numbers`;
      const totals = yield* query.stream.pipe(
        Stream.runFold(
          () => ({ count: 0, chars: 0 }),
          (acc, row) => ({ count: acc.count + 1, chars: acc.chars + row.text.length }),
        ),
      );
      assert.deepEqual(totals, { count: 10000, chars: 40960000 });
      const first = yield* query.stream.pipe(Stream.take(3), Stream.runCollect);
      assert.equal(first.length, 3);
      const [result] = yield* sql<{ n: number }>`SELECT 42 AS n`;
      assert.equal(result?.n, 42);
      const repeated = yield* query.stream.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(repeated[0]?.n, 1);
    }),
  );
  it.effect("returns a typed failure for invalid streaming SQL", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* sql.unsafe("SELECT FROM").stream.pipe(Stream.runDrain, Effect.flip);
      assert.equal(error._tag, "SqlError");
    }),
  );
  it.effect("waits for short cross-process write contention", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [timeout] = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`;
      assert.equal(timeout?.timeout, 5000);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );
});

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);
