// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { MuseSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

export const MUSE_CLOUD_NO_UPDATE_CHECK_ENV = "MUSE_NO_UPDATE_CHECK";
export const MUSE_CLOUD_SESSION_COOKIE = "hatch_sess";
export const MUSE_CLOUD_COOKIES_FILENAME = "cookies.txt";
export const MUSE_CLOUD_TOKENS_FILENAME = "tokens.json";

/**
 * Minimal Python bridge run inside `muse-cli`'s own uv tool virtualenv so large
 * prompts (which include T3 system instructions and easily exceed Windows's
 * 32,767-char CreateProcess command-line limit) are streamed over UTF-8 stdin
 * directly into `muse_cli.cli.cmd_send` without ever touching argv length limits.
 */
export const MUSE_CLOUD_STDIN_SEND_SCRIPT = [
  "import sys, types",
  "from muse_cli import cli",
  'text = sys.stdin.buffer.read().decode("utf-8")',
  "thread = sys.argv[1] or None",
  "wait = int(sys.argv[2])",
  "cli.cmd_send(types.SimpleNamespace(text=text, thread=thread, wait=wait, download=None))",
].join("; ");

/**
 * Locate the Python interpreter inside the `uv tool`-managed `muse-cli`
 * virtualenv when using the real `muse-cli` binary (returns `undefined` for
 * custom scripts/wrappers such as unit-test fakes so those keep direct CLI invocation).
 */
