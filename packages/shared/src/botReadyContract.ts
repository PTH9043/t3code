import type { GlobalAssistantConfig } from "@t3tools/contracts/settings";

export type AutonomyTier = "L0 Observe" | "L1 Draft" | "L2 Approved Action" | "L3 Scheduled";

export interface BotReadyDimensionScore {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly earned: number;
  readonly passed: boolean;
  readonly recommendation?: string;
}

export interface BotReadyScoreReport {
  readonly totalScore: number;
  readonly maxScore: 100;
  readonly ready: boolean;
  readonly recommendedAutonomy: AutonomyTier;
  readonly dimensions: ReadonlyArray<BotReadyDimensionScore>;
}

const RAW_SECRET_PATTERN =
  /\b(?:sk-(?:or-v1-|proj-|ant-)?[A-Za-z0-9_-]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9_-]{16,})\b/;

/**
 * 12-dimension Bot Ready 100-point contract scorer (adapted from grok-bot-templates):
 * Evaluates whether a GlobalAssistantConfig has concrete operational contracts
 * instead of vague vibe prompts.
 */
export function scoreGlobalAssistantBotReady(config: GlobalAssistantConfig): BotReadyScoreReport {
  const allText = [
    config.personaName,
    config.voiceAndTone,
    config.lengthPolicy,
    config.explanationPolicy,
    config.extraInstructions,
    ...config.corePrinciples,
    ...config.outputSections.map((s) => `${s.heading} ${s.constraint}`),
    ...config.domainPlaybooks.map((p) => `${p.title} ${p.rules}`),
  ].join("\n");

  const hasNeverList =
    config.corePrinciples.some((p) => /금지|하지\s*않|차단|절대|never/i.test(p)) ||
    /금지|피할|하지\s*마/i.test(config.voiceAndTone + config.extraInstructions);

  const hasNoDataRule = /미확인|추측|불가|없으면|부족|unavailable|no-data/i.test(allText);
  const hasWorkingStyleSeparation = /사실|추정|검증|승인\s*대기|확인\s*완료/i.test(allText);
  const hasShareSafe = !RAW_SECRET_PATTERN.test(allText);
  const hasApprovalBoundary = /승인|허가|확인\s*후|approval/i.test(allText);

  const checks: Array<
    Omit<BotReadyDimensionScore, "earned" | "passed"> & { readonly ok: boolean }
  > = [
    {
      id: "job",
      label: "1. 단일 핵심 직무(Job)",
      weight: 10,
      ok: config.personaName.trim().length >= 2 && config.voiceAndTone.trim().length >= 15,
      recommendation: "역할 이름과 핵심 직무 설명을 명확히 작성하세요.",
    },
    {
      id: "sources",
      label: "2. 허용 출처·전문 본부(Sources)",
      weight: 8,
      ok: config.domainPlaybooks.length > 0 || config.extraInstructions.trim().length >= 40,
      recommendation: "도메인 전문 본부 또는 허용 참조 기준을 1개 이상 등록하세요.",
    },
    {
      id: "never_list",
      label: "3. 절대 금지 목록(Never-list)",
      weight: 10,
      ok: hasNeverList,
      recommendation: "절대 금지 행동(관료체, 무단 배포, 추측 보고 등)을 원칙에 명시하세요.",
    },
    {
      id: "deliverable",
      label: "4. 정형 산출물 계약(Deliverable)",
      weight: 10,
      ok: config.outputSections.some((s) => s.required),
      recommendation: "필수 출력 헤더/섹션 규칙을 1개 이상 지정하세요.",
    },
    {
      id: "first_task",
      label: "5. 길이·밀도 기준(Bounded Output)",
      weight: 6,
      ok: config.lengthPolicy.trim().length >= 5 && config.explanationPolicy.trim().length >= 5,
      recommendation: "답변 길이 정책과 설명 방식을 모두 입력하세요.",
    },
    {
      id: "skill",
      label: "6. 재사용 전문 규칙(Playbooks)",
      weight: 8,
      ok: config.domainPlaybooks.some((p) => p.rules.trim().length >= 15),
      recommendation: "키워드 매칭 전문 본부 규칙을 구체화하세요.",
    },
    {
      id: "no_data",
      label: "7. 결측 데이터 무추측(No-data)",
      weight: 10,
      ok: hasNoDataRule,
      recommendation: "근거·데이터가 없을 때 추측 대신 미확인으로 보고하는 규칙을 넣으세요.",
    },
    {
      id: "autonomy",
      label: "8. 승인 경계·자율성(Autonomy)",
      weight: 8,
      ok: hasApprovalBoundary,
      recommendation: "외부 변경·삭제·배포 전 인간 승인 경계를 원칙에 명시하세요.",
    },
    {
      id: "example",
      label: "9. 입출력 Few-Shot 예시(Example)",
      weight: 10,
      ok: config.styleExamples.some((ex) => ex.goodExample.trim().length >= 15),
      recommendation: "모범/피할 말투 Few-Shot 예시를 1개 이상 등록하세요.",
    },
    {
      id: "routine_discipline",
      label: "10. 턴 앵커·검증 강제(Discipline)",
      weight: 6,
      ok: config.enforcement.injectRecencyReminder && config.enforcement.verifyOutputContract,
      recommendation: "턴 말미 앵커 주입과 출력 계약 검증 옵션을 켜세요.",
    },
    {
      id: "share_safe",
      label: "11. 시크릿 미포함(Share-safe)",
      weight: 6,
      ok: hasShareSafe,
      recommendation: "프롬프트 본문에 생 API 키나 토큰 문자열을 넣지 마세요.",
    },
    {
      id: "working_style",
      label: "12. 사실·추정·승인 분리(Working Style)",
      weight: 8,
      ok: hasWorkingStyleSeparation,
      recommendation: "확인된 사실·추정·미확인/승인 대기 구분 원칙을 추가하세요.",
    },
  ];

  const dimensions: BotReadyDimensionScore[] = checks.map((c) => ({
    id: c.id,
    label: c.label,
    weight: c.weight,
    earned: c.ok ? c.weight : 0,
    passed: c.ok,
    ...(c.ok ? {} : { recommendation: c.recommendation }),
  }));

  const totalScore = dimensions.reduce((sum, d) => sum + d.earned, 0);
  const recommendedAutonomy: AutonomyTier =
    totalScore >= 90 && hasApprovalBoundary && hasNoDataRule
      ? "L2 Approved Action"
      : totalScore >= 70
        ? "L1 Draft"
        : "L0 Observe";

  return {
    totalScore,
    maxScore: 100,
    ready: totalScore >= 80 && hasShareSafe,
    recommendedAutonomy,
    dimensions,
  };
}

