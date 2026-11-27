import {
  isProviderAvailable,
  type MissionCrewRole,
  type MissionModelTier,
  type MissionRoleModelOverride,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_ROLE_ALLOWED_TOOLS } from "./MissionPromptCacheAssembler.ts";

/**
 * 제로 하드코딩 유동 모델 라우터.
 *
 * - 특정 벤더/모델을 코드에 고정하지 않는다.
 * - 현재 등록되어 있고 건강한(`enabled && installed && status !== 'error' && auth !== 'unauthenticated'`)
 *   모든 프로바이더 계정과 모델 중에서 사용자가 크루 카드나 실행 시점에 자유롭게 변경할 수 있다.
 * - 이종 검수(reviewer) 단계에서는 가능한 한 코더와 다른 프로바이더/계정을 자동 우선 선택한다.
 */

export interface HealthyProviderModel {
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly modelSlug: string;
  readonly tierGuess: MissionModelTier;
}

const NON_CODING_MEDIA_MODEL_PATTERN =
  /(?:^|[/:_-])(?:wan[-_]?v?\d|seedance|seedream|hailuo|minimax[-_]?video|cogvideo|hunyuan[-_]?video|vidu|pixverse|recraft|ideogram|nano[-_]?banana|video|sora|kling|veo|runway|pika|luma|imagen|flux|dall-?e|midjourney|sdxl|stable-?diffusion|whisper|tts|audio|speech|transcribe|embed(?:ding)?|rerank(?:er)?|moderation|vision-only)(?:$|[/:_-])/i;

/**
 * Returns false for video/image/audio/embedding/rerank models (e.g. `alibaba/wan-v3.0-video-prime`)
 * so coding/planning/review crews are never auto-assigned media generators.
 */
export function isMissionCodingCapableModel(slug: string, name?: string): boolean {
  const combined = `${slug} ${name ?? ""}`;
  return !NON_CODING_MEDIA_MODEL_PATTERN.test(combined);
}

export function isServerProviderHealthy(
  provider: ServerProvider | undefined,
  rateLimitedIds?: ReadonlySet<string>,
): provider is ServerProvider {
  if (!provider) return false;
  if (!isProviderAvailable(provider) || !provider.enabled) return false;
  if (!provider.installed || provider.status === "error") return false;
  if (provider.auth.status === "unauthenticated") return false;
  if (rateLimitedIds?.has(provider.instanceId)) return false;
  const primaryPct = provider.usage?.primary?.usedPercent;
  const secondaryPct = provider.usage?.secondary?.usedPercent;
  if (
    (primaryPct !== undefined && primaryPct >= 99) ||
    (secondaryPct !== undefined && secondaryPct >= 99)
  ) {
    return false;
  }
  return provider.models.some((m) => isMissionCodingCapableModel(m.slug, m.name));
}

export function pickDefaultModelSlug(provider: ServerProvider): string {
  const codingModels = provider.models.filter((m) => isMissionCodingCapableModel(m.slug, m.name));
  const pool = codingModels.length > 0 ? codingModels : provider.models;
  const preferred = pool.find((m) => !m.isLegacy && m.isDefault);
  if (preferred) return preferred.slug;
  const nonLegacy = pool.find((m) => !m.isLegacy);
  return nonLegacy?.slug ?? pool[0]?.slug ?? "default";
}

function guessTierForModel(modelSlug: string, driver: string): MissionModelTier {
  const lower = `${driver}:${modelSlug}`.toLowerCase();
  if (
    lower.includes("personal-orchestrator") ||
    lower.includes("4b") ||
    lower.includes("mini") ||
    lower.includes("flash") ||
    lower.includes("haiku") ||
    lower.includes("fast") ||
    lower.includes("nano")
  ) {
    return "TIER_B";
  }
  if (
    lower.includes("opus") ||
    lower.includes("o3") ||
    lower.includes("orchestrator-neon") ||
    lower.includes("pro") ||
    lower.includes("5.4") ||
    lower.includes("grok-4") ||
    lower.includes("reasoning")
  ) {
    return "TIER_S";
  }
  return "TIER_A";
}

