// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { validatePreviewNavigationUrl } from "./HostSecurityGuard.ts";

export const OBSCURA_DEFAULT_HOST = "127.0.0.1";
export const OBSCURA_DEFAULT_PORT = 9222;

export interface ObscuraLaunchConfig {
  readonly binaryPath: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly workers: number;
  readonly workerMaxAgeSeconds: number;
  readonly allowPrivateNetwork: boolean;
  readonly stealth: boolean;
}

export interface ObscuraCommandSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cdpEndpoint: string;
}

export interface ObscuraProbeResult {
  readonly available: boolean;
  readonly binaryPath: string | null;
  readonly workerPresent: boolean;
  readonly cdpEndpoint: string;
  readonly reason?: string;
}

/**
 * Resolves optional `obscura` + `obscura-worker` binaries on PATH or an explicit directory.
 * Always degrades gracefully (`available: false`) when not installed so core T3 never breaks.
 */
export function probeObscuraBinary(options?: {
  readonly explicitPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly port?: number;
}): ObscuraProbeResult {
  const platform = options?.platform ?? process.platform;
  const port = options?.port ?? OBSCURA_DEFAULT_PORT;
  const cdpEndpoint = `ws://${OBSCURA_DEFAULT_HOST}:${port}`;
  const ext = platform === "win32" ? ".exe" : "";
  const candidates: string[] = [];

  if (options?.explicitPath?.trim()) {
    candidates.push(options.explicitPath.trim());
  }
  const env = options?.env ?? process.env;
  const pathVar = env.PATH ?? env.Path ?? "";
  for (const entry of pathVar.split(platform === "win32" ? ";" : ":")) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    candidates.push(NodePath.join(dir, `obscura${ext}`));
  }

  for (const candidate of candidates) {
    try {
      if (NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile()) {
        const workerPath = NodePath.join(NodePath.dirname(candidate), `obscura-worker${ext}`);
        return {
          available: true,
          binaryPath: candidate,
          workerPresent: NodeFS.existsSync(workerPath),
          cdpEndpoint,
        };
      }
    } catch {
      // Ignore unreadable path entries.
    }
  }

  return {
    available: false,
    binaryPath: null,
    workerPresent: false,
    cdpEndpoint,
    reason:
      "obscura binary not installed (falling back to built-in PreviewAutomationBroker / LlmsTxtFetch)",
  };
}

/**
 * Builds a strictly loopback-bound Obscura CDP server command (~30MB RAM vs Chrome 200MB+).
 */
export function buildObscuraServeCommand(
  config: Partial<ObscuraLaunchConfig> & {
    readonly binaryPath: string;
  },
): ObscuraCommandSpec {
  const port = config.port ?? OBSCURA_DEFAULT_PORT;
  const workers = Math.max(1, Math.min(8, config.workers ?? 2));
  const workerMaxAgeSeconds = Math.max(60, config.workerMaxAgeSeconds ?? 1800);
  const args: string[] = [
    "serve",
    "--host",
    OBSCURA_DEFAULT_HOST,
    "--port",
    String(port),
    "--workers",
    String(workers),
    "--worker-max-age",
    String(workerMaxAgeSeconds),
  ];
  if (config.stealth !== false) {
    args.push("--stealth");
  }
  if (config.allowPrivateNetwork === true) {
    args.push("--allow-private-network");
  }
  return {
    command: config.binaryPath,
    args,
    cdpEndpoint: `ws://${OBSCURA_DEFAULT_HOST}:${port}`,
  };
}

/**
 * Validates a target URL before forwarding to Obscura (`LP.getMarkdown` / CDP navigation).
 */
export function validateObscuraTargetUrl(
  url: string,
  options?: { readonly allowPrivateNetwork?: boolean },
): { readonly allowed: boolean; readonly reason?: string } {
  return validatePreviewNavigationUrl(url, {
    allowLocalhost: options?.allowPrivateNetwork === true,
  });
}