export function resolveMuseCloudPythonPath(
  configuredBinaryPath: string | null | undefined,
): string | undefined {
  const raw = configuredBinaryPath?.trim() ?? "";
  const isDefault =
    raw.length === 0 || raw.toLowerCase() === "muse-cli" || /[\\/]muse-cli(?:\.exe)?$/i.test(raw);
  if (!isDefault) {
    return undefined;
  }

  const realHome = NodeOS.homedir();
  const appData = process.env.APPDATA ?? NodePath.join(realHome, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? NodePath.join(realHome, "AppData", "Local");
  const candidates =
    process.platform === "win32"
      ? [
          NodePath.join(appData, "uv", "tools", "muse-cli", "Scripts", "python.exe"),
          NodePath.join(localAppData, "uv", "tools", "muse-cli", "Scripts", "python.exe"),
        ]
      : [
          NodePath.join(realHome, ".local", "share", "uv", "tools", "muse-cli", "bin", "python"),
          NodePath.join(realHome, ".local", "share", "uv", "tools", "muse-cli", "bin", "python3"),
        ];

  for (const candidate of candidates) {
    try {
      if (NodeFs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore stat errors and continue fallback chain.
    }
  }
  return undefined;
}

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface MuseCloudCookieEntry {
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly expires: number;
  readonly name: string;
  readonly value: string;
}

export interface MuseCloudAuthSummary {
  readonly filePath: string;
  readonly exists: boolean;
  readonly authenticated: boolean;
  readonly expired: boolean;
  readonly cookieCount: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the `muse-cli` executable path.
 * Falls back to `~/.local/bin/muse-cli(.exe)` where `uv tool install` places it,
 * so it works even when `~/.local/bin` is not in the ambient system PATH.
 */
export function resolveMuseCloudBinaryPath(
  configuredBinaryPath: string | null | undefined,
): string {
  const raw = configuredBinaryPath?.trim() ?? "";
  const isDefault = raw.length === 0 || raw.toLowerCase() === "muse-cli";
  if (!isDefault) {
    return raw;
  }

  const realHome = NodeOS.homedir();
  const candidates =
    process.platform === "win32"
      ? [
          NodePath.join(realHome, ".local", "bin", "muse-cli.exe"),
          NodePath.join(realHome, ".local", "bin", "muse-cli"),
        ]
      : [NodePath.join(realHome, ".local", "bin", "muse-cli")];

  for (const candidate of candidates) {
    try {
      if (NodeFs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore stat errors and continue fallback chain.
    }
  }

  return "muse-cli";
}

export const resolveMuseCloudHomePath = Effect.fn("resolveMuseCloudHomePath")(function* (
  config: Pick<MuseSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configured = config.homePath.trim();
  if (configured.length > 0) {
    return path.resolve(expandHomePath(configured));
  }
  const envHome = environment?.USERPROFILE?.trim() || environment?.HOME?.trim();
  if (envHome && envHome.length > 0) {
    return path.resolve(expandHomePath(envHome));
  }
  return path.resolve(NodeOS.homedir());
});

export const resolveMuseCloudConfigDir = Effect.fn("resolveMuseCloudConfigDir")(function* (
  config: Pick<MuseSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = yield* resolveMuseCloudHomePath(config, environment);
  return path.join(homePath, ".config", "muse-cli");
});

export const makeMuseCloudEnvironment = Effect.fn("makeMuseCloudEnvironment")(function* (
  config: Pick<MuseSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const next: NodeJS.ProcessEnv = {
    ...resolvedBaseEnv,
    [MUSE_CLOUD_NO_UPDATE_CHECK_ENV]: "1",
    // Keep Windows filesystem encoding native for curl_cffi CA paths under non-ASCII user dirs;
    // only force stdio to UTF-8 so Korean names and replies do not mojibake.
    PYTHONIOENCODING: "utf-8",
  };
  if (config.homePath.trim().length > 0) {
    const isolatedHome = yield* resolveMuseCloudHomePath(config, resolvedBaseEnv);
    next.HOME = isolatedHome;
    next.USERPROFILE = isolatedHome;
  }
  return next;
});

export const makeMuseCloudContinuationGroupKey = Effect.fn("makeMuseCloudContinuationGroupKey")(
  function* (
    config: Pick<MuseSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const configDir = yield* resolveMuseCloudConfigDir(config, environment);
    return `muse:cloud:${configDir}`;
  },
);

/**
 * Parse muse.ai cookies from Netscape cookie jar text, `Cookie:` header,
 * JSON object/array, or bare `hatch_sess` token string.
 */
export function parseMuseCloudCookies(rawText: string): ReadonlyArray<MuseCloudCookieEntry> {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  const entries: MuseCloudCookieEntry[] = [];
  const pushCookie = (
    name: string,
    value: string,
    opts?: { domain?: string; path?: string; secure?: boolean; expires?: number },
  ) => {
    const cleanName = name.trim();
    const cleanValue = value.trim();
    if (!cleanName || !cleanValue || /[\r\n\t]/.test(cleanName) || /[\r\n\t]/.test(cleanValue)) {
      return;
    }
    const existingIdx = entries.findIndex((item) => item.name === cleanName);
    const entry: MuseCloudCookieEntry = {
      domain: opts?.domain?.trim() || ".muse.ai",
      path: opts?.path?.trim() || "/",
      secure: opts?.secure ?? true,
      expires:
        typeof opts?.expires === "number" && Number.isFinite(opts.expires) && opts.expires > 0
          ? Math.floor(opts.expires)
          : 0,
      name: cleanName,
      value: cleanValue,
    };
    if (existingIdx >= 0) {
      entries[existingIdx] = entry;
    } else {
      entries.push(entry);
    }
  };

  // 1. JSON format (object map or CDP cookie array)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = decodeUnknownJson(trimmed);
    if (Option.isSome(parsed)) {
      const value = parsed.value;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (!isPlainRecord(item)) continue;
          const name = typeof item.name === "string" ? item.name : "";
          const val = typeof item.value === "string" ? item.value : "";
          const domain = typeof item.domain === "string" ? item.domain : ".muse.ai";
          if (!domain.toLowerCase().includes("muse.ai")) continue;
          const expires =
            typeof item.expires === "number"
              ? item.expires
              : typeof item.expirationDate === "number"
                ? item.expirationDate
                : 0;
          pushCookie(name, val, {
            domain,
            path: typeof item.path === "string" ? item.path : "/",
            secure: typeof item.secure === "boolean" ? item.secure : true,
            expires,
          });
        }
        return entries;
      }
      if (isPlainRecord(value)) {
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === "string") {
            pushCookie(k, v);
          }
        }
        return entries;
      }
    }
  }

  // 2. Netscape cookie jar format (7 tab-separated columns)
  const lines = trimmed.split(/\r?\n/u);
  let matchedNetscape = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
    const normalized = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
    const cols = normalized.split("\t");
    if (cols.length >= 7) {
      matchedNetscape = true;
      const domain = cols[0] ?? ".muse.ai";
      const pathStr = cols[2] ?? "/";
      const secure = (cols[3] ?? "TRUE").toUpperCase() === "TRUE";
      const expiresNum = Number.parseInt(cols[4] ?? "0", 10);
      const name = cols[5] ?? "";
      const val = cols.slice(6).join("\t");
      pushCookie(name, val, {
        domain,
        path: pathStr,
        secure,
        expires: Number.isFinite(expiresNum) ? expiresNum : 0,
      });
    }
  }
  if (matchedNetscape) {
    return entries;
  }

  // 3. `Cookie: a=b; c=d` or `hatch_sess=...`
  const strippedHeader = trimmed.replace(/^cookie\s*:\s*/i, "").trim();
  if (strippedHeader.includes("=")) {
    for (const part of strippedHeader.split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const val = part.slice(eq + 1).trim();
      pushCookie(name, val);
    }
    return entries;
  }

  // 4. Bare `hatch_sess` token string (single non-whitespace token >= 16 chars)
  if (!/\s/.test(strippedHeader) && strippedHeader.length >= 16) {
    pushCookie(MUSE_CLOUD_SESSION_COOKIE, strippedHeader);
  }

  return entries;
}

