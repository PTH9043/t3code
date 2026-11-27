// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { CompactHandoffPacket, MissionCrewRole } from "@t3tools/contracts";
import { MISSION_GUARDRAIL_LIMITS } from "./MissionBudgetGuard.ts";

/**
 * 3단 프롬프트 캐시 최적화 조립기 (Prompt Caching 80~90% 히트율 목표).
 *
 * - Layer 1 (완전 불변 Prefix): 헌법 + 크루 고정 페르소나 + 역할별 허용 도구(3~5개 알파벳 정렬) + 출력 JSON 스키마
 *   → timestamp/UUID/임시 ID 등 휘발성 줄 절대 금지!
 * - Layer 2 (미션 단위 반고정): 미션 목표(Goal) + 완료 조건(DoD) + 대상 경로 요약
 *   → 동일 미션의 후속 턴 간 캐시 공유!
 * - Layer 3 (동적 Suffix): 직전 CompactHandoffPacket 1개 + 밸브 압축 Tool Output + 현재 턴/시각
 *
 * 총 추정 토큰이 12,000T를 초과하면 자동으로 Layer 2/3을 절단·압축하고 `throttled: true`를 반환한다.
 */

const VOLATILE_PREFIX_LINE_PATTERN =
  /\b(?:20\d{2}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?|elapsed(?:Sec|Ms)?\s*[:=]\s*\d+|current(?:Time|Date|Timestamp)\s*[:=]|uptime\s*[:=]\s*\d+|pid\s*[:=]\s*\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/iu;

export const DEFAULT_ROLE_ALLOWED_TOOLS: Readonly<Record<string, ReadonlyArray<string>>> = {
  planner: ["list_files", "read_file", "search_code"],
  coder: ["apply_patch", "read_file", "run_tests", "search_code", "write_file"],
  reviewer: ["git_diff", "read_file", "run_tests", "search_code"],
  digest: ["read_artifact", "read_mission_digest"],
};

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  // 한글/영문/코드 혼합 보수적 추정: 약 3.2자당 1토큰
  return Math.ceil(text.length / 3.2);
}

export function stripVolatileLinesFromPrefix(text: string): {
  readonly cleaned: string;
  readonly relocatedLines: ReadonlyArray<string>;
} {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  const relocated: string[] = [];
  for (const line of lines) {
    if (VOLATILE_PREFIX_LINE_PATTERN.test(line)) {
      relocated.push(line);
    } else {
      kept.push(line);
    }
  }
  return {
    cleaned: kept.join("\n").trim(),
    relocatedLines: relocated,
  };
}

export function normalizeRoleScopedTools(
  roleKey: string,
  configuredTools?: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const source =
    configuredTools && configuredTools.length > 0
      ? configuredTools
      : (DEFAULT_ROLE_ALLOWED_TOOLS[roleKey] ?? DEFAULT_ROLE_ALLOWED_TOOLS.coder ?? []);
  return [...new Set(source.map((t) => t.trim()).filter((t) => t.length > 0))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 5);
}

export interface AssembleMissionPromptInput {
  readonly role: Pick<
    MissionCrewRole,
    "roleKey" | "displayName" | "systemDirective" | "allowedTools"
  >;
  readonly projectTitle: string;
  readonly missionTitle: string;
  readonly goalPrompt: string;
  readonly doneCriteria: ReadonlyArray<string>;
  readonly workspaceHints?: ReadonlyArray<string>;
  readonly incomingPacket?: CompactHandoffPacket | null;
  readonly compressedToolOutput?: string | null;
  readonly humanFeedbackNote?: string | null;
  readonly turnNumber: number;
  readonly nowIso: string;
  readonly maxTokens?: number;
}

export interface AssembledMissionPrompt {
  readonly layer1ImmutablePrefix: string;
  readonly layer2MissionSemiStatic: string;
  readonly layer3DynamicSuffix: string;
  readonly combinedPrompt: string;
  readonly prefixHash: string;
  readonly layer1Tokens: number;
  readonly layer2Tokens: number;
  readonly layer3Tokens: number;
  readonly totalTokens: number;
  readonly allowedTools: ReadonlyArray<string>;
  readonly relocatedVolatileLinesCount: number;
  readonly throttled: boolean;
}

