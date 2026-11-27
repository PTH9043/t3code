import type {
  MissionCrewRole,
  MissionOrgTier,
  MissionSynapseWeightRecord,
} from "@t3tools/contracts";

/**
 * Layer 0: 자율 운영실 & 합석 회의실 희소 활성화 트리아지 라우터 (RouteLLM / ZOOTER 원리).
 *
 * - 0-LLM 결정론적 분류 + DyLAN 누적 시냅스 가중치로 안건 도메인과 난이도를 판별한다.
 * - 단순 과업은 Fast-Path(1크루)로 직결하고, 복합 안건·회의는 연관된 2~4개 역할군만
 *   희소 활성화(Sparse Firing)하여 무관한 팀의 토큰 소모를 0으로 차단한다.
 */

export type MissionDomainTag =
  | "coding"
  | "quant_data"
  | "architecture"
  | "security_review"
  | "documentation"
  | "general";

const DOMAIN_RULES: ReadonlyArray<{
  readonly tag: MissionDomainTag;
  readonly pattern: RegExp;
  readonly preferredSpecialties: ReadonlyArray<string>;
}> = [
  {
    tag: "quant_data",
    pattern:
      /(?:백테스팅|백테스트|코인|트레이딩|수익률|승률|지표|데이터|통계|시계열|전략|포트폴리오|수리|확률|backtest|quant|sharpe|strategy|dataset)/i,
    preferredSpecialties: ["quant", "data", "research", "coding", "review", "risk", "testing"],
  },
  {
    tag: "security_review",
    pattern:
      /(?:보안|취약점|감사|검수|회귀|권한|인증|인젝션|leak|security|audit|vulnerability|xss|sql\s*injection|review)/i,
    preferredSpecialties: ["security", "review", "verification", "risk", "architecture"],
  },
  {
    tag: "architecture",
    pattern:
      /(?:아키텍처|설계|통합|개편|마이그레이션|리팩토링|리팩터링|그래프|신경망|오케스트|구조|architecture|refactor|migration|schema|design)/i,
    preferredSpecialties: ["architecture", "planning", "command", "coding", "review"],
  },
  {
    tag: "documentation",
    pattern:
      /(?:문서|요약|브리핑|보고서|계획표|가이드|번역|readme|changelog|report|summary|briefing|docs)/i,
    preferredSpecialties: ["summary", "briefing", "documentation", "research", "planning"],
  },
  {
    tag: "coding",
    pattern:
      /(?:버그|오류|수정|구현|테스트|빌드|컴파일|타입|컴포넌트|api|ui|css|fix|bug|implement|test|build|tsgo|vitest)/i,
    preferredSpecialties: ["coding", "implementation", "testing", "review", "planning"],
  },
];

export function classifyMissionDomainTag(text: string): MissionDomainTag {
  for (const rule of DOMAIN_RULES) {
    if (rule.pattern.test(text)) return rule.tag;
  }
  return "general";
}

export function orgTierRank(tier: MissionOrgTier | undefined): number {
  switch (tier) {
    case "L0_COMMANDER":
      return 0;
    case "L1_LEAD":
      return 1;
    case "L2_SPECIALIST":
      return 2;
    case "L3_SUPPORT":
      return 3;
    default:
      return 2;
  }
}

export function isFastPathGoal(goalPrompt: string, doneCriteriaCount: number): boolean {
  const trimmed = goalPrompt.trim();
  if (doneCriteriaCount >= 3 || trimmed.length > 180) return false;
  return /(?:오타|문구|한\s*줄|단순\s*수정|요약만|주석|번역|typo|rename|one-line)/i.test(trimmed);
}

export interface SparseCrewSelectionResult {
  readonly domainTag: MissionDomainTag;
  readonly fastPath: boolean;
  readonly moderatorRoleKey: string;
  readonly selectedRoleKeys: ReadonlyArray<string>;
  readonly prunedRoleKeys: ReadonlyArray<string>;
  readonly rationale: string;
}

/**
 * 안건에 맞춰 감독자 1명 + 연관 참가자(희소 활성화)를 선별하고,
 * 비관련 역할군과 DyLAN Pruned 역할군을 제외(토큰 0 소모)한다.
 */
