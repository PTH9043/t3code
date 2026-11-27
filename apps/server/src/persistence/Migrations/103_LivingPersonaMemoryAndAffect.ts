import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Living Persona Engine persistence tables:
 * 1) `persona_affect_states`: per-persona isolated PAD state & rumination queue
 * 2) `living_memories` + `living_memories_fts`: bi-temporal user (`global_user`) and
 *    persona-isolated (`persona_isolated`) distilled memories with user-edit protection
 * 3) `persona_revisions`: content-hashed persona snapshot history
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS persona_affect_states (
    persona_id           TEXT PRIMARY KEY,
    pad_p                REAL NOT NULL DEFAULT 0.0,
    pad_a                REAL NOT NULL DEFAULT 0.0,
    pad_d                REAL NOT NULL DEFAULT 0.0,
    active_impulses_json TEXT NOT NULL DEFAULT '[]',
    rumination_json      TEXT NOT NULL DEFAULT '[]',
    last_situation_mode  TEXT NOT NULL DEFAULT 'DEEP_WORK',
    last_updated_ms      INTEGER NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS living_memories (
    memory_id         TEXT PRIMARY KEY,
    scope             TEXT NOT NULL CHECK (scope IN ('global_user', 'persona_isolated', 'shared_group')),
    persona_id        TEXT,
    memory_kind       TEXT NOT NULL CHECK (memory_kind IN ('fact', 'episode', 'reflection', 'anchor', 'discriminative_rule')),
    content_distilled TEXT NOT NULL,
    verbatim_evidence TEXT,
    morpheme_tokens   TEXT NOT NULL DEFAULT '',
    normalized_md5    TEXT NOT NULL,
    importance        INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
    strength_s        REAL NOT NULL DEFAULT 1.0,
    is_pinned         INTEGER NOT NULL DEFAULT 0,
    valid_at          TEXT NOT NULL,
    invalid_at        TEXT,
    created_at        TEXT NOT NULL,
    expired_at        TEXT,
    updated_by_source TEXT NOT NULL DEFAULT 'auto' CHECK (updated_by_source IN ('auto', 'user_edited')),
    version           INTEGER NOT NULL DEFAULT 1
  )`;

  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_living_mem_dedup
    ON living_memories(scope, COALESCE(persona_id, '__GLOBAL__'), normalized_md5)
    WHERE expired_at IS NULL`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_living_mem_scope_persona
    ON living_memories(scope, persona_id, expired_at, is_pinned DESC, importance DESC)`;

  yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS living_memories_fts USING fts5(
    memory_id UNINDEXED,
    morpheme_tokens,
    content_distilled,
    tokenize = 'unicode61'
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS persona_revisions (
    revision_id          TEXT PRIMARY KEY,
    persona_id           TEXT NOT NULL,
    content_sha256       TEXT NOT NULL,
    snapshot_bundle_json TEXT NOT NULL,
    change_note          TEXT NOT NULL DEFAULT '',
    is_starred           INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL
  )`;
});