export function listHealthyProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  rateLimitedIds?: ReadonlySet<string>,
): ReadonlyArray<HealthyProviderModel> {
  const items: HealthyProviderModel[] = [];
  for (const p of providers) {
    if (!isServerProviderHealthy(p, rateLimitedIds)) continue;
    const defaultSlug = pickDefaultModelSlug(p);
    items.push({
      providerInstanceId: p.instanceId,
      driver: p.driver,
      displayName: p.displayName ?? p.instanceId,
      modelSlug: defaultSlug,
      tierGuess: guessTierForModel(defaultSlug, p.driver),
    });
  }
  return items;
}

export interface DefaultCrewSeedInput {
  readonly projectId: ProjectId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
}

/**
 * 프로젝트에 등록된 크루가 0개일 때만 최초 1회 실행되는 4인 기본 크루 시드 빌더.
 * 이후 사용자는 대시보드 UI에서 어떤 크루의 계정·모델·폴백·티어든 즉시 유동 변경할 수 있다.
 */
export function buildDefaultCrewRoles(input: DefaultCrewSeedInput): ReadonlyArray<MissionCrewRole> {
  const healthy = listHealthyProviderModels(input.providers);
  const fallbackPool =
    healthy.length > 0
      ? healthy
      : input.providers
          .filter((p) => p.models.length > 0)
          .map((p) => ({
            providerInstanceId: p.instanceId,
            driver: p.driver,
            displayName: p.displayName ?? p.instanceId,
            modelSlug: pickDefaultModelSlug(p),
            tierGuess: guessTierForModel(pickDefaultModelSlug(p), p.driver),
          }));

  const pickByTier = (
    preferredTier: MissionModelTier,
    excludeInstanceIds: ReadonlySet<string> = new Set(),
  ): { readonly providerInstanceId: string; readonly modelSlug: string } => {
    const nonExcluded = fallbackPool.filter((c) => !excludeInstanceIds.has(c.providerInstanceId));
    const pool = nonExcluded.length > 0 ? nonExcluded : fallbackPool;
    const exact = pool.find((c) => c.tierGuess === preferredTier);
    const chosen = exact ?? pool[0];
    if (chosen) {
      return {
        providerInstanceId: chosen.providerInstanceId,
        modelSlug: chosen.modelSlug,
      };
    }
    return { providerInstanceId: "codex", modelSlug: "default" };
  };

  const plannerTarget = pickByTier("TIER_S");
  const coderTarget = pickByTier("TIER_A", new Set([plannerTarget.providerInstanceId]));
  // 리뷰어는 가급적 코더·기획자 모두와 다른 이종 프로바이더/계정을 기본 배정 (2개뿐이면 코더만 제외)
  const reviewerDistinctBoth = fallbackPool.filter(
    (c) =>
      c.providerInstanceId !== coderTarget.providerInstanceId &&
      c.providerInstanceId !== plannerTarget.providerInstanceId,
  );
  const reviewerTarget =
    reviewerDistinctBoth.length > 0
      ? pickByTier(
          "TIER_S",
          new Set([coderTarget.providerInstanceId, plannerTarget.providerInstanceId]),
        )
      : pickByTier("TIER_S", new Set([coderTarget.providerInstanceId]));
  const digestTarget = pickByTier("TIER_B");
  const secondaryFallback = fallbackPool.find(
    (c) => c.providerInstanceId !== coderTarget.providerInstanceId,
  );

  const specs: ReadonlyArray<{
    readonly roleKey: string;
    readonly displayName: string;
    readonly description: string;
    readonly target: { readonly providerInstanceId: string; readonly modelSlug: string };
    readonly modelTier: MissionModelTier;
    readonly orgTier: "L0_COMMANDER" | "L1_LEAD" | "L2_SPECIALIST" | "L3_SUPPORT";
    readonly reportsToRoleKey: string | null;
    readonly specialtyTags: ReadonlyArray<string>;
    readonly canModerate: boolean;
    readonly systemDirective: string;
  }> = [
    {
      roleKey: "planner",
      displayName: "기획실 (설계·지휘 리드)",
      description: "목표를 완료 조건과 최소 작업 단계(DAG)로 분해하고 하위 실무 부서를 지휘합니다.",
      target: plannerTarget,
      modelTier: "TIER_S",
      orgTier: "L1_LEAD",
      reportsToRoleKey: null,
      specialtyTags: ["architecture", "planning", "command", "quant"],
      canModerate: true,
      systemDirective:
        "목표를 최소 변경 단위로 분해하고, 완료 판정 조건과 수정 대상 파일 목록을 3줄 요약으로 정리하라.",
    },
    {
      roleKey: "coder",
      displayName: "개발실 (구현·수정)",
      description: "격리된 Git Worktree에서 실제 코드를 구현하고 단위 테스트를 통과시킵니다.",
      target: coderTarget,
      modelTier: "TIER_A",
      orgTier: "L2_SPECIALIST",
      reportsToRoleKey: "planner",
      specialtyTags: ["coding", "implementation", "testing", "quant"],
      canModerate: false,
      systemDirective:
        "요청된 범위의 코드만 정확히 구현하고 빌드·테스트 결과를 압축 포인터로 보고하라.",
    },
    {
      roleKey: "reviewer",
      displayName: "감사·검수실 (이종 교차검증)",
      description:
        "코더와 분리된 독립 관점에서 회귀·보안·리스크·완료 조건 충족을 감사하고 판정합니다.",
      target: reviewerTarget,
      modelTier: "TIER_S",
      orgTier: "L1_LEAD",
      reportsToRoleKey: null,
      specialtyTags: ["review", "security", "verification", "risk"],
      canModerate: true,
      systemDirective:
        "구현자의 설명을 맹신하지 말고 실제 변경 파일과 검증 결과를 기준으로 승인(ok) 또는 수정 지시(fix_required)를 판정하라.",
    },
    {
      roleKey: "digest",
      displayName: "비서실 (압축·브리핑)",
      description: "미션 완료 3줄 요약과 일일 경영 보고서를 저비용 고속 모델로 작성합니다.",
      target: digestTarget,
      modelTier: "TIER_B",
      orgTier: "L3_SUPPORT",
      reportsToRoleKey: "planner",
      specialtyTags: ["summary", "briefing", "documentation"],
      canModerate: false,
      systemDirective:
        "완료된 작업의 핵심 성과, 변경 파일, 비용 및 주의사항을 3줄 이내 한국어 브리핑으로 압축하라.",
    },
  ];

  return specs.map((spec) => ({
    id: `crew_${input.projectId}_${spec.roleKey}`,
    projectId: input.projectId,
    roleKey: spec.roleKey,
    displayName: spec.displayName,
    description: spec.description,
    providerInstanceId: spec.target.providerInstanceId,
    modelSlug: spec.target.modelSlug,
    modelTier: spec.modelTier,
    orgTier: spec.orgTier,
    reportsToRoleKey: spec.reportsToRoleKey,
    specialtyTags: [...spec.specialtyTags],
    canModerate: spec.canModerate,
    importanceScore: 0.5,
    fallbackInstanceId: secondaryFallback?.providerInstanceId ?? null,
    fallbackModelSlug: secondaryFallback?.modelSlug ?? null,
    systemDirective: spec.systemDirective,
    allowedTools: [...(DEFAULT_ROLE_ALLOWED_TOOLS[spec.roleKey] ?? ["read_file"])],
    currentStatus: "IDLE",
    activeMissionId: null,
    activeTaskId: null,
    contextPercent: 0,
    turnCount: 0,
    maxTurns: 12,
    lastHeartbeatAtMs: null,
    enabled: true,
    updatedAtMs: input.nowMs,
  }));
}

