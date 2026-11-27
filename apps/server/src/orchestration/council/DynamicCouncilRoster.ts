import type {
  CouncilRoleArchetype,
  CouncilSeatAssignment,
  ModelTargetRef,
  ProviderDriverKind,
  ProviderInstanceId,
  SubordinateCapabilityTag,
  ThreadTeamMember,
  ThreadTeamRole,
} from "@t3tools/contracts";

/**
 * Model-Agnostic Dynamic Roster & Orthogonal Role Allocator.
 *
 * Invariant 1 (Zero Hardcoded Models):
 * - Reads whatever 0..N subordinate models the user configured in `globalSubordinateTeam`.
 * - Works identically whether N = 0, 1, 2, 3, 5, or 8+, or when homogeneous models are duplicated.
 * - Replaces unhealthy / quota-exhausted slots via live provider health snapshots without breaking the table.
 */

export interface ConfiguredSubordinateSlot {
  readonly target: ModelTargetRef;
  readonly enabled: boolean;
  readonly teamRole?: ThreadTeamRole;
  readonly explicitCapabilities?: ReadonlyArray<SubordinateCapabilityTag>;
  readonly preferredRoleOverride?: CouncilRoleArchetype;
  readonly supportsTemperature?: boolean;
}

export interface TargetHealthAssessment {
  readonly healthy: boolean;
  readonly reason?: string;
  /**
   * When true, an unhealthy slot must NOT be silently substituted with another model;
   * keep the slot with `unavailable: true` and its reason so the user/coordinator sees it.
   */
  readonly preserveSlotOnUnavailable?: boolean;
}

export interface ResolveDynamicRosterInput {
  readonly activeChatChair: ModelTargetRef;
  readonly configuredSubordinates: ReadonlyArray<ConfiguredSubordinateSlot>;
  /** Ranked fallback candidates (same-driver healthy accounts first, then other healthy models). */
  readonly fallbackCandidates: ReadonlyArray<{
    readonly target: ModelTargetRef;
    readonly supportsTemperature?: boolean;
  }>;
  readonly assessTargetHealth: (target: ModelTargetRef) => TargetHealthAssessment;
  readonly topLevelDirs: ReadonlyArray<string>;
}

const ROLE_PRIORITY_QUEUE: ReadonlyArray<CouncilRoleArchetype> = [
  "CONTRARIAN_RED",
  "SYSTEM_ARCHITECT",
  "AST_LEDGER_AUDITOR",
  "EDGE_PERF_CRITIC",
  "INTENT_CONTRACT_GUARD",
];

const TEAM_ROLE_DEFAULT_CAPABILITIES: Record<
  ThreadTeamRole,
  ReadonlyArray<SubordinateCapabilityTag>
> = {
  worker: ["code_edit"],
  planner: ["deep_reasoning", "code_edit"],
  advisor: ["deep_reasoning", "fast_critic"],
  tester: ["ast_json", "fast_critic"],
  diagnostician: ["ast_json", "deep_reasoning"],
  scout: ["fast_critic", "ast_json"],
  analyst: ["deep_reasoning", "ast_json"],
  writer: ["ko_nuance"],
  translator: ["ko_nuance"],
};

/**
 * Capability inference order:
 * 1) User-specified `explicitCapabilities`
 * 2) User-assigned `ThreadTeamRole` (9 roles from `globalSubordinateTeam`)
 * 3) Runtime driver/local hints (never hardcoding concrete vendor model ids as required branches)
 */
export function inferSeatCapabilities(
  slot: ConfiguredSubordinateSlot,
): ReadonlyArray<SubordinateCapabilityTag> {
  if (slot.explicitCapabilities && slot.explicitCapabilities.length > 0) {
    return [...new Set(slot.explicitCapabilities)];
  }
  const tags = new Set<SubordinateCapabilityTag>(
    slot.teamRole ? TEAM_ROLE_DEFAULT_CAPABILITIES[slot.teamRole] : ["code_edit"],
  );
  const descriptor =
    `${slot.target.driverId}:${slot.target.providerInstanceId}:${slot.target.modelId}`.toLowerCase();
  if (
    descriptor.includes("ollama") ||
    descriptor.includes("local") ||
    descriptor.includes("antseed")
  ) {
    tags.add("local_zero_cost");
    tags.add("ast_json");
  }
  if (descriptor.includes("flash") || descriptor.includes("mini") || descriptor.includes("haiku")) {
    tags.add("fast_critic");
  }
  if (descriptor.includes("pro") || descriptor.includes("opus") || descriptor.includes("reason")) {
    tags.add("deep_reasoning");
  }
  if (descriptor.includes("ko") || descriptor.includes("exaone")) {
    tags.add("ko_nuance");
  }
  if (tags.size === 0) tags.add("code_edit");
  return Array.from(tags);
}

