// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { MuseSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

export const MUSE_API_KEY_ENV = "META_API_KEY";
export const MUSE_NO_AUTO_UPDATE_ENV = "MUSE_NO_AUTO_UPDATE";
export const MUSE_LOGIN_ENV = "MUSE_LOGIN";
export const MUSE_AUTH_FILENAME = "auth.json";

const MuseAuthProviderEntrySchema = Schema.Struct({
  mechanism: Schema.optional(Schema.String),
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  api_key: Schema.optional(Schema.String),
  api_base_url: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  expires_at_ms: Schema.optional(Schema.Number),
  user_email: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  user_full_name: Schema.optional(Schema.String),
  full_name: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.String),
});

const MuseAuthFileSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeMuseAuthFile = Schema.decodeUnknownOption(Schema.fromJsonString(MuseAuthFileSchema));
const decodeMuseAuthEntry = Schema.decodeUnknownOption(MuseAuthProviderEntrySchema);

export interface MuseAuthSummary {
  readonly filePath: string;
  readonly exists: boolean;
  readonly authenticated: boolean;
  readonly expired: boolean;
  readonly hasRefreshToken: boolean;
  readonly mechanism?: string;
  readonly email?: string;
  readonly fullName?: string;
  readonly userId?: string;
  readonly expiresAt?: string;
}

export function normalizeMuseEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function hasMuseApiKeyInEnv(environment: NodeJS.ProcessEnv | undefined): boolean {
  return Boolean(environment?.[MUSE_API_KEY_ENV]?.trim());
}