export function assembleCacheAlignedMissionPrompt(
  input: AssembleMissionPromptInput,
): AssembledMissionPrompt {
  const maxTokens = input.maxTokens ?? MISSION_GUARDRAIL_LIMITS.maxTurnInputTokens;
  const allowedTools = normalizeRoleScopedTools(input.role.roleKey, input.role.allowedTools);

  const rawDirective =
    input.role.systemDirective.trim() ||
    `역할(${input.role.displayName}): 맡은 단계를 최소 범위로 정확히 완수하고 검증 근거를 남긴다.`;
  const cleanedDirective = stripVolatileLinesFromPrefix(rawDirective);

  // [Layer 1: 완전 불변 Prefix — 캐시 영구 유지 구간]
  const layer1Raw = [
    "# T3 자율 미션 헌법 (불변 Prefix)",
    "- 요청 범위 외 리팩터링·가상 최적화·임시파일 잔존을 금지한다.",
    "- 에이전트 간 교신은 3줄 핵심 요약(각 80자 이내)과 Artifact/Worktree 포인터만 반환한다.",
    "- 확인하지 않은 테스트 통과나 파일 수정을 꾸며내지 않는다.",
    `- 역할 키: ${input.role.roleKey}`,
    `- 역할명: ${input.role.displayName}`,
    `- 허용 도구 (알파벳 고정): ${allowedTools.join(", ")}`,
    "## 역할 지침",
    cleanedDirective.cleaned,
    "## 필수 응답 태그 (기계 판독용)",
    '<t3_mission_result>{"status":"ok"|"fix_required"|"escalate","summary3Lines":["줄1","줄2","줄3"],"changedFiles":[],"verificationCmd":null,"recommendation":"다음 조치 1줄"}</t3_mission_result>',
  ].join("\n");

  const layer1Checked = stripVolatileLinesFromPrefix(layer1Raw);
  const layer1ImmutablePrefix = layer1Checked.cleaned;

  // [Layer 2: 미션 단위 반고정 구간 — 미션 내 턴 간 캐시 공유]
  const criteriaText =
    input.doneCriteria.length > 0
      ? input.doneCriteria.map((c, idx) => `${idx + 1}. ${c}`).join("\n")
      : "1. 목표 요구사항 충족 및 회귀 없음 확인";
  const hintsText =
    input.workspaceHints && input.workspaceHints.length > 0
      ? `\n## 주요 경로 힌트\n${input.workspaceHints
          .slice(0, 12)
          .map((h) => `- ${h}`)
          .join("\n")}`
      : "";
  const layer2Raw = [
    "## 미션 고정 컨텍스트",
    `- 프로젝트: ${input.projectTitle}`,
    `- 미션 제목: ${input.missionTitle}`,
    "### 목표(Goal)",
    input.goalPrompt.trim().slice(0, 3000),
    "### 완료 조건(Definition of Done)",
    criteriaText,
    hintsText,
  ]
    .filter((block) => block.length > 0)
    .join("\n");
  const layer2Checked = stripVolatileLinesFromPrefix(layer2Raw);
  let layer2MissionSemiStatic = layer2Checked.cleaned;

  // [Layer 3: 매 턴 바뀌는 동적 Suffix — 최소 크기 유지]
  const dynamicBlocks: string[] = [
    `## 동적 턴 컨텍스트 (턴 #${input.turnNumber} · ${input.nowIso})`,
  ];
  if (cleanedDirective.relocatedLines.length > 0 || layer2Checked.relocatedLines.length > 0) {
    dynamicBlocks.push(
      "### 이동된 휘발성 메타",
      ...cleanedDirective.relocatedLines,
      ...layer2Checked.relocatedLines,
    );
  }
  if (input.incomingPacket) {
    dynamicBlocks.push(
      "### 직전 핸드오프 패킷 (Pass-by-Reference)",
      JSON.stringify({
        from: input.incomingPacket.fromRole,
        intent: input.incomingPacket.intent,
        hop: input.incomingPacket.hopCount,
        rework: input.incomingPacket.reworkCycle,
        summary3Lines: input.incomingPacket.summary3Lines,
        pointers: input.incomingPacket.pointers,
        proof: input.incomingPacket.verificationProof,
      }),
    );
  }
  if (input.compressedToolOutput && input.compressedToolOutput.trim().length > 0) {
    dynamicBlocks.push(
      "### 압축된 도구 출력 (Tool Output Valve)",
      input.compressedToolOutput.trim(),
    );
  }
  if (input.humanFeedbackNote && input.humanFeedbackNote.trim().length > 0) {
    dynamicBlocks.push(
      "### 사용자 결재 수정 지시 (최우선 반영)",
      input.humanFeedbackNote.trim().slice(0, 1200),
    );
  }
  let layer3DynamicSuffix = dynamicBlocks.join("\n");

  // 12,000T 상한 초과 시 자동 압축 (THROTTLED)
  let throttled = false;
  const maxChars = Math.floor(maxTokens * 3.2);
  const currentTotalChars =
    layer1ImmutablePrefix.length + layer2MissionSemiStatic.length + layer3DynamicSuffix.length;
  if (currentTotalChars > maxChars) {
    throttled = true;
    const budgetForDynamicAndMission = Math.max(
      1200,
      maxChars - layer1ImmutablePrefix.length - 120,
    );
    const missionCap = Math.floor(budgetForDynamicAndMission * 0.55);
    const dynamicCap = Math.max(600, budgetForDynamicAndMission - missionCap);
    if (layer2MissionSemiStatic.length > missionCap) {
      layer2MissionSemiStatic = `${layer2MissionSemiStatic.slice(0, missionCap)}\n...[12K 토큰 가드: 미션 컨텍스트 압축됨]`;
    }
    if (layer3DynamicSuffix.length > dynamicCap) {
      layer3DynamicSuffix = `${layer3DynamicSuffix.slice(0, dynamicCap)}\n...[12K 토큰 가드: 동적 출력 압축됨]`;
    }
  }

  const combinedPrompt = [
    layer1ImmutablePrefix,
    "---",
    layer2MissionSemiStatic,
    "---",
    layer3DynamicSuffix,
  ].join("\n\n");

  const layer1Tokens = estimateTextTokens(layer1ImmutablePrefix);
  const layer2Tokens = estimateTextTokens(layer2MissionSemiStatic);
  const layer3Tokens = estimateTextTokens(layer3DynamicSuffix);
  const totalTokens = layer1Tokens + layer2Tokens + layer3Tokens;

  const prefixHash = NodeCrypto.createHash("sha256")
    .update(`${layer1ImmutablePrefix}\n::L2::\n${layer2MissionSemiStatic}`, "utf8")
    .digest("hex")
    .slice(0, 24);

  return {
    layer1ImmutablePrefix,
    layer2MissionSemiStatic,
    layer3DynamicSuffix,
    combinedPrompt,
    prefixHash,
    layer1Tokens,
    layer2Tokens,
    layer3Tokens,
    totalTokens,
    allowedTools,
    relocatedVolatileLinesCount:
      cleanedDirective.relocatedLines.length +
      layer1Checked.relocatedLines.length +
      layer2Checked.relocatedLines.length,
    throttled,
  };
}

export function estimateCachedPromptTokens(input: {
  readonly previousPrefixHash: string | null;
  readonly currentPrefixHash: string;
  readonly layer1Tokens: number;
  readonly layer2Tokens: number;
}): number {
  if (input.previousPrefixHash && input.previousPrefixHash === input.currentPrefixHash) {
    // Layer 1 + Layer 2 전체 캐시 히트
    return input.layer1Tokens + input.layer2Tokens;
  }
  // 최초 호출이라도 Layer 1 불변 Prefix는 동일 크루 재호출 시 캐시 적중 대상(첫 턴은 0)
  return 0;
}