export interface AgentOrgChartRole {
  readonly id: string;
  readonly kind: "orchestrator" | "specialist" | "optional_peer";
  readonly in_scope: ReadonlyArray<string>;
  readonly out_of_scope: ReadonlyArray<string>;
}

export interface AgentOrgChartHandoff {
  readonly from_role_id: string;
  readonly to_role_id: string;
  readonly when: string;
}

export interface ParsedAgentOrgChart {
  readonly chartId: string;
  readonly roles: ReadonlyArray<AgentOrgChartRole>;
  readonly handoffs: ReadonlyArray<AgentOrgChartHandoff>;
  readonly doNotFanoutUntilFirstGoal: boolean;
  readonly secretsPolicy: "vault_only";
}

/**
 * Validates and imports an `agent-org-chart` `chart.json` specification while
 * enforcing `do_not_fanout_until_first_goal: true` and `secrets: "vault_only"`.
 */
export function parseAgentOrgChartJson(
  rawJson: string,
):
  | { readonly ok: true; readonly chart: ParsedAgentOrgChart }
  | { readonly ok: false; readonly error: string } {
  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch {
    return { ok: false, error: "Invalid chart.json syntax." };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "chart.json root must be an object." };
  }
  const obj = data as Record<string, unknown>;
  const chartId =
    typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : "imported-org-chart";
  if (!Array.isArray(obj.roles) || obj.roles.length === 0) {
    return { ok: false, error: "chart.json must define at least one role in `roles[]`." };
  }

  const roles: AgentOrgChartRole[] = [];
  const validKinds = new Set(["orchestrator", "specialist", "optional_peer"]);
  for (const item of obj.roles) {
    if (!item || typeof item !== "object") return { ok: false, error: "Invalid role entry." };
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id.trim())
      return { ok: false, error: "Each role requires an `id`." };
    if (typeof r.kind !== "string" || !validKinds.has(r.kind)) {
      return { ok: false, error: `Invalid role kind for '${r.id}'.` };
    }
    roles.push({
      id: r.id.trim(),
      kind: r.kind as AgentOrgChartRole["kind"],
      in_scope: Array.isArray(r.in_scope) ? r.in_scope.map(String) : [],
      out_of_scope: Array.isArray(r.out_of_scope) ? r.out_of_scope.map(String) : [],
    });
  }

  const roleIds = new Set(roles.map((r) => r.id));
  const handoffs: AgentOrgChartHandoff[] = [];
  if (Array.isArray(obj.handoffs)) {
    for (const h of obj.handoffs) {
      if (!h || typeof h !== "object") continue;
      const rec = h as Record<string, unknown>;
      const from = typeof rec.from_role_id === "string" ? rec.from_role_id.trim() : "";
      const to = typeof rec.to_role_id === "string" ? rec.to_role_id.trim() : "";
      const when = typeof rec.when === "string" ? rec.when.trim() : "";
      if (!roleIds.has(from) || !roleIds.has(to)) {
        return { ok: false, error: `Handoff references unknown role: ${from} -> ${to}` };
      }
      handoffs.push({ from_role_id: from, to_role_id: to, when });
    }
  }

  const spawn =
    obj.spawn && typeof obj.spawn === "object" ? (obj.spawn as Record<string, unknown>) : {};
  if (spawn.secrets !== undefined && spawn.secrets !== "vault_only") {
    return { ok: false, error: "Security policy requires `spawn.secrets` to be 'vault_only'." };
  }

  return {
    ok: true,
    chart: {
      chartId,
      roles,
      handoffs,
      doNotFanoutUntilFirstGoal: spawn.do_not_fanout_until_first_goal !== false,
      secretsPolicy: "vault_only",
    },
  };
}
