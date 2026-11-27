// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SituationMode } from "@t3tools/contracts";
import { redactMemorySensitiveData } from "../orchestration/memoryPrivacyGuard.ts";
import { analyzeSearchText, buildSearchQuery } from "../persistence/searchText.ts";
import type { PersonaAffectState } from "./AffectStateMachine.ts";

const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export type LivingMemoryScope = "global_user" | "persona_isolated" | "shared_group";
export type LivingMemoryKind = "fact" | "episode" | "reflection" | "anchor" | "discriminative_rule";

export interface LivingMemoryRecord {
  readonly memoryId: string;
  readonly scope: LivingMemoryScope;
  readonly personaId: string | null;
  readonly memoryKind: LivingMemoryKind;
  readonly contentDistilled: string;
  readonly verbatimEvidence: string | null;
  readonly importance: number;
  readonly strengthS: number;
  readonly isPinned: boolean;
  readonly validAt: string;
  readonly invalidAt: string | null;
  readonly createdAt: string;
  readonly expiredAt: string | null;
  readonly updatedBySource: "auto" | "user_edited";
  readonly version: number;
}

function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function md5Hex(text: string): string {
  return NodeCrypto.createHash("md5").update(normalizeForDedup(text)).digest("hex");
}

function extractSimpleTokens(text: string): string {
  const analyzed = analyzeSearchText(text);
  const rawWords = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
  return [analyzed, rawWords].filter(Boolean).join(" ").trim();
}

export interface UpsertLivingMemoryInput {
  readonly memoryId?: string;
  readonly scope: LivingMemoryScope;
  readonly personaId: string | null;
  readonly memoryKind: LivingMemoryKind;
  readonly contentDistilled: string;
  readonly verbatimEvidence?: string | null;
  readonly importance?: number;
  readonly isPinned?: boolean;
  readonly validAt?: string;
  readonly invalidAt?: string | null;
  readonly updatedBySource?: "auto" | "user_edited";
}

export const upsertLivingMemory = Effect.fn("LivingMemoryStore.upsertLivingMemory")(function* (
  input: UpsertLivingMemoryInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const scope = input.scope;
  const personaId = scope === "global_user" ? null : input.personaId;
  const content = redactMemorySensitiveData(input.contentDistilled.trim()).content;
  const scrubbedEvidence = input.verbatimEvidence
    ? redactMemorySensitiveData(input.verbatimEvidence).content
    : null;
  const hash = md5Hex(content);
  const tokens = extractSimpleTokens(content);
  const source = input.updatedBySource ?? "auto";

  // Check if an existing active memory with the same ID or dedup key is user_edited.
  const existing = input.memoryId
    ? yield* sql<{
        memory_id: string;
        updated_by_source: string;
        version: number;
      }>`SELECT memory_id, updated_by_source, version FROM living_memories WHERE memory_id = ${input.memoryId} LIMIT 1`
    : yield* sql<{
        memory_id: string;
        updated_by_source: string;
        version: number;
      }>`SELECT memory_id, updated_by_source, version FROM living_memories
         WHERE scope = ${scope}
           AND COALESCE(persona_id, '__GLOBAL__') = ${personaId ?? "__GLOBAL__"}
           AND normalized_md5 = ${hash}
           AND expired_at IS NULL
         LIMIT 1`;

  const found = existing[0];
  if (found) {
    // Protect user-edited memories from silent auto overwrite (CORE Commit/Defer rule).
    if (found.updated_by_source === "user_edited" && source === "auto") {
      return { status: "deferred_user_edited" as const, memoryId: found.memory_id };
    }
    const nextVersion = found.version + 1;
    yield* sql`UPDATE living_memories
      SET content_distilled = ${content},
          verbatim_evidence = ${scrubbedEvidence},
          morpheme_tokens = ${tokens},
          normalized_md5 = ${hash},
          importance = ${input.importance ?? 5},
          is_pinned = ${input.isPinned ? 1 : 0},
          invalid_at = ${input.invalidAt ?? null},
          updated_by_source = ${source},
          version = ${nextVersion}
      WHERE memory_id = ${found.memory_id} AND version = ${found.version}`;
    yield* sql`DELETE FROM living_memories_fts WHERE memory_id = ${found.memory_id}`;
    yield* sql`INSERT INTO living_memories_fts (memory_id, morpheme_tokens, content_distilled)
      VALUES (${found.memory_id}, ${tokens}, ${content})`;
    return { status: "updated" as const, memoryId: found.memory_id };
  }

  const memoryId = input.memoryId ?? `lmem-${NodeCrypto.randomUUID()}`;
  yield* sql`INSERT INTO living_memories (
    memory_id, scope, persona_id, memory_kind, content_distilled, verbatim_evidence,
    morpheme_tokens, normalized_md5, importance, strength_s, is_pinned,
    valid_at, invalid_at, created_at, expired_at, updated_by_source, version
  ) VALUES (
    ${memoryId}, ${scope}, ${personaId}, ${input.memoryKind}, ${content},
    ${scrubbedEvidence}, ${tokens}, ${hash},
    ${input.importance ?? 5}, 1.0, ${input.isPinned ? 1 : 0},
    ${input.validAt ?? nowIso}, ${input.invalidAt ?? null}, ${nowIso}, NULL,
    ${source}, 1
  )`;
  yield* sql`INSERT INTO living_memories_fts (memory_id, morpheme_tokens, content_distilled)
    VALUES (${memoryId}, ${tokens}, ${content})`;
  return { status: "inserted" as const, memoryId };
});

