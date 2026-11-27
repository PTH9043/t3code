import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  loadPersonaAffectState,
  recallLivingMemoriesForPersona,
  savePersonaAffectState,
  upsertLivingMemory,
} from "./LivingMemoryStore.ts";
import { createInitialAffectState } from "./AffectStateMachine.ts";

it.effect(
  "isolates persona_isolated memories across personas while sharing global_user facts and protecting user_edited rows",
  () =>
    Effect.gen(function* () {
      // 1. Shared user fact (global_user)
      const shared = yield* upsertLivingMemory({
        scope: "global_user",
        personaId: null,
        memoryKind: "fact",
        contentDistilled: "대표님은 로컬 SQLite WAL 구조를 선호함.",
        importance: 8,
        updatedBySource: "user_edited",
      });
      expect(shared.status).toBe("inserted");

      // 2. Auto attempt to overwrite user_edited memory must defer!
      const deferred = yield* upsertLivingMemory({
        memoryId: shared.memoryId,
        scope: "global_user",
        personaId: null,
        memoryKind: "fact",
        contentDistilled: "자동 덮어쓰기 시도",
        updatedBySource: "auto",
      });
      expect(deferred.status).toBe("deferred_user_edited");

      // 3. Persona A isolated memory
      yield* upsertLivingMemory({
        scope: "persona_isolated",
        personaId: "builtin-chief-of-staff",
        memoryKind: "episode",
        contentDistilled: "비서실장 서윤과 심야 배포 금지 약속을 함.",
        importance: 9,
      });

      // 4. Persona B isolated memory
      yield* upsertLivingMemory({
        scope: "persona_isolated",
        personaId: "user-architect",
        memoryKind: "episode",
        contentDistilled: "수석 아키텍트 강태오와 SQLite 락 경합을 토론함.",
        importance: 8,
      });

      // 5. Recall for Persona A: gets global_user + ONLY Persona A (0% bleed from Persona B)
      const recallA = yield* recallLivingMemoriesForPersona({
        personaId: "builtin-chief-of-staff",
        query: "SQLite 심야 배포",
      });
      expect(recallA.humanFacts.map((m) => m.contentDistilled)).toContain(
        "대표님은 로컬 SQLite WAL 구조를 선호함.",
      );
      expect(recallA.personaMemories).toHaveLength(1);
      expect(recallA.personaMemories[0]!.personaId).toBe("builtin-chief-of-staff");

      // 6. Recall for Persona B: gets global_user + ONLY Persona B (0% bleed from Persona A)
      const recallB = yield* recallLivingMemoriesForPersona({
        personaId: "user-architect",
        query: "SQLite 락 경합",
      });
      expect(recallB.humanFacts).toHaveLength(1);
      expect(recallB.personaMemories).toHaveLength(1);
      expect(recallB.personaMemories[0]!.personaId).toBe("user-architect");

      // 7. Affect state persistence roundtrip
      const state = createInitialAffectState(
        "builtin-chief-of-staff",
        {
          openness: 0.35,
          conscientiousness: 0.88,
          extraversion: 0.2,
          agreeableness: 0.55,
          neuroticism: -0.3,
        },
        1_700_000_000_000,
      );
      yield* savePersonaAffectState(state);
      const loaded = yield* loadPersonaAffectState("builtin-chief-of-staff");
      expect(loaded?.personaId).toBe("builtin-chief-of-staff");
      expect(loaded?.pad.p).toBeCloseTo(state.pad.p, 5);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
