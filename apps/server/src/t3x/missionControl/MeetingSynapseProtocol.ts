import * as NodeCrypto from "node:crypto";
import type {
  MissionCrewRole,
  MissionMeetingStance,
  MissionMeetingStyle,
  MissionOrgTier,
  MissionSynapsePacket,
} from "@t3tools/contracts";
import { estimateTextTokens } from "./MissionPromptCacheAssembler.ts";
import { orgTierRank } from "./MissionTriageRouter.ts";

/**
 * Layer 2 & 3: 감독자 주도 동등 합석 회의실 시냅스 패킷 프로토콜 (MacNet + SMoA + DyLAN).
 *
 * 핵심 원칙:
 * 1. 주최자(감독자 / Moderator) 1명만 회의 진행·발언 조율·조기 종료·최종 종합 역할군을 가진다.
 * 2. 나머지 모든 참가자(L0 지휘관 ~ L3 지원 포함)는 회의실 안에서 직급 없이 **완전 동등**하다.
 *    하위 역할군도 상급자에게 근거를 들어 직접 반론·보완·제안을 전달할 수 있다(상향 의견 전달 허용).
 * 3. 라운드 간 전체 장문 로그를 누적하지 않고, 150토큰 이내의 JSON 시냅스 패킷(`SynapsePacket`)만
 *    Top-K 선별(SMoA Response Selection)해 전달하고, 합의 도달 시 조기 종료(Early Stopping)한다.
 */

export const PEER_EQUALITY_CHARTER = [
  "[회의 동등성 헌장 — 감독자 제외 전원 동등]",
  "- 이 합석 회의실에서는 주최자(감독자)를 제외한 모든 참가자가 조직 직급과 무관하게 완전히 동등한 발언권을 가집니다.",
  "- 조직도상 하위 역할군(개발·데이터·검수·지원 등)도 상급자·지휘관의 제안에 근거를 들어 직접 반론·수정 제안·대안을 제시할 수 있습니다.",
  "- 상급자라는 이유로 근거 없이 동조(Sycophancy)하지 말고, 자신의 전문 역할군 관점에서 가장 정확한 결론을 대화로 도출하세요.",
].join("\n");

export function formatOrgTierLabelKo(tier: MissionOrgTier | undefined): string {
  switch (tier) {
    case "L0_COMMANDER":
      return "L0 지휘관";
    case "L1_LEAD":
      return "L1 실장·리드";
    case "L2_SPECIALIST":
      return "L2 실무 전문가";
    case "L3_SUPPORT":
      return "L3 지원·요약";
    default:
      return "L2 실무 전문가";
  }
}