/**
 * Single-pass scoped recall: returns shared `global_user` facts AND ONLY the active
 * persona's `persona_isolated` memories (preventing cross-persona bleed & Mem0 AND-0 trap).
 */
export const recallLivingMemoriesForPersona = Effect.fn(
  "LivingMemoryStore.recallLivingMemoriesForPersona",
)(function* (input: {
  readonly personaId: string;
  readonly query: string;
  readonly nowIso?: string;
  readonly limitPerScope?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = input.nowIso ?? DateTime.formatIso(yield* DateTime.now);
  const limit = input.limitPerScope ?? 3;
  const parsedQuery = buildSearchQuery(input.query);
  const queryTerms =
    parsedQuery?.terms && parsedQuery.terms.length > 0
      ? [...parsedQuery.terms]
      : (input.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2);

  const ftsMatchedIds = new Set<string>();
  if (parsedQuery) {
    const ftsHits = yield* sql<{ memory_id: string }>`
      SELECT f.memory_id
      FROM living_memories_fts f
      JOIN living_memories m ON m.memory_id = f.memory_id
      WHERE living_memories_fts MATCH ${parsedQuery.match}
        AND m.expired_at IS NULL
        AND (m.invalid_at IS NULL OR m.invalid_at > ${nowIso})
        AND (m.scope = 'global_user' OR (m.scope = 'persona_isolated' AND m.persona_id = ${input.personaId}))
      ORDER BY bm25(living_memories_fts) ASC
      LIMIT 30
    `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ memory_id: string }>));
    for (const hit of ftsHits) ftsMatchedIds.add(hit.memory_id);
  }

  const baseRows = yield* sql<{
    memory_id: string;
    scope: LivingMemoryScope;
    persona_id: string | null;
    memory_kind: LivingMemoryKind;
    content_distilled: string;
    verbatim_evidence: string | null;
    importance: number;
    strength_s: number;
    is_pinned: number;
    valid_at: string;
    invalid_at: string | null;
    created_at: string;
    expired_at: string | null;
    updated_by_source: "auto" | "user_edited";
    version: number;
  }>`SELECT memory_id, scope, persona_id, memory_kind, content_distilled, verbatim_evidence,
            importance, strength_s, is_pinned, valid_at, invalid_at, created_at, expired_at,
            updated_by_source, version
     FROM living_memories
     WHERE expired_at IS NULL
       AND (invalid_at IS NULL OR invalid_at > ${nowIso})
       AND (scope = 'global_user' OR (scope = 'persona_isolated' AND persona_id = ${input.personaId}))
     ORDER BY is_pinned DESC, importance DESC, strength_s DESC, created_at DESC
     LIMIT 60`;

  const seenIds = new Set(baseRows.map((r) => r.memory_id));
  const missingFtsIds = [...ftsMatchedIds].filter((id) => !seenIds.has(id));
  const extraFtsRows =
    missingFtsIds.length > 0
      ? yield* sql<(typeof baseRows)[number]>`
          SELECT memory_id, scope, persona_id, memory_kind, content_distilled, verbatim_evidence,
                 importance, strength_s, is_pinned, valid_at, invalid_at, created_at, expired_at,
                 updated_by_source, version
          FROM living_memories
          WHERE memory_id IN ${sql.in(missingFtsIds)}
        `
      : [];
  const rows = [...baseRows, ...extraFtsRows];

  const scored = rows.map((row) => {
    const hay = row.content_distilled.normalize("NFKC").toLowerCase();
    let hits = ftsMatchedIds.has(row.memory_id) ? 1 : 0;
    for (const term of queryTerms) if (hay.includes(term)) hits += 1;
    const score =
      (row.is_pinned ? 100 : 0) + hits * 15 + row.importance * 2 + Math.min(10, row.strength_s);
    const record: LivingMemoryRecord = {
      memoryId: row.memory_id,
      scope: row.scope,
      personaId: row.persona_id,
      memoryKind: row.memory_kind,
      contentDistilled: row.content_distilled,
      verbatimEvidence: row.verbatim_evidence,
      importance: row.importance,
      strengthS: row.strength_s,
      isPinned: row.is_pinned === 1,
      validAt: row.valid_at,
      invalidAt: row.invalid_at,
      createdAt: row.created_at,
      expiredAt: row.expired_at,
      updatedBySource: row.updated_by_source,
      version: row.version,
    };
    return { record, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const humanFacts = scored
    .filter((s) => s.record.scope === "global_user")
    .slice(0, limit)
    .map((s) => s.record);
  const personaMemories = scored
    .filter((s) => s.record.scope === "persona_isolated")
    .slice(0, limit)
    .map((s) => s.record);

  // MemoryBank recall reinforcement: S <- S + 0.5 for recalled memories.
  for (const recalled of [...humanFacts, ...personaMemories]) {
    yield* sql`UPDATE living_memories SET strength_s = strength_s + 0.5 WHERE memory_id = ${recalled.memoryId}`;
  }

  return { humanFacts, personaMemories };
});

export const loadPersonaAffectState = Effect.fn("LivingMemoryStore.loadPersonaAffectState")(
  function* (personaId: string) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      persona_id: string;
      pad_p: number;
      pad_a: number;
      pad_d: number;
      active_impulses_json: string;
      rumination_json: string;
      last_situation_mode: SituationMode;
      last_updated_ms: number;
    }>`SELECT persona_id, pad_p, pad_a, pad_d, active_impulses_json, rumination_json,
              last_situation_mode, last_updated_ms
       FROM persona_affect_states WHERE persona_id = ${personaId} LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      personaId: row.persona_id,
      pad: { p: row.pad_p, a: row.pad_a, d: row.pad_d },
      activeImpulses: decodeUnknownJson(
        row.active_impulses_json,
      ) as PersonaAffectState["activeImpulses"],
      rumination: decodeUnknownJson(row.rumination_json) as PersonaAffectState["rumination"],
      lastSituationMode: row.last_situation_mode,
      lastUpdatedMs: row.last_updated_ms,
    };
  },
);

export const savePersonaAffectState = Effect.fn("LivingMemoryStore.savePersonaAffectState")(
  function* (state: PersonaAffectState) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO persona_affect_states (
      persona_id, pad_p, pad_a, pad_d, active_impulses_json, rumination_json,
      last_situation_mode, last_updated_ms
    ) VALUES (
      ${state.personaId}, ${state.pad.p}, ${state.pad.a}, ${state.pad.d},
      ${encodeUnknownJson(state.activeImpulses)}, ${encodeUnknownJson(state.rumination)},
      ${state.lastSituationMode}, ${state.lastUpdatedMs}
    )
    ON CONFLICT(persona_id) DO UPDATE SET
      pad_p = excluded.pad_p,
      pad_a = excluded.pad_a,
      pad_d = excluded.pad_d,
      active_impulses_json = excluded.active_impulses_json,
      rumination_json = excluded.rumination_json,
      last_situation_mode = excluded.last_situation_mode,
      last_updated_ms = excluded.last_updated_ms`;
  },
);
