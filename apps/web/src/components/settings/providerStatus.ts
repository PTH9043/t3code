import type { ServerProvider, ServerProviderVersionAdvisory } from "@t3tools/contracts";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

function koreanDetail(message: string | undefined, fallback: string | null): string | null {
  return message && /[가-힣]/.test(message) ? message : fallback;
}

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "CLI 상태 확인 중",
      detail: "서버에서 설치 및 인증 상태를 확인하고 있습니다.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "사용 안 함",
      detail: koreanDetail(
        provider.message,
        "이 CLI 계정은 새 세션에서 사용하지 않도록 설정되어 있습니다.",
      ),
    };
  }
  if (!provider.installed) {
    return {
      headline: "CLI를 찾을 수 없음",
      detail: koreanDetail(
        provider.message,
        "CLI 실행 파일이 설치되어 있고 PATH에 등록되어 있는지 확인하세요.",
      ),
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `인증됨 · ${authLabel}` : "인증됨",
      detail: koreanDetail(provider.message, null),
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "인증 필요",
      detail: koreanDetail(
        provider.message,
        "해당 CLI의 로그인 명령을 실행한 뒤 상태를 새로고침하세요.",
      ),
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "확인 필요",
      detail: koreanDetail(
        provider.message,
        "CLI는 설치되어 있지만 서버에서 상태를 완전히 확인하지 못했습니다.",
      ),
    };
  }
  if (provider.status === "error") {
    return {
      headline: "사용할 수 없음",
      detail: koreanDetail(
        provider.message,
        "CLI 시작 상태를 확인하지 못했습니다. 서버 로그를 확인하세요.",
      ),
    };
  }
  return {
    headline: "사용 가능",
    detail: koreanDetail(provider.message, "CLI는 준비되었지만 인증 상태를 확인하지 못했습니다."),
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
): {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const label = "업데이트 가능";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    detail: versionLabel
      ? `${label}: ${versionLabel} 버전을 설치할 수 있습니다.`
      : `${label}: 최신 CLI 버전을 설치할 수 있습니다.`,
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
  };
}
