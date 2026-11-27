import type {
  MissionDagStep,
  MissionSynapsePacket,
  MissionSynapseWeightRecord,
} from "@t3tools/contracts";

/**
 * Layer 3 / 규칙 5: DyLAN Agent Importance Score & GPTSwarm 시냅스 연결망 역전파 엔진.
 *
 * - 회의나 미션이 끝날 때마다 최종 채택 결론에 각 역할·모델이 얼마나 기여했는지
 *   0-LLM 결정론적 역전파로 점수를 산출해 SQLite `mission_synapse_weights` 및
 *   `mission_synapse_edges`의 EMA 가중치를 자동 갱신한다.
 * - 누적 표본이 5회 이상이고 기여도가 0.32 미만인 조합은 자동 가지치기(Pruning) 권장 대상으로 표시한다.
 */

export const DYLAN_MIN_SAMPLES_FOR_PRUNE = 5;
export const DYLAN_PRUNE_THRESHOLD = 0.32;
const EMA_ALPHA = 0.3;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, " ")
      .split(/\s+/u)
      .filter((t) => t.length >= 2),
  );
}

function overlapRatio(source: Set<string>, target: Set<string>): number {
  if (source.size === 0 || target.size === 0) return 0;
  let hits = 0;
  for (const tok of source) {
    if (target.has(tok)) hits += 1;
  }
  return hits / source.size;
}

export function updateEmaScore(prev: number, next: number, sampleCount: number): number {
  if (sampleCount <= 0) return Math.round(next * 1000) / 1000;
  const blended = prev * (1 - EMA_ALPHA) + next * EMA_ALPHA;
  return Math.round(Math.max(0.05, Math.min(1.0, blended)) * 1000) / 1000;
}

export function isRecommendedForPruning(weight: MissionSynapseWeightRecord): boolean {
  return (
    weight.sampleCount >= DYLAN_MIN_SAMPLES_FOR_PRUNE &&
    weight.importanceEma < DYLAN_PRUNE_THRESHOLD
  );
}

export interface RoleBackpropDelta {
  readonly roleKey: string;
  readonly importanceScore: number;
  readonly tokenEfficiency: number;
  readonly adopted: boolean;
}

/**
 * 합석 회의 종료 후 최종 통합본(`finalSynthesisMd`) 대비 각 참가자 패킷의 채택 기여도를 역산한다.
 */
export function backpropagateMeetingImportance(input: {
  readonly packets: ReadonlyArray<MissionSynapsePacket>;
  readonly finalSynthesisMd: string;
}): {
  readonly updatedPackets: ReadonlyArray<MissionSynapsePacket>;
  readonly roleDeltas: ReadonlyArray<RoleBackpropDelta>;
  readonly synapseEdges: ReadonlyArray<{
    readonly fromRoleKey: string;
    readonly toRoleKey: string;
    readonly weight: number;
  }>;
} {
  const synthTokens = tokenize(input.finalSynthesisMd);
  const byRole = new Map<string, { scores: number[]; efficiencies: number[]; adopted: boolean }>();
  const edgeAccumulator = new Map<string, number>();

  const updatedPackets = input.packets.map((pkt) => {
    const claimTokens = tokenize(`${pkt.claim} ${pkt.evidence.join(" ")} ${pkt.riskOrCounter}`);
    const adoption = overlapRatio(claimTokens, synthTokens);
    const evidenceBonus = Math.min(0.25, pkt.evidence.length * 0.08);
    const upwardBonus = pkt.upwardFeedback && adoption >= 0.2 ? 0.12 : 0;
    const selectedBonus = pkt.selectedForNextRound ? 0.1 : 0;
    const rawImportance = Math.min(
      1.0,
      Math.max(0.15, adoption * 0.65 + evidenceBonus + upwardBonus + selectedBonus),
    );
    const importance = Math.round(rawImportance * 1000) / 1000;
    const efficiency =
      Math.round(
        Math.min(1.0, Math.max(0.15, importance / Math.max(0.5, pkt.tokenCount / 150))) * 1000,
      ) / 1000;

    const bucket = byRole.get(pkt.fromRoleKey) ?? { scores: [], efficiencies: [], adopted: false };
    bucket.scores.push(importance);
    bucket.efficiencies.push(efficiency);
    if (adoption >= 0.25 || pkt.selectedForNextRound) bucket.adopted = true;
    byRole.set(pkt.fromRoleKey, bucket);

    for (const targetRole of pkt.replyToRoleKeys) {
      const edgeKey = `${pkt.fromRoleKey}=>${targetRole}`;
      edgeAccumulator.set(edgeKey, Math.max(edgeAccumulator.get(edgeKey) ?? 0, importance));
    }

    return { ...pkt, importanceContribution: importance };
  });

  const roleDeltas: RoleBackpropDelta[] = [];
  for (const [roleKey, bucket] of byRole.entries()) {
    const avgImp = bucket.scores.reduce((s, v) => s + v, 0) / Math.max(1, bucket.scores.length);
    const avgEff =
      bucket.efficiencies.reduce((s, v) => s + v, 0) / Math.max(1, bucket.efficiencies.length);
    roleDeltas.push({
      roleKey,
      importanceScore: Math.round(avgImp * 1000) / 1000,
      tokenEfficiency: Math.round(avgEff * 1000) / 1000,
      adopted: bucket.adopted,
    });
  }

  const synapseEdges = [...edgeAccumulator.entries()].map(([k, weight]) => {
    const [fromRoleKey, toRoleKey] = k.split("=>");
    return { fromRoleKey: fromRoleKey!, toRoleKey: toRoleKey!, weight };
  });

  return { updatedPackets, roleDeltas, synapseEdges };
}

/**
 * 계층형 자율 운영실 미션 완료 후 DAG 단계별 기여도·토큰 효율을 역산한다.
 */
export function backpropagateMissionImportance(input: {
  readonly dagSteps: ReadonlyArray<MissionDagStep>;
  readonly succeeded: boolean;
}): ReadonlyArray<RoleBackpropDelta> {
  const deltas: RoleBackpropDelta[] = [];
  for (const step of input.dagSteps) {
    if (step.status === "PENDING" || step.status === "SKIPPED") continue;
    const stepOk = step.status === "COMPLETED";
    const importance = stepOk ? (input.succeeded ? 0.85 : 0.65) : 0.2;
    const tokenEfficiency =
      step.tokensUsed > 0
        ? Math.round(Math.min(1.0, Math.max(0.15, 2_500 / Math.max(500, step.tokensUsed))) * 1000) /
          1000
        : 0.7;
    deltas.push({
      roleKey: step.roleKey,
      importanceScore: importance,
      tokenEfficiency,
      adopted: stepOk,
    });
  }
  return deltas;
}