/** Convert existing `globalSubordinateTeam` (`ThreadTeamMember`) into model-agnostic council slots. */
export function buildSubordinateSlotsFromTeam(input: {
  readonly members: ReadonlyArray<ThreadTeamMember>;
  readonly providerInstances: Readonly<
    Record<
      string,
      {
        readonly driver?: ProviderDriverKind;
        readonly displayName?: string;
        readonly enabled?: boolean;
      }
    >
  >;
  readonly driverSupportsTemperature?: (driverId: string) => boolean;
}): ReadonlyArray<ConfiguredSubordinateSlot> {
  return input.members.map((member) => {
    const inst = Object.hasOwn(input.providerInstances, member.instanceId)
      ? input.providerInstances[member.instanceId]
      : undefined;
    const driverId = (inst?.driver ?? member.instanceId) as ProviderDriverKind;
    const instanceEnabled = inst ? inst.enabled !== false : false;
    const slotEnabled = (member.enabled ?? true) && instanceEnabled;
    const displayName = inst?.displayName?.trim()
      ? `${inst.displayName.trim()} · ${member.model}`
      : `${member.instanceId} · ${member.model}`;
    return {
      target: {
        providerInstanceId: member.instanceId as ProviderInstanceId,
        driverId,
        modelId: member.model,
        displayName,
      },
      enabled: slotEnabled,
      teamRole: member.role,
      ...(member.capabilities ? { explicitCapabilities: member.capabilities } : {}),
      ...(member.councilRoleOverride ? { preferredRoleOverride: member.councilRoleOverride } : {}),
      ...(input.driverSupportsTemperature
        ? { supportsTemperature: input.driverSupportsTemperature(driverId) }
        : {}),
    };
  });
}

function roleAffinityScore(
  role: CouncilRoleArchetype,
  slot: ConfiguredSubordinateSlot,
  capabilities: ReadonlyArray<SubordinateCapabilityTag>,
  chair: ModelTargetRef,
): number {
  if (slot.preferredRoleOverride === role) return 100;
  const has = (tag: SubordinateCapabilityTag) => capabilities.includes(tag);
  switch (role) {
    case "CONTRARIAN_RED": {
      const diffDriver = slot.target.driverId !== chair.driverId ? 10 : 0;
      const diffModel = slot.target.modelId !== chair.modelId ? 3 : 0;
      const criticBonus = has("deep_reasoning") ? 2 : has("fast_critic") ? 1.5 : 0;
      return diffDriver + diffModel + criticBonus;
    }
    case "SYSTEM_ARCHITECT":
      return (has("code_edit") ? 5 : 0) + (has("deep_reasoning") ? 4 : 0);
    case "AST_LEDGER_AUDITOR":
      return (has("ast_json") ? 6 : 0) + (has("local_zero_cost") ? 3 : 0);
    case "EDGE_PERF_CRITIC":
      return (has("fast_critic") ? 5 : 0) + (has("ast_json") ? 2 : 0);
    case "INTENT_CONTRACT_GUARD":
      return (has("ko_nuance") ? 6 : 0) + (has("deep_reasoning") ? 2 : 0);
    case "CHAIR_ARBITER":
      return 0;
  }
}

function pickHealthyFallback(
  original: ModelTargetRef,
  fallbacks: ResolveDynamicRosterInput["fallbackCandidates"],
  assessTargetHealth: ResolveDynamicRosterInput["assessTargetHealth"],
  alreadyUsedCounts: ReadonlyMap<string, number>,
): { readonly target: ModelTargetRef; readonly supportsTemperature: boolean } | null {
  const healthyList = fallbacks.filter((cand) => assessTargetHealth(cand.target).healthy);
  if (healthyList.length === 0) return null;

  // Prefer same driver + same model (account auto-switch), then least-used healthy candidate
  const sorted = [...healthyList].sort((a, b) => {
    const aSameDriverModel =
      a.target.driverId === original.driverId && a.target.modelId === original.modelId ? 1 : 0;
    const bSameDriverModel =
      b.target.driverId === original.driverId && b.target.modelId === original.modelId ? 1 : 0;
    if (aSameDriverModel !== bSameDriverModel) return bSameDriverModel - aSameDriverModel;

    const aKey = `${a.target.providerInstanceId}:${a.target.modelId}`;
    const bKey = `${b.target.providerInstanceId}:${b.target.modelId}`;
    return (alreadyUsedCounts.get(aKey) ?? 0) - (alreadyUsedCounts.get(bKey) ?? 0);
  });

  const best = sorted[0]!;
  return {
    target: best.target,
    supportsTemperature: best.supportsTemperature === true,
  };
}

