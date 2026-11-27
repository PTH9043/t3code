import { expect, it } from "vite-plus/test";
import {
  applyAffectImpulse,
  createInitialAffectState,
  decayAffectState,
  padDeltaFromBaseline,
} from "./AffectStateMachine.ts";
import { enqueuePostTurnPersonaUpdate } from "./PersonaPostTurnWorker.ts";

const ocean = {
  openness: 0.35,
  conscientiousness: 0.88,
  extraversion: 0.2,
  agreeableness: 0.55,
  neuroticism: -0.3,
};

it("decays arousal faster than pleasure/dominance and compresses after 6h sleep", () => {
  const t0 = 1_700_000_000_000;
  const initial = createInitialAffectState("builtin-chief-of-staff", ocean, t0);
  const excited = applyAffectImpulse({
    state: initial,
    ocean,
    label: "joy",
    intensity: 1,
    situationMode: "CELEBRATION",
    nowMs: t0,
  });

  const delta0 = padDeltaFromBaseline(excited.pad, ocean);
  const after2h = decayAffectState(excited, ocean, t0 + 2 * 3_600_000);
  const delta2h = padDeltaFromBaseline(after2h.pad, ocean);
  // Arousal ratio must decay much faster than Pleasure ratio.
  expect(Math.abs(delta2h.a / delta0.a)).toBeLessThan(Math.abs(delta2h.p / delta0.p));

  const afterSleep = decayAffectState(excited, ocean, t0 + 7 * 3_600_000);
  expect(afterSleep.activeImpulses).toHaveLength(0);
  expect(Math.abs(padDeltaFromBaseline(afterSleep.pad, ocean).a)).toBeLessThan(
    Math.abs(delta0.a) * 0.2,
  );
});

it("enforces 15m habituation (0.7^k), 3-layer rumination dedup, and INCIDENT_RESPONSE firewall", () => {
  const t0 = 1_700_000_000_000;
  let state = createInitialAffectState("builtin-chief-of-staff", ocean, t0);
  const first = applyAffectImpulse({
    state,
    ocean,
    label: "joy",
    intensity: 1,
    situationMode: "CELEBRATION",
    ruminationCandidate: { text: "심야 마이그레이션 주의 약속 기억하기", importance: 8 },
    nowMs: t0,
  });
  const second = applyAffectImpulse({
    state: first,
    ocean,
    label: "joy",
    intensity: 1,
    situationMode: "CELEBRATION",
    // Near-duplicate rumination (>0.85 Jaccard) must be rejected by circuit breaker
    ruminationCandidate: { text: "심야 마이그레이션 주의 약속 기억하기", importance: 8 },
    nowMs: t0 + 60_000,
  });
  expect(second.rumination).toHaveLength(1);
  // Second joy gain must be strictly smaller due to 0.7^k habituation + elastic damping
  const gain1 = first.pad.p - state.pad.p;
  const gain2 = second.pad.p - first.pad.p;
  expect(gain2).toBeLessThan(gain1);

  // INCIDENT_RESPONSE activates emotional firewall and mutes rumination
  const incident = applyAffectImpulse({
    state: second,
    ocean,
    label: "alarm",
    intensity: 1,
    situationMode: "INCIDENT_RESPONSE",
    nowMs: t0 + 120_000,
  });
  expect(incident.rumination).toHaveLength(0);
});

it("runs post-turn appraisal and memory extraction serially on backgroundModelQueue", async () => {
  let stored = createInitialAffectState("builtin-chief-of-staff", ocean, 1_700_000_000_000);
  let extracted = false;
  const updated = await enqueuePostTurnPersonaUpdate({
    personaId: "builtin-chief-of-staff",
    ocean,
    situationMode: "SUNK_COST_BRAKE",
    userText: "마통으로 물타기 할까?",
    assistantText: "대표님, 브레이크부터 밟을게요.",
    loadState: async () => stored,
    saveState: async (next) => {
      stored = next;
    },
    extractMemories: async () => {
      extracted = true;
    },
  });
  expect(extracted).toBe(true);
  expect(updated.lastSituationMode).toBe("SUNK_COST_BRAKE");
  expect(updated.pad.d).toBeGreaterThan(0);
});
