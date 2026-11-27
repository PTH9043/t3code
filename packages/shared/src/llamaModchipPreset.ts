/**
 * Local `llama-modchip` v3.0 preset helpers and provider/model license & ToS guards.
 * - Loopback-only endpoints (`127.0.0.1:8789` OpenAI-compat / `:8787` SSE gateway).
 * - Anti-repetition sampling defaults for 1.63bpw / 32GB RAM quantizations.
 * - Regional license & ToS warnings (MiniMax H3 / P-H3-Image KR exclusion, Perch CLI-only rule, Simular Box limits).
 */

export const LLAMA_MODCHIP_DEFAULT_SERVER_URL = "http://127.0.0.1:8789/v1";
export const LLAMA_MODCHIP_DEFAULT_GATEWAY_URL = "http://127.0.0.1:8787";

export interface LlamaModchipSamplingDefaults {
  readonly temperature: number;
  readonly top_p: number;
  readonly top_k: number;
  readonly presence_penalty: number;
  readonly repeat_penalty: number;
}

/** Prevents greedy `temp=0` repetition loops observed on heavily quantized local MoE models. */
export const LLAMA_MODCHIP_SAFE_SAMPLING: LlamaModchipSamplingDefaults = {
  temperature: 0.6,
  top_p: 0.95,
  top_k: 20,
  presence_penalty: 0.2,
  repeat_penalty: 1.05,
};

export interface LlamaModchipTierRecommendation {
  readonly tier: "insufficient" | "16gb" | "32gb" | "64gb";
  readonly recommendedModels: ReadonlyArray<string>;
  readonly threads: number;
  readonly env: Readonly<Record<string, string>>;
  readonly warning?: string;
}

export function recommendLlamaModchipProfile(input: {
  readonly totalRamGb: number;
  readonly availableRamGb: number;
  readonly logicalCores: number;
  readonly availableVramGb?: number;
}): LlamaModchipTierRecommendation {
  const threads = Math.max(1, Math.floor(input.logicalCores) - 1);
  const env = { RC_TABLES_DIR: "/nonexistent" };

  if (input.totalRamGb >= 60 && input.availableRamGb >= 42) {
    return {
      tier: "64gb",
      recommendedModels: ["DeepSeek-V4-Flash-284B", "Qwen3.8-Flash-Next", "Nemotron-3.5-30B-A3B"],
      threads,
      env,
    };
  }
  if (input.totalRamGb >= 30 && input.availableRamGb >= 18) {
    return {
      tier: "32gb",
      recommendedModels: ["Qwen3.8-Flash-Next", "Nemotron-3.5-30B-A3B"],
      threads,
      env,
      warning: "64GB 티어 모델(DeepSeek-V4 284B)은 32GB RAM 환경에서 구동할 수 없습니다.",
    };
  }
  if (input.totalRamGb >= 15 && input.availableRamGb >= 10) {
    return {
      tier: "16gb",
      recommendedModels: ["Nemotron-3.5-30B-A3B"],
      threads,
      env,
      warning: "가용 RAM이 제한적입니다. 대형 로컬 모델 구동 전 다른 메모리 점유 앱을 정리하세요.",
    };
  }
  return {
    tier: "insufficient",
    recommendedModels: [],
    threads,
    env,
    warning: `현재 가용 RAM(${input.availableRamGb.toFixed(1)}GB${input.availableVramGb !== undefined ? `, 가용 VRAM ${input.availableVramGb.toFixed(1)}GB` : ""})이 부족해 대형 로컬 모델 실행 시 스왑 스톨이 발생할 수 있습니다.`,
  };
}

export interface ModelComplianceWarning {
  readonly code: "license_region_excluded" | "cli_surface_only" | "ephemeral_sandbox_limit";
  readonly severity: "warning" | "error";
  readonly message: string;
}

/**
 * Checks known model/service identifiers against verified regional license and ToS constraints:
 * - MiniMax H3 / PrunaAI P-H3-Image: excludes KR/US/EU/UK for local weight execution.
 * - Perch AI: prohibits direct internal HTTP scraping (`perch_surface_required` ban risk); CLI-only.
 * - Simular Box: one-time 5,000 credits (90d) and permanent deletion after 14d idle.
 */
export function evaluateModelComplianceWarning(
  modelOrServiceId: string,
): ModelComplianceWarning | null {
  const normalized = modelOrServiceId.trim().toLowerCase();
  if (/(?:p-h3-image|minimax[-_\s]?h3|prunaai\/p-h3)/iu.test(normalized)) {
    return {
      code: "license_region_excluded",
      severity: "error",
      message:
        "MiniMax H3 / P-H3-Image 커뮤니티 라이선스는 대한민국(KR)·미국·EU·영국 로컬 가중치 직접 구동을 허용 지역에서 제외합니다. 국내 로컬에서는 FLUX/Qwen-Image 등 오픈 라이선스 모델을 사용하거나 공식 클라우드 API를 경유하세요.",
    };
  }
  if (/(?:^perch|perchai)/iu.test(normalized)) {
    return {
      code: "cli_surface_only",
      severity: "warning",
      message:
        "Perch AI는 비공식 내부 HTTP API 직접 호출 시 계정이 정지(`perch_surface_required`)됩니다. 공식 `perch` CLI 서브프로세스 또는 BYOK 경로만 사용하세요(Qwen 3.8 Max 무료 제공은 2026-11-20 종료).",
    };
  }
  if (/simular[-_\s]?box/iu.test(normalized)) {
    return {
      code: "ephemeral_sandbox_limit",
      severity: "warning",
      message:
        "Simular Box 무료 플랜은 1회성 5,000 크레딧(90일 유효)이며 14일 미접속 시 환경과 파일이 영구 삭제됩니다. 영속 저장소로 사용하지 말고 일회성 MCP 보조 용도로만 사용하세요.",
    };
  }
  return null;
}