export function formatMuseNetscapeCookieJar(cookies: ReadonlyArray<MuseCloudCookieEntry>): string {
  const header = "# Netscape HTTP Cookie File\n# Managed by T3 Code for muse.ai\n";
  const rows = cookies.map((cookie) => {
    const domain = cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`;
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expires = cookie.expires > 0 ? String(Math.floor(cookie.expires)) : "0";
    return [
      domain,
      includeSubdomains,
      cookie.path || "/",
      secure,
      expires,
      cookie.name,
      cookie.value,
    ].join("\t");
  });
  return `${header}${rows.join("\n")}\n`;
}

/**
 * Summarize a `muse-cli` cookies file without exposing secret cookie values.
 */
export const readMuseCloudAuthSummary = Effect.fn("readMuseCloudAuthSummary")(function* (
  configDir: string,
): Effect.fn.Return<MuseCloudAuthSummary, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(configDir, MUSE_CLOUD_COOKIES_FILENAME);
  const rawOption = yield* fs.readFileString(filePath).pipe(Effect.option);
  if (Option.isNone(rawOption)) {
    return {
      filePath,
      exists: false,
      authenticated: false,
      expired: false,
      cookieCount: 0,
    };
  }

  const parsed = parseMuseCloudCookies(rawOption.value);
  const sessionCookie = parsed.find((c) => c.name === MUSE_CLOUD_SESSION_COOKIE);
  if (!sessionCookie || sessionCookie.value.length < 8) {
    return {
      filePath,
      exists: true,
      authenticated: false,
      expired: false,
      cookieCount: parsed.length,
    };
  }

  const nowSec = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const expired = sessionCookie.expires > 0 && sessionCookie.expires <= nowSec;

  return {
    filePath,
    exists: true,
    authenticated: !expired,
    expired,
    cookieCount: parsed.length,
  };
});

/**
 * Atomically write Netscape `cookies.txt` (0600) and clear stale `tokens.json`
 * so `muse-cli` refreshes its gateway token from the newly stored session.
 */
export const writeMuseCloudCookiesFile = Effect.fn("writeMuseCloudCookiesFile")(function* (
  configDir: string,
  cookies: ReadonlyArray<MuseCloudCookieEntry>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(configDir, { recursive: true });
  const cookiesPath = path.join(configDir, MUSE_CLOUD_COOKIES_FILENAME);
  const tempPath = `${cookiesPath}.tmp`;
  const content = formatMuseNetscapeCookieJar(cookies);
  yield* fs.writeFileString(tempPath, content);
  yield* fs.chmod(tempPath, 0o600).pipe(Effect.ignore);
  yield* fs.rename(tempPath, cookiesPath);
  yield* fs.chmod(cookiesPath, 0o600).pipe(Effect.ignore);
  yield* fs
    .remove(path.join(configDir, MUSE_CLOUD_TOKENS_FILENAME), { force: true })
    .pipe(Effect.ignore);
  return cookiesPath;
});