export interface ResolvedCrewTarget {
  readonly providerInstanceId: string;
  readonly modelSlug: string;
  readonly displayName: string;
  readonly substituted: boolean;
  readonly substitutionReason: string | null;
  readonly crossModelDistinct: boolean;
}

/**
 * 실행 시점에 크루의 실제 대상 프로바이더·모델을 유동 결정한다.
 * 우선순위: (1) 미션 즉석 override → (2) 크루 카드 사용자 설정 → (3) 크루 폴백 → (4) 건강한 활성 대안.
 */
export function resolveCrewExecutionTarget(input: {
  readonly role: MissionCrewRole;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly roleModelOverrides?: ReadonlyArray<MissionRoleModelOverride>;
  readonly excludeProviderIds?: ReadonlySet<string>;
  readonly rateLimitedIds?: ReadonlySet<string>;
}): ResolvedCrewTarget {
  const providerMap = new Map<string, ServerProvider>(
    input.providers.map((p) => [p.instanceId, p]),
  );
  const excluded = input.excludeProviderIds ?? new Set<string>();

  const formatDisplay = (instanceId: string, modelSlug: string) => {
    const p = providerMap.get(instanceId);
    return p?.displayName ? `${p.displayName} · ${modelSlug}` : `${instanceId} · ${modelSlug}`;
  };

  // 1. 실행 시점 즉석 오버라이드 최우선
  const override = input.roleModelOverrides?.find((o) => o.roleKey === input.role.roleKey);
  if (override) {
    return {
      providerInstanceId: override.providerInstanceId,
      modelSlug: override.modelSlug,
      displayName: formatDisplay(override.providerInstanceId, override.modelSlug),
      substituted: false,
      substitutionReason: null,
      crossModelDistinct: !excluded.has(override.providerInstanceId),
    };
  }

  // 2. 사용자가 크루 카드에 지정한 주 프로바이더/모델
  const primaryProvider = providerMap.get(input.role.providerInstanceId);
  const primaryHealthy =
    input.providers.length === 0 || isServerProviderHealthy(primaryProvider, input.rateLimitedIds);
  const primaryExcluded = excluded.has(input.role.providerInstanceId);

  if (primaryHealthy && !primaryExcluded) {
    return {
      providerInstanceId: input.role.providerInstanceId,
      modelSlug: input.role.modelSlug,
      displayName: formatDisplay(input.role.providerInstanceId, input.role.modelSlug),
      substituted: false,
      substitutionReason: null,
      crossModelDistinct: true,
    };
  }

  // 3. 크루에 지정된 폴백 모델
  if (input.role.fallbackInstanceId && input.role.fallbackModelSlug) {
    const fbProvider = providerMap.get(input.role.fallbackInstanceId);
    const fbHealthy =
      input.providers.length === 0 || isServerProviderHealthy(fbProvider, input.rateLimitedIds);
    if (fbHealthy && !excluded.has(input.role.fallbackInstanceId)) {
      return {
        providerInstanceId: input.role.fallbackInstanceId,
        modelSlug: input.role.fallbackModelSlug,
        displayName: formatDisplay(input.role.fallbackInstanceId, input.role.fallbackModelSlug),
        substituted: true,
        substitutionReason: primaryExcluded
          ? "이종 교차 검수를 위해 폴백 프로바이더로 자동 전환"
          : "주 프로바이더 비가용으로 폴백 모델 자동 전환",
        crossModelDistinct: true,
      };
    }
  }

  // 4. 활성 프로바이더 중 건강한 이종 대안 탐색
  const healthyList = listHealthyProviderModels(input.providers, input.rateLimitedIds);
  const distinctCandidate = healthyList.find((c) => !excluded.has(c.providerInstanceId));
  if (distinctCandidate) {
    return {
      providerInstanceId: distinctCandidate.providerInstanceId,
      modelSlug: distinctCandidate.modelSlug,
      displayName: `${distinctCandidate.displayName} · ${distinctCandidate.modelSlug}`,
      substituted: true,
      substitutionReason: primaryExcluded
        ? "이종 교차 검수 보장을 위해 다른 활성 프로바이더 자동 선택"
        : "주 프로바이더 비가용으로 활성 대안 프로바이더 자동 선택",
      crossModelDistinct: true,
    };
  }

  // 5. 단일 프로바이더 환경에서는 주 설정 그대로 사용 (교차 불가 명시)
  return {
    providerInstanceId: input.role.providerInstanceId,
    modelSlug: input.role.modelSlug,
    displayName: formatDisplay(input.role.providerInstanceId, input.role.modelSlug),
    substituted: false,
    substitutionReason: primaryExcluded
      ? "등록된 활성 프로바이더가 1개뿐이어서 동일 프로바이더로 검수 진행"
      : null,
    crossModelDistinct: !primaryExcluded,
  };
}