/**
 * Dynamically seats the active chat chair + 1..N variable subordinates with:
 * - Adaptive scaling for N = 0, 1, 2, 3, 5, 8+
 * - Mandatory `CONTRARIAN_RED` allocation whenever >= 1 subordinate seat exists
 * - Live health/quota fallback substitution
 * - Homogeneous Team Guard (orthogonal roles + directory sharding + temperature diversity offset)
 */
export function resolveDynamicCouncilRoster(
  input: ResolveDynamicRosterInput,
): ReadonlyArray<CouncilSeatAssignment> {
  const chairSeat: CouncilSeatAssignment = {
    seatId: "seat_chair",
    targetModel: input.activeChatChair,
    assignedRole: "CHAIR_ARBITER",
    capabilityTags: ["deep_reasoning", "code_edit"],
    temperatureOffset: 0.0,
    temperatureApplied: false,
    directoryShardHint: null,
    isFallbackSubstituted: false,
  };

  const enabledSlots = input.configuredSubordinates.filter((slot) => slot.enabled);
  const usedCounts = new Map<string, number>([
    [`${input.activeChatChair.providerInstanceId}:${input.activeChatChair.modelId}`, 1],
  ]);

  // If user disabled/emptied all subordinate slots, seat 1 fallback contrarian (or isolated chair red-team)
  const workingSlots: Array<{
    readonly slot: ConfiguredSubordinateSlot;
    readonly effectiveTarget: ModelTargetRef;
    readonly supportsTemperature: boolean;
    readonly isFallbackSubstituted: boolean;
    readonly fallbackReason?: string;
    readonly unavailable?: boolean;
    readonly unavailableReason?: string;
  }> = [];

  if (enabledSlots.length === 0) {
    const fb = pickHealthyFallback(
      input.activeChatChair,
      input.fallbackCandidates.filter(
        (c) =>
          c.target.providerInstanceId !== input.activeChatChair.providerInstanceId ||
          c.target.modelId !== input.activeChatChair.modelId,
      ),
      input.assessTargetHealth,
      usedCounts,
    );
    const chosen = fb ?? { target: input.activeChatChair, supportsTemperature: false };
    workingSlots.push({
      slot: {
        target: chosen.target,
        enabled: true,
        supportsTemperature: chosen.supportsTemperature,
      },
      effectiveTarget: chosen.target,
      supportsTemperature: chosen.supportsTemperature,
      isFallbackSubstituted: true,
      fallbackReason: fb
        ? "활성 전역 하위 팀이 비어 있어 가용 폴백 모델을 의무 반론자로 합석했습니다."
        : "다른 활성 모델이 없어 의장 모델의 격리 적대적 세션으로 의무 반론자를 구성했습니다.",
    });
  } else {
    for (const slot of enabledSlots) {
      const health = input.assessTargetHealth(slot.target);
      if (health.healthy) {
        const key = `${slot.target.providerInstanceId}:${slot.target.modelId}`;
        usedCounts.set(key, (usedCounts.get(key) ?? 0) + 1);
        workingSlots.push({
          slot,
          effectiveTarget: slot.target,
          supportsTemperature: slot.supportsTemperature === true,
          isFallbackSubstituted: false,
        });
      } else {
        // Never silently swap a user-role-assigned model or an explicitly preserved
        // unavailable model (e.g. Antseed peer/policy cooldown) to a different model.
        const preserveAssignedSlot =
          slot.teamRole !== undefined ||
          slot.preferredRoleOverride !== undefined ||
          health.preserveSlotOnUnavailable === true;
        if (preserveAssignedSlot) {
          workingSlots.push({
            slot,
            effectiveTarget: slot.target,
            supportsTemperature: false,
            isFallbackSubstituted: false,
            unavailable: true,
            unavailableReason:
              health.reason ??
              `${slot.target.displayName} 사용 불가(피어/정책 또는 상태 확인 필요)`,
          });
          continue;
        }
        const fb = pickHealthyFallback(
          slot.target,
          input.fallbackCandidates,
          input.assessTargetHealth,
          usedCounts,
        );
        if (fb) {
          const key = `${fb.target.providerInstanceId}:${fb.target.modelId}`;
          usedCounts.set(key, (usedCounts.get(key) ?? 0) + 1);
          workingSlots.push({
            slot,
            effectiveTarget: fb.target,
            supportsTemperature: fb.supportsTemperature,
            isFallbackSubstituted: true,
            fallbackReason:
              health.reason ?? `${slot.target.displayName} 비활성/쿼터 소진으로 폴백 치환`,
          });
        } else {
          workingSlots.push({
            slot,
            effectiveTarget: slot.target,
            supportsTemperature: false,
            isFallbackSubstituted: false,
            unavailable: true,
            unavailableReason:
              health.reason ?? `${slot.target.displayName} 사용 불가(가용 폴백 없음)`,
          });
        }
      }
    }

    // All configured slots were unhealthy and none had external fallback -> isolate chair as contrarian
    if (workingSlots.length === 0) {
      workingSlots.push({
        slot: { target: input.activeChatChair, enabled: true },
        effectiveTarget: input.activeChatChair,
        supportsTemperature: false,
        isFallbackSubstituted: true,
        fallbackReason:
          "모든 하위 슬롯이 비활성/쿼터 소진 상태여서 격리 반론 세션으로 폴백했습니다.",
      });
    }
  }

  // Greedy-affinity assignment along the orthogonal role priority queue
  const remainingIndices = new Set(workingSlots.map((_, idx) => idx));
  const assignedRoles = new Map<number, CouncilRoleArchetype>();
  const capsByIndex = workingSlots.map((entry) =>
    inferSeatCapabilities({ ...entry.slot, target: entry.effectiveTarget }),
  );

  // First pass: assign each core archetype in strict priority order (ensures CONTRARIAN_RED first)
  let queueIdx = 0;
  while (remainingIndices.size > 0) {
    const role = ROLE_PRIORITY_QUEUE[queueIdx % ROLE_PRIORITY_QUEUE.length]!;
    queueIdx += 1;

    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const idx of remainingIndices) {
      const entry = workingSlots[idx]!;
      const score = roleAffinityScore(
        role,
        { ...entry.slot, target: entry.effectiveTarget },
        capsByIndex[idx]!,
        input.activeChatChair,
      );
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    }

    if (bestIndex === -1) break;
    assignedRoles.set(bestIndex, role);
    remainingIndices.delete(bestIndex);
  }

  // Homogeneous Team Guard: track duplicate (driverId, modelId) occurrences across subordinates + chair
  const modelKeyOccurrences = new Map<string, number>();
  const chairModelKey =
    `${input.activeChatChair.driverId}:${input.activeChatChair.modelId}`.toLowerCase();
  modelKeyOccurrences.set(chairModelKey, 1);

  // Order subordinates cleanly by priority role order so seat_sub_0 is CONTRARIAN_RED
  const orderedIndices = workingSlots
    .map((_, idx) => idx)
    .sort((a, b) => {
      const ra = ROLE_PRIORITY_QUEUE.indexOf(assignedRoles.get(a)!);
      const rb = ROLE_PRIORITY_QUEUE.indexOf(assignedRoles.get(b)!);
      return ra - rb;
    });

  const subordinateSeats: CouncilSeatAssignment[] = orderedIndices.map((origIdx, seatOrd) => {
    const entry = workingSlots[origIdx]!;
    const assignedRole = assignedRoles.get(origIdx) ?? "EDGE_PERF_CRITIC";
    const modelKey =
      `${entry.effectiveTarget.driverId}:${entry.effectiveTarget.modelId}`.toLowerCase();
    const priorDupCount = modelKeyOccurrences.get(modelKey) ?? 0;
    modelKeyOccurrences.set(modelKey, priorDupCount + 1);

    // Same-provider contrarian or duplicated model gets progressive temperature offset (capped at 0.25)
    const rawOffset =
      priorDupCount > 0
        ? Math.min(0.24, priorDupCount * 0.12)
        : assignedRole === "CONTRARIAN_RED" &&
            entry.effectiveTarget.driverId === input.activeChatChair.driverId
          ? 0.15
          : 0.0;
    const temperatureOffset = Number(rawOffset.toFixed(2));
    const temperatureApplied = temperatureOffset > 0 && entry.supportsTemperature;

    const directoryShardHint =
      input.topLevelDirs.length > 0 && (priorDupCount > 0 || orderedIndices.length > 5)
        ? input.topLevelDirs[seatOrd % input.topLevelDirs.length]!
        : null;

    return {
      seatId: `seat_sub_${seatOrd}`,
      targetModel: entry.effectiveTarget,
      assignedRole,
      capabilityTags: capsByIndex[origIdx]!,
      temperatureOffset,
      temperatureApplied,
      directoryShardHint,
      isFallbackSubstituted: entry.isFallbackSubstituted,
      ...(entry.fallbackReason ? { fallbackReason: entry.fallbackReason } : {}),
      ...(entry.unavailable ? { unavailable: true } : {}),
      ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
    };
  });

  return [chairSeat, ...subordinateSeats];
}