export function buildPeerRoundPrompt(input: {
  readonly topic: string;
  readonly roundNum: number;
  readonly maxRounds: number;
  readonly meetingStyle: MissionMeetingStyle;
  readonly moderator: MissionCrewRole;
  readonly speaker: MissionCrewRole;
  readonly allParticipants: ReadonlyArray<MissionCrewRole>;
  readonly priorSelectedPackets: ReadonlyArray<MissionSynapsePacket>;
}): string {
  const peerList = input.allParticipants
    .map(
      (p) =>
        `${p.roleKey}(${p.displayName} · 전문:${(p.specialtyTags ?? []).join("/") || p.roleKey})`,
    )
    .join(", ");

  const isBlindRound1 = input.meetingStyle === "blind_audit" && input.roundNum === 1;
  const priorSection =
    isBlindRound1 || input.priorSelectedPackets.length === 0
      ? "(1라운드 독립 발의: 다른 참가자 의견에 영향받지 말고 당신의 전문 관점에서 핵심 입장을 제시하세요.)"
      : input.priorSelectedPackets
          .map((p, idx) => {
            const speakerLabel =
              input.meetingStyle === "blind_audit"
                ? `제안자-${idx + 1}`
                : `${p.fromRoleKey}(${p.fromDisplayName})`;
            const replyNote =
              p.replyToRoleKeys.length > 0 ? ` → 대상:[${p.replyToRoleKeys.join(",")}]` : "";
            const evNote =
              p.evidence.length > 0 ? ` | 근거:${p.evidence.slice(0, 2).join(", ")}` : "";
            const riskNote = p.riskOrCounter ? ` | 반론·리스크:${p.riskOrCounter}` : "";
            return `- [R${p.roundNum} ${speakerLabel}${replyNote} · ${p.stance}] ${p.claim}${evNote}${riskNote}`;
          })
          .join("\n");

  return [
    PEER_EQUALITY_CHARTER,
    "",
    `[회의 정보] 라운드 ${input.roundNum}/${input.maxRounds} · 방식: ${input.meetingStyle === "blind_audit" ? "블라인드 교차 감사" : "자유 동등 합석 대화"}`,
    `[주최자(감독자)] ${input.moderator.displayName} (${input.moderator.roleKey}) — 진행·합의 판정·최종 종합 전담`,
    `[동등 참가자] ${peerList}`,
    `[당신의 전문 역할군] ${input.speaker.displayName} (${input.speaker.roleKey}) — ${input.speaker.description}`,
    input.speaker.systemDirective ? `[역할 지침] ${input.speaker.systemDirective}` : "",
    "",
    `[안건]\n${input.topic}`,
    "",
    `[이전 라운드 핵심 시냅스 패킷 (SMoA 압축본)]\n${priorSection}`,
    "",
    "[응답 형식 — 필수]",
    "자연스러운 한국어로 핵심 의견을 3~5줄로 말한 뒤, 반드시 마지막에 아래 JSON 시냅스 패킷(150토큰 이내)을 포함하세요.",
    "다른 참가자(상급자 포함 누구든)의 의견에 직접 응답·반론·보완할 때는 replyToRoleKeys에 대상 roleKey를 적으세요.",
    `<t3_synapse_packet>{"replyToRoleKeys":["대상roleKey"],"stance":"propose|agree|partial_disagree|counter","claim":"핵심 주장 1문장","evidence":["근거·수치 1","근거·수치 2"],"riskOrCounter":"남은 리스크 또는 반대 의견 (없으면 빈 문자열)"}</t3_synapse_packet>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildModeratorSynthesisPrompt(input: {
  readonly topic: string;
  readonly moderator: MissionCrewRole;
  readonly selectedPackets: ReadonlyArray<MissionSynapsePacket>;
  readonly earlyStopReason: string | null;
  readonly prunedRoleKeys: ReadonlyArray<string>;
}): string {
  const packetLines = input.selectedPackets
    .map((p) => {
      const upward = p.upwardFeedback ? " [하위→상급 의견]" : "";
      const ev = p.evidence.length > 0 ? ` | 근거:${p.evidence.join(", ")}` : "";
      const risk = p.riskOrCounter ? ` | 리스크/반론:${p.riskOrCounter}` : "";
      return `- [R${p.roundNum} ${p.fromDisplayName}(${p.fromRoleKey})${upward} · ${p.stance}] ${p.claim}${ev}${risk}`;
    })
    .join("\n");

  return [
    `당신은 이 합석 회의의 주최자(감독자: ${input.moderator.displayName})이자 최종 메타 통합자(MoA Aggregator)입니다.`,
    "직급과 무관하게 동등한 입장에서 도출된 참가자들의 시냅스 패킷(특히 하위 역할군의 근거 있는 반론·제안 포함)을 공정하게 종합하여 최종 결론과 실행 계획을 확정하세요.",
    "",
    `[회의 안건]\n${input.topic}`,
    input.earlyStopReason ? `[합의/종료 사유] ${input.earlyStopReason}` : "",
    input.prunedRoleKeys.length > 0
      ? `[Layer 0 희소 비활성화(토큰 0)] ${input.prunedRoleKeys.join(", ")}`
      : "",
    "",
    `[교차 검증된 핵심 시냅스 패킷 (${input.selectedPackets.length}건)]\n${packetLines}`,
    "",
    "[출력 형식]",
    "1. 핵심 합의 결론 (3줄 요약)",
    "2. 채택된 핵심 근거 및 반영된 하위/동료 반론",
    "3. 남은 리스크 및 보완 조건",
    "4. 자율 운영실 실행 인계용 최소 작업 단계(3~5단계)",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeStance(value: unknown, roundNum: number): MissionMeetingStance {
  if (
    value === "propose" ||
    value === "agree" ||
    value === "partial_disagree" ||
    value === "counter" ||
    value === "synthesize"
  ) {
    return value;
  }
  return roundNum === 1 ? "propose" : "agree";
}

export function parseSynapsePacketFromText(input: {
  readonly meetingId: string;
  readonly roundNum: number;
  readonly speaker: MissionCrewRole;
  readonly roleTierByKey: ReadonlyMap<string, MissionOrgTier>;
  readonly rawText: string;
  readonly nowMs: number;
}): MissionSynapsePacket {
  const id = `mpkt_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const speakerTier: MissionOrgTier = input.speaker.orgTier ?? "L2_SPECIALIST";
  const match = input.rawText.match(/<t3_synapse_packet>([\s\S]*?)<\/t3_synapse_packet>/i);

  let replyToRoleKeys: string[] = [];
  let stance: MissionMeetingStance = input.roundNum === 1 ? "propose" : "agree";
  let claim = "";
  let evidence: string[] = [];
  let riskOrCounter = "";

  if (match && match[1]) {
    try {
      const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
      if (Array.isArray(parsed.replyToRoleKeys)) {
        replyToRoleKeys = parsed.replyToRoleKeys
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.trim())
          .filter((x) => x !== input.speaker.roleKey)
          .slice(0, 5);
      }
      stance = normalizeStance(parsed.stance, input.roundNum);
      if (typeof parsed.claim === "string") claim = parsed.claim.trim().slice(0, 260);
      if (Array.isArray(parsed.evidence)) {
        evidence = parsed.evidence
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.trim().slice(0, 120))
          .slice(0, 4);
      }
      if (typeof parsed.riskOrCounter === "string") {
        riskOrCounter = parsed.riskOrCounter.trim().slice(0, 200);
      }
    } catch {
      // Fallback to prose compression below.
    }
  }

  if (!claim) {
    const stripped = input.rawText
      .replace(/<t3_synapse_packet>[\s\S]*?<\/t3_synapse_packet>/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    claim = stripped.slice(0, 220) || `${input.speaker.displayName} 의견 제출`;
  }

  // 하위자 -> 상급자 의견 전달 여부 자동 감지 (예: L2 실무자가 L0 지휘관/L1 실장에게 직접 응답·반론)
  const speakerRank = orgTierRank(speakerTier);
  const upwardFeedback = replyToRoleKeys.some((targetKey) => {
    const targetTier = input.roleTierByKey.get(targetKey);
    return targetTier !== undefined && orgTierRank(targetTier) < speakerRank;
  });

  const compactSerialized = `${claim} ${evidence.join(" ")} ${riskOrCounter}`;
  const tokenCount = Math.min(200, Math.max(12, estimateTextTokens(compactSerialized)));

  return {
    id,
    meetingId: input.meetingId,
    roundNum: input.roundNum,
    fromRoleKey: input.speaker.roleKey,
    fromDisplayName: input.speaker.displayName,
    fromOrgTier: speakerTier,
    replyToRoleKeys,
    upwardFeedback,
    stance,
    claim,
    evidence,
    riskOrCounter,
    selectedForNextRound: true,
    importanceContribution: 0.5,
    tokenCount,
    createdAtMs: input.nowMs,
  };
}