function resolveNativeMuseBinaryInDir(dir: string): string | undefined {
  try {
    const versionFile = NodePath.join(dir, ".muse-version");
    if (NodeFs.existsSync(versionFile)) {
      const version = NodeFs.readFileSync(versionFile, "utf8").trim();
      if (version.length > 0) {
        const ext = process.platform === "win32" ? ".exe" : "";
        const candidate = NodePath.join(dir, `muse-bin-${version}${ext}`);
        if (NodeFs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
    if (!NodeFs.existsSync(dir)) {
      return undefined;
    }
    const entries = NodeFs.readdirSync(dir)
      .filter((name) =>
        process.platform === "win32"
          ? /^muse-bin-.+\.exe$/i.test(name)
          : /^muse-bin-.+$/i.test(name),
      )
      .sort()
      .reverse();
    if (entries[0]) {
      return NodePath.join(dir, entries[0]);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Resolve the native Muse Code executable path.
 *
 * On Windows the official `muse.cmd` shim delegates to PowerShell
 * `.muse-launcher.ps1`, which in turn runs `muse-bin-<version>.exe` inside
 * `%LOCALAPPDATA%\Programs\muse`. Resolving the native `muse-bin-<version>.exe`
 * directly avoids spawning PowerShell, eliminates console flashes, and still
 * tracks future updates via `.muse-version`.
 */
export function resolveMuseBinaryPath(
  configuredBinaryPath: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const raw = configuredBinaryPath?.trim() ?? "";
  const isDefaultName =
    raw.length === 0 || raw.toLowerCase() === "muse" || raw.toLowerCase() === "muse.cmd";

  if (!isDefaultName) {
    if (process.platform === "win32" && /\.cmd$/i.test(raw)) {
      const sibling = resolveNativeMuseBinaryInDir(NodePath.dirname(raw));
      if (sibling) return sibling;
    }
    return raw;
  }

  const candidateDirs: string[] = [];
  const explicitInstallDir = environment.MUSE_INSTALL_DIR?.trim();
  if (explicitInstallDir) {
    candidateDirs.push(explicitInstallDir);
  }
  if (process.platform === "win32") {
    const localAppData =
      environment.LOCALAPPDATA?.trim() || NodePath.join(NodeOS.homedir(), "AppData", "Local");
    candidateDirs.push(NodePath.join(localAppData, "Programs", "muse"));
  } else {
    candidateDirs.push(
      NodePath.join(NodeOS.homedir(), ".local", "bin"),
      NodePath.join(NodeOS.homedir(), ".muse", "bin"),
    );
  }

  for (const dir of candidateDirs) {
    const nativeBinary = resolveNativeMuseBinaryInDir(dir);
    if (nativeBinary) {
      return nativeBinary;
    }
  }

  return raw.length > 0 ? raw : "muse";
}

export const resolveMuseHomePath = Effect.fn("resolveMuseHomePath")(function* (
  config: Pick<MuseSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configured = config.homePath.trim();
  if (configured.length > 0) {
    return path.resolve(expandHomePath(configured));
  }
  const envXdgConfig = environment?.XDG_CONFIG_HOME?.trim();
  if (envXdgConfig && envXdgConfig.length > 0) {
    return path.resolve(expandHomePath(envXdgConfig));
  }
  return path.resolve(path.join(NodeOS.homedir(), ".config"));
});

/**
 * Resolve the directory containing `auth.json` and `settings.json` for a Muse instance.
 *
 * When a dedicated `homePath` is configured, Muse receives isolated XDG directories:
 * - `XDG_CONFIG_HOME = <homePath>/config` -> `<homePath>/config/muse/auth.json`
 * - `XDG_DATA_HOME   = <homePath>/data`
 * - `XDG_STATE_HOME  = <homePath>/state`
 *
 * When `homePath` is empty (default instance), Muse reads the user's standard
 * `$XDG_CONFIG_HOME/muse` or `~/.config/muse`, staying in sync with terminal logins.
 */
export const resolveMuseConfigDir = Effect.fn("resolveMuseConfigDir")(function* (
  config: Pick<MuseSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configured = config.homePath.trim();
  if (configured.length > 0) {
    return path.join(path.resolve(expandHomePath(configured)), "config", "muse");
  }
  const envXdgConfig = environment?.XDG_CONFIG_HOME?.trim();
  if (envXdgConfig && envXdgConfig.length > 0) {
    return path.join(path.resolve(expandHomePath(envXdgConfig)), "muse");
  }
  return path.join(NodeOS.homedir(), ".config", "muse");
});

export const makeMuseEnvironment = Effect.fn("makeMuseEnvironment")(function* (
  config: Pick<MuseSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const path = yield* Path.Path;
  const resolvedBaseEnv = baseEnv ?? process.env;
  const next: NodeJS.ProcessEnv = {
    ...resolvedBaseEnv,
    [MUSE_NO_AUTO_UPDATE_ENV]: "1",
    [MUSE_LOGIN_ENV]: "0",
  };
  const configured = config.homePath.trim();
  if (configured.length > 0) {
    const resolvedHome = path.resolve(expandHomePath(configured));
    next.XDG_CONFIG_HOME = path.join(resolvedHome, "config");
    next.XDG_DATA_HOME = path.join(resolvedHome, "data");
    next.XDG_STATE_HOME = path.join(resolvedHome, "state");
  }
  return next;
});

export const makeMuseContinuationGroupKey = Effect.fn("makeMuseContinuationGroupKey")(function* (
  config: Pick<MuseSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const configDir = yield* resolveMuseConfigDir(config, environment);
  const keyScope = hasMuseApiKeyInEnv(environment) ? "apikey" : "home";
  return `muse:${keyScope}:${configDir}`;
});

function parseExpiryMs(entry: typeof MuseAuthProviderEntrySchema.Type): {
  readonly expiresAtMs?: number;
  readonly expiresAtIso?: string;
} {
  if (typeof entry.expires_at_ms === "number" && Number.isFinite(entry.expires_at_ms)) {
    return {
      expiresAtMs: entry.expires_at_ms,
      expiresAtIso: DateTime.formatIso(DateTime.makeUnsafe(entry.expires_at_ms)),
    };
  }
  if (typeof entry.expires_at === "number" && Number.isFinite(entry.expires_at)) {
    const ms = entry.expires_at > 1e12 ? entry.expires_at : entry.expires_at * 1000;
    return {
      expiresAtMs: ms,
      expiresAtIso: DateTime.formatIso(DateTime.makeUnsafe(ms)),
    };
  }
  if (typeof entry.expires_at === "string") {
    const trimmed = entry.expires_at.trim();
    if (trimmed.length > 0) {
      const normalized = trimmed.replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d\d:\d\d)$)/u, "$1");
      const parsed = Date.parse(normalized);
      if (Number.isFinite(parsed)) {
        return { expiresAtMs: parsed, expiresAtIso: trimmed };
      }
    }
  }
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Inspect a Muse config directory's `auth.json` without exposing secret token material.
 * Only non-secret identity metadata (email, fullName, mechanism, expiry) is returned.
 */
export const readMuseAuthSummary = Effect.fn("readMuseAuthSummary")(function* (
  museConfigDir: string,
): Effect.fn.Return<MuseAuthSummary, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(museConfigDir, MUSE_AUTH_FILENAME);
  const rawOption = yield* fs.readFileString(filePath).pipe(Effect.option);
  if (Option.isNone(rawOption)) {
    return {
      filePath,
      exists: false,
      authenticated: false,
      expired: false,
      hasRefreshToken: false,
    };
  }

  const parsedRecord = decodeMuseAuthFile(rawOption.value);
  if (Option.isNone(parsedRecord)) {
    return {
      filePath,
      exists: true,
      authenticated: false,
      expired: false,
      hasRefreshToken: false,
    };
  }

  const root = parsedRecord.value;
  const candidates: unknown[] = [];
  if (isPlainObject(root.providers)) {
    if ("meta" in root.providers) {
      candidates.push(root.providers.meta);
    }
    for (const [key, value] of Object.entries(root.providers)) {
      if (key !== "meta") {
        candidates.push(value);
      }
    }
  }
  candidates.push(root);

  const nowMs = yield* Clock.currentTimeMillis;
  let bestFallback: MuseAuthSummary | undefined;

  for (const candidate of candidates) {
    const decoded = decodeMuseAuthEntry(candidate);
    if (Option.isNone(decoded)) continue;
    const entry = decoded.value;
    const accessToken = entry.access_token?.trim() ?? "";
    const apiKey = entry.api_key?.trim() ?? "";
    const hasRefreshToken = Boolean(entry.refresh_token?.trim());
    if (accessToken.length === 0 && apiKey.length === 0 && !hasRefreshToken) {
      continue;
    }

    const { expiresAtMs, expiresAtIso } = parseExpiryMs(entry);
    const expired = apiKey.length === 0 && expiresAtMs !== undefined && expiresAtMs <= nowMs;
    const authenticated =
      apiKey.length > 0 || (!expired && accessToken.length > 0) || hasRefreshToken;
    const mechanism = entry.mechanism?.trim() || (apiKey.length > 0 ? "api_key" : "oauth");
    const email = entry.user_email?.trim() || entry.email?.trim() || undefined;
    const fullName = entry.user_full_name?.trim() || entry.full_name?.trim() || undefined;
    const userId = entry.user_id?.trim() || undefined;

    const summary: MuseAuthSummary = {
      filePath,
      exists: true,
      authenticated,
      expired,
      hasRefreshToken,
      mechanism,
      ...(email ? { email } : {}),
      ...(fullName ? { fullName } : {}),
      ...(userId ? { userId } : {}),
      ...(expiresAtIso ? { expiresAt: expiresAtIso } : {}),
    };

    if (authenticated) {
      return summary;
    }
    bestFallback ??= summary;
  }

  return (
    bestFallback ?? {
      filePath,
      exists: true,
      authenticated: false,
      expired: false,
      hasRefreshToken: false,
    }
  );
});