export function selectSparseCrewForTopic(input: {
  readonly topic: string;
  readonly roles: ReadonlyArray<MissionCrewRole>;
  readonly synapseWeights?: ReadonlyArray<MissionSynapseWeightRecord> | undefined;
  readonly requestedModeratorRoleKey?: string | undefined;
  readonly requestedParticipantRoleKeys?: ReadonlyArray<string> | undefined;
  readonly maxParticipants?: number | undefined;
  readonly autoSparseSelect?: boolean | undefined;
}): SparseCrewSelectionResult {
  const enabledRoles = input.roles.filter((r) => r.enabled);
  const domainTag = classifyMissionDomainTag(input.topic);
  const domainSpec = DOMAIN_RULES.find((r) => r.tag === domainTag);
  const preferredSpecs = new Set(
    domainSpec?.preferredSpecialties ?? ["planning", "coding", "review"],
  );

  const weightByRole = new Map<string, MissionSynapseWeightRecord>();
  for (const w of input.synapseWeights ?? []) {
    if (w.domainTag === domainTag || w.domainTag === "general") {
      const existing = weightByRole.get(w.roleKey);
      if (!existing || (w.domainTag === domainTag && existing.domainTag !== domainTag)) {
        weightByRole.set(w.roleKey, w);
      }
    }
  }

  // 1. 감독자(Moderator) 결정: 사용자 명시 > canModerate=true 중 L0/L1 최상위 > planner > 첫 활성 크루
  const explicitMod = input.requestedModeratorRoleKey
    ? enabledRoles.find((r) => r.roleKey === input.requestedModeratorRoleKey)
    : undefined;
  const moderator =
    explicitMod ??
    [...enabledRoles]
      .filter((r) => r.canModerate || r.orgTier === "L0_COMMANDER" || r.orgTier === "L1_LEAD")
      .sort(
        (a, b) =>
          orgTierRank(a.orgTier) - orgTierRank(b.orgTier) ||
          (b.importanceScore ?? 0.5) - (a.importanceScore ?? 0.5),
      )[0] ??
    enabledRoles.find((r) => r.roleKey === "planner") ??
    enabledRoles[0];

  const moderatorRoleKey = moderator?.roleKey ?? "planner";

  // 2. 사용자가 참가자를 명시한 경우(autoSparseSelect !== true) 그대로 존중
  const nonModeratorRoles = enabledRoles.filter((r) => r.roleKey !== moderatorRoleKey);
  if (
    input.requestedParticipantRoleKeys &&
    input.requestedParticipantRoleKeys.length > 0 &&
    input.autoSparseSelect !== true
  ) {
    const reqSet = new Set(
      input.requestedParticipantRoleKeys.filter((k) => k !== moderatorRoleKey),
    );
    const selected = nonModeratorRoles.filter((r) => reqSet.has(r.roleKey)).map((r) => r.roleKey);
    const pruned = nonModeratorRoles.filter((r) => !reqSet.has(r.roleKey)).map((r) => r.roleKey);
    return {
      domainTag,
      fastPath: false,
      moderatorRoleKey,
      selectedRoleKeys:
        selected.length > 0 ? selected : nonModeratorRoles.slice(0, 3).map((r) => r.roleKey),
      prunedRoleKeys: pruned,
      rationale: `사용자 지정 참가자 ${selected.length}명 + 감독자(${moderator?.displayName ?? moderatorRoleKey})`,
    };
  }

  // 3. Layer 0 희소 활성화 (SMoA / DyLAN): 전문 태그 일치 + DyLAN 기여도 점수로 상위 2~4명만 활성화
  const maxParticipants = Math.max(2, Math.min(5, input.maxParticipants ?? 3));
  const scored = nonModeratorRoles.map((role) => {
    const w = weightByRole.get(role.roleKey);
    const isPrunedByDylan = w?.pruned === true && (w.sampleCount ?? 0) >= 5;
    const tags = (role.specialtyTags ?? []).map((t) => t.toLowerCase());
    let specHits = 0;
    for (const tag of tags) {
      if (preferredSpecs.has(tag)) specHits += 1;
    }
    const baseRelevance =
      specHits > 0 ? 0.5 + Math.min(0.4, specHits * 0.15) : role.roleKey === "digest" ? 0.15 : 0.35;
    const dylanScore = w?.importanceEma ?? role.importanceScore ?? 0.5;
    const score = isPrunedByDylan ? -1 : baseRelevance * 0.6 + dylanScore * 0.4;
    return { role, score, isPrunedByDylan };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: string[] = [];
  const pruned: string[] = [];
  for (const entry of scored) {
    if (entry.isPrunedByDylan) {
      pruned.push(entry.role.roleKey);
      continue;
    }
    if (selected.length < maxParticipants) {
      selected.push(entry.role.roleKey);
    } else {
      pruned.push(entry.role.roleKey);
    }
  }

  // 최소 1명 이상의 동등 참가자 보장 (전부 pruned였을 때 안전 복구)
  if (selected.length === 0 && nonModeratorRoles.length > 0) {
    selected.push(nonModeratorRoles[0]!.roleKey);
  }

  const fastPath = isFastPathGoal(input.topic, 0);
  return {
    domainTag,
    fastPath,
    moderatorRoleKey,
    selectedRoleKeys: selected,
    prunedRoleKeys: pruned,
    rationale: `Layer 0 희소 게이트(${domainTag}): ${selected.length}명 활성화 · ${pruned.length}명 비활성(토큰 0)`,
  };
}
