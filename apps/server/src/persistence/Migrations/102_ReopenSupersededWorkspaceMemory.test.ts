import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0102 from "./102_ReopenSupersededWorkspaceMemory.ts";

it.effect("reopens every closed memory once and keeps the previous values in a backup table", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 101 });
    const insert = (
      id: string,
      tier: string,
      closed: { validTo?: number; expiredAt?: number; supersededBy?: string; supersedes?: string },
    ) => sql`INSERT INTO workspace_memory_v2(id,project_id,scope,topic,text,source_json,source_hash,origin,
        verification,status,created_at,updated_at,memory_tier,entity_key,predicate_slot,valid_from,
        valid_to,expired_at,superseded_by_id,supersedes_ids)
      VALUES (${id},'p','project','이전 작업 보고',${`text ${id}`},'{"kind":"message","id":"m"}','h','assistant',
        'unverified-report','observed','2026-11-01','2026-11-01',${tier},'이전 작업 보고','port',1,
        ${closed.validTo ?? null},${closed.expiredAt ?? null},${closed.supersededBy ?? null},${closed.supersedes ?? "[]"})`;
    yield* insert("closed", "cold", { validTo: 10, expiredAt: 20, supersededBy: "closed-winner" });
    yield* insert("closed-winner", "cold", {
      validTo: 30,
      expiredAt: 40,
      supersededBy: "survivor",
      supersedes: '["closed"]',
    });
    yield* insert("survivor", "hot", { supersedes: '["closed-winner"]' });
    yield* insert("valid-to-only", "cold", { validTo: 5 });
    yield* insert("untouched", "cold", {});
    const rows = () =>
      sql`SELECT id,memory_tier,entity_key,predicate_slot,valid_from,valid_to,expired_at,superseded_by_id,
        supersedes_ids,text,status,updated_at FROM workspace_memory_v2 ORDER BY id`;
    const backup = () => sql`SELECT * FROM workspace_memory_v2_supersede_backup_102 ORDER BY id`;
    const [untouched] = yield* sql`SELECT * FROM workspace_memory_v2 WHERE id='untouched'`;

    expect(yield* runMigrations()).toEqual([[102, "ReopenSupersededWorkspaceMemory"]]);

    const open = { valid_to: null, expired_at: null, superseded_by_id: null, supersedes_ids: "[]" };
    const reopened = yield* rows();
    expect(reopened).toMatchObject([
      { id: "closed", memory_tier: "warm", ...open },
      { id: "closed-winner", memory_tier: "warm", ...open },
      { id: "survivor", memory_tier: "hot", ...open },
      { id: "untouched", memory_tier: "cold", ...open },
      { id: "valid-to-only", memory_tier: "warm", ...open },
    ]);
    expect(yield* sql`SELECT * FROM workspace_memory_v2 WHERE id='untouched'`).toEqual([untouched]);
    const saved = yield* backup();
    expect(saved).toEqual([
      {
        id: "closed",
        valid_to: 10,
        expired_at: 20,
        superseded_by_id: "closed-winner",
        supersedes_ids: "[]",
        memory_tier: "cold",
        entity_key: "이전 작업 보고",
        predicate_slot: "port",
      },
      {
        id: "closed-winner",
        valid_to: 30,
        expired_at: 40,
        superseded_by_id: "survivor",
        supersedes_ids: '["closed"]',
        memory_tier: "cold",
        entity_key: "이전 작업 보고",
        predicate_slot: "port",
      },
      {
        id: "survivor",
        valid_to: null,
        expired_at: null,
        superseded_by_id: null,
        supersedes_ids: '["closed-winner"]',
        memory_tier: "hot",
        entity_key: "이전 작업 보고",
        predicate_slot: "port",
      },
      {
        id: "valid-to-only",
        valid_to: 5,
        expired_at: null,
        superseded_by_id: null,
        supersedes_ids: "[]",
        memory_tier: "cold",
        entity_key: "이전 작업 보고",
        predicate_slot: "port",
      },
    ]);

    // Applying it again changes neither the memories nor the backup.
    yield* Migration0102;
    expect(yield* rows()).toEqual(reopened);
    expect(yield* backup()).toEqual(saved);
    expect(yield* runMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