function tokenizeClaim(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, " ")
      .split(/\s+/u)
      .filter((t) => t.length >= 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * SMoA Response Selection & 경량 PairRM 랭킹:
 * - 유사 중복 의견(Jaccard >= 0.80)을 걸러내고,
 * - 근거 수 + 반론/리스크 제기 + 상향 의견 전달 + 다양한 관점 순으로 Top-K만 다음 라운드에 전달한다.
 */
export function selectTopSynapsePackets(
  roundPackets: ReadonlyArray<MissionSynapsePacket>,
  maxK = 4,
): {
  readonly packets: ReadonlyArray<MissionSynapsePacket>;
  readonly selected: ReadonlyArray<MissionSynapsePacket>;
  readonly estimatedSavedTokens: number;
} {
  const scored = roundPackets.map((p) => {
    const evidenceBoost = Math.min(0.45, p.evidence.length * 0.15);
    const counterBoost = p.riskOrCounter.trim().length > 0 ? 0.25 : 0;
    const upwardBoost = p.upwardFeedback ? 0.15 : 0;
    const stanceBoost = p.stance === "counter" || p.stance === "partial_disagree" ? 0.2 : 0.1;
    return {
      packet: p,
      tokens: tokenizeClaim(`${p.claim} ${p.riskOrCounter}`),
      score: evidenceBoost + counterBoost + upwardBoost + stanceBoost,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const keptIds = new Set<string>();
  const acceptedSets: Set<string>[] = [];

  for (const entry of scored) {
    if (keptIds.size >= maxK) break;
    const isDup = acceptedSets.some((prev) => jaccardSimilarity(entry.tokens, prev) >= 0.8);
    if (isDup && keptIds.size >= 1) continue;
    keptIds.add(entry.packet.id);
    acceptedSets.push(entry.tokens);
  }

  const annotated = roundPackets.map((p) => ({
    ...p,
    selectedForNextRound: keptIds.has(p.id),
  }));
  const selected = annotated.filter((p) => p.selectedForNextRound);

  // 비압축 전체 히스토리 브로드캐스트 대비 절감 토큰 추정 (원문 평균 ~450T vs 150T 시냅스 패킷 + 탈락분)
  const peerMultiplier = Math.max(1, roundPackets.length - 1);
  const fullBroadcastEst = roundPackets.length * 450 * peerMultiplier;
  const compactBroadcastEst = selected.reduce((sum, p) => sum + p.tokenCount, 0) * peerMultiplier;
  const estimatedSavedTokens = Math.max(0, fullBroadcastEst - compactBroadcastEst);

  return { packets: annotated, selected, estimatedSavedTokens };
}

/**
 * DyLAN / SMoA 비잔틴 합의 기반 조기 종료(Early Stopping) 판정.
 */
export function evaluateMeetingEarlyStop(input: {
  readonly roundPackets: ReadonlyArray<MissionSynapsePacket>;
  readonly currentRound: number;
  readonly maxRounds: number;
}): { readonly shouldStop: boolean; readonly reason: string | null } {
  if (input.currentRound >= input.maxRounds) {
    return { shouldStop: true, reason: `최대 라운드(${input.maxRounds}) 도달` };
  }
  if (input.roundPackets.length === 0) {
    return { shouldStop: true, reason: "발언 패킷 없음" };
  }
  const agreeCount = input.roundPackets.filter((p) => p.stance === "agree").length;
  const unresolvedCounters = input.roundPackets.filter(
    (p) =>
      p.stance === "counter" ||
      (p.stance === "partial_disagree" && p.riskOrCounter.trim().length > 0),
  ).length;
  const agreeRatio = agreeCount / input.roundPackets.length;

  if (agreeRatio >= 0.75 && unresolvedCounters === 0) {
    return {
      shouldStop: true,
      reason: `비잔틴 합의 조기 종료 (동의 ${Math.round(agreeRatio * 100)}%, 미해결 반론 0건 · 라운드 ${input.currentRound}/${input.maxRounds})`,
    };
  }
  return { shouldStop: false, reason: null };
}
