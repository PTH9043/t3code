/**
 * Opt-in loopback bridge for `ranxianglei/billion-context` (`bili`) in-session
 * progressive context compression proxy:
 * - Strictly loopback-only (`127.0.0.1:18787`, never `0.0.0.0`, separated from llama-modchip `:8787`).
 * - Prevents double compression with Claude native `/compact` or T3 `BackgroundAutoCompactor`.
 * - Keeps Gemini/Antigravity ACP health probes Direct while rewriting only inference URLs.
 * - Preserves MIT Additional Term (Attribution on Product Surfaces) metadata for UI display.
 */

export const BILLION_CONTEXT_DEFAULT_HOST = "127.0.0.1" as const;
export const BILLION_CONTEXT_DEFAULT_PORT = 18787;
export const BILLION_CONTEXT_ATTRIBUTION = {
  project: "billion-context",
  repositoryUrl: "https://github.com/ranxianglei/billion-context",
  licenseNote: "MIT + Additional Term (Attribution on Product Surfaces)",
} as const;

export interface BillionContextBridgeConfig {
  readonly enabled: boolean;
  readonly port?: number;
  readonly maxContextLimitPercent?: number;
  readonly disableT3AutoCompactorWhenActive?: boolean;
}

export interface BillionContextProviderEnvPatch {
  readonly env: Readonly<Record<string, string>>;
  readonly bypassForAcpProbe: boolean;
  readonly suppressNativeCompaction: boolean;
  readonly attribution: typeof BILLION_CONTEXT_ATTRIBUTION;
}

export function resolveBillionContextBaseUrl(port = BILLION_CONTEXT_DEFAULT_PORT): string {
  const safePort =
    Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : BILLION_CONTEXT_DEFAULT_PORT;
  return `http://${BILLION_CONTEXT_DEFAULT_HOST}:${safePort}`;
}

export function resolveBillionContextHealthUrl(port = BILLION_CONTEXT_DEFAULT_PORT): string {
  return `${resolveBillionContextBaseUrl(port)}/__bili/health`;
}

/**
 * Builds provider-specific `/bili/` proxy env overrides without exposing external interfaces
 * or breaking Gemini ACP health probes.
 */
export function buildBillionContextProviderEnv(input: {
  readonly provider: "codex" | "claudeAgent" | "gemini";
  readonly config: BillionContextBridgeConfig;
  readonly upstreamBaseUrl?: string;
}): BillionContextProviderEnvPatch | null {
  if (!input.config.enabled) return null;
  const proxyOrigin = resolveBillionContextBaseUrl(input.config.port);

  switch (input.provider) {
    case "codex": {
      const upstream = (input.upstreamBaseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "");
      return {
        env: {
          OPENAI_BASE_URL: `${proxyOrigin}/bili/${upstream}`,
        },
        bypassForAcpProbe: false,
        suppressNativeCompaction: input.config.disableT3AutoCompactorWhenActive !== false,
        attribution: BILLION_CONTEXT_ATTRIBUTION,
      };
    }
    case "claudeAgent": {
      const upstream = (input.upstreamBaseUrl ?? "https://api.anthropic.com").replace(/\/+$/u, "");
      return {
        env: {
          ANTHROPIC_BASE_URL: `${proxyOrigin}/bili/${upstream}`,
          BILLION_CONTEXT_NATIVE: "1",
        },
        bypassForAcpProbe: false,
        suppressNativeCompaction: input.config.disableT3AutoCompactorWhenActive !== false,
        attribution: BILLION_CONTEXT_ATTRIBUTION,
      };
    }
    case "gemini": {
      return {
        // Antigravity CLI (`agy acp`) routes through its own authenticated ACP endpoint
        // and does not read legacy `@google/gemini-cli` `GOOGLE_GEMINI_BASE_URL` overrides.
        env: {},
        bypassForAcpProbe: true,
        suppressNativeCompaction: input.config.disableT3AutoCompactorWhenActive !== false,
        attribution: BILLION_CONTEXT_ATTRIBUTION,
      };
    }
  }
}

export async function probeBillionContextHealth(
  port = BILLION_CONTEXT_DEFAULT_PORT,
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly healthy: boolean; readonly url: string; readonly reason?: string }> {
  const url = resolveBillionContextHealthUrl(port);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(1_500),
    });
    return {
      healthy: res.ok,
      url,
      ...(res.ok ? {} : { reason: `HTTP ${res.status}` }),
    };
  } catch (error) {
    return {
      healthy: false,
      url,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
