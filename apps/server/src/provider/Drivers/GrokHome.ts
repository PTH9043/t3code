// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import type { GrokSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

export const GROK_HOME_ENV = "GROK_HOME";
export const GROK_API_KEY_ENV = "XAI_API_KEY";
export const GROK_AUTH_FILENAME = "auth.json";

const GrokAuthEntrySchema = Schema.Struct({
  key: Schema.optional(Schema.String),
  access_token: Schema.optional(Schema.String),
  auth_mode: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  first_name: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.String),
  team_id: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.String),
});

const GrokAuthFileSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeGrokAuthFile = Schema.decodeUnknownOption(Schema.fromJsonString(GrokAuthFileSchema));
const decodeGrokAuthEntry = Schema.decodeUnknownOption(GrokAuthEntrySchema);

export interface GrokAuthSummary {
  readonly filePath: string;
  readonly exists: boolean;
  readonly authenticated: boolean;
  readonly expired: boolean;
  readonly hasRefreshToken: boolean;
  readonly email?: string;
  readonly firstName?: string;
  readonly userId?: string;
  readonly teamId?: string;
  readonly authMode?: string;
  readonly expiresAt?: string;
}

export function normalizeGrokEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function hasGrokApiKeyInEnv(environment: NodeJS.ProcessEnv | undefined): boolean {
  return Boolean(environment?.[GROK_API_KEY_ENV]?.trim());
}

export const resolveGrokHomePath = Effect.fn("resolveGrokHomePath")(function* (
  config: Pick<GrokSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configured = config.homePath.trim();
  if (configured.length > 0) {
    return path.resolve(expandHomePath(configured));
  }
  const envHome = environment?.[GROK_HOME_ENV]?.trim();
  if (envHome && envHome.length > 0) {
    return path.resolve(expandHomePath(envHome));
  }
  return path.resolve(path.join(NodeOS.homedir(), ".grok"));
});

export const makeGrokEnvironment = Effect.fn("makeGrokEnvironment")(function* (
  config: Pick<GrokSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const configured = config.homePath.trim();
  if (configured.length === 0) {
    return resolvedBaseEnv;
  }
  const resolvedHomePath = yield* resolveGrokHomePath(config, resolvedBaseEnv);
  return {
    ...resolvedBaseEnv,
    [GROK_HOME_ENV]: resolvedHomePath,
  };
});

export const makeGrokContinuationGroupKey = Effect.fn("makeGrokContinuationGroupKey")(function* (
  config: Pick<GrokSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const resolvedHomePath = yield* resolveGrokHomePath(config, environment);
  const keyScope = hasGrokApiKeyInEnv(environment) ? "apikey" : "home";
  return `grok:${keyScope}:${resolvedHomePath}`;
});

function parseIsoTimestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Normalize nanosecond fractional timestamps (e.g. 2026-11-25T02:08:58.400420900Z) to milliseconds.
  const normalized = trimmed.replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d\d:\d\d)$)/u, "$1");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Inspect a Grok home's `auth.json` without exposing any token material.
 * Only non-secret identity metadata (email, user_id, auth_mode, expiry) is returned.
 */
export const readGrokAuthSummary = Effect.fn("readGrokAuthSummary")(function* (
  grokHomePath: string,
): Effect.fn.Return<GrokAuthSummary, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(grokHomePath, GROK_AUTH_FILENAME);
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

  const parsedRecord = decodeGrokAuthFile(rawOption.value);
  if (Option.isNone(parsedRecord)) {
    return {
      filePath,
      exists: true,
      authenticated: false,
      expired: false,
      hasRefreshToken: false,
    };
  }

  const nowMs = yield* Clock.currentTimeMillis;
  let bestFallback: GrokAuthSummary | undefined;

  for (const candidate of Object.values(parsedRecord.value)) {
    const decoded = decodeGrokAuthEntry(candidate);
    if (Option.isNone(decoded)) continue;
    const entry = decoded.value;
    const token = entry.key?.trim() || entry.access_token?.trim() || "";
    const hasRefreshToken = Boolean(entry.refresh_token?.trim());
    if (token.length === 0 && !hasRefreshToken) continue;

    const expiresAtMs = parseIsoTimestampMs(entry.expires_at);
    const expired = expiresAtMs !== undefined && expiresAtMs <= nowMs;
    // Grok CLI silently refreshes tokens via `refresh_token` even when `expires_at` has passed.
    const authenticated = (!expired && token.length > 0) || hasRefreshToken;
    const email = entry.email?.trim() || undefined;
    const firstName = entry.first_name?.trim() || undefined;
    const userId = entry.user_id?.trim() || undefined;
    const teamId = entry.team_id?.trim() || undefined;
    const authMode = entry.auth_mode?.trim() || undefined;
    const expiresAt = entry.expires_at?.trim() || undefined;

    const summary: GrokAuthSummary = {
      filePath,
      exists: true,
      authenticated,
      expired,
      hasRefreshToken,
      ...(email ? { email } : {}),
      ...(firstName ? { firstName } : {}),
      ...(userId ? { userId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(authMode ? { authMode } : {}),
      ...(expiresAt ? { expiresAt } : {}),
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
