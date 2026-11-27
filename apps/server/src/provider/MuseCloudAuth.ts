// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  MuseSettings,
  ProviderAccountLoginError,
  ProviderDriverKind,
  ProviderInstanceId,
  type MuseCloudAuthBeginInput,
  type MuseCloudAuthBeginResult,
  type MuseCloudAuthCancelInput,
  type MuseCloudAuthCookieInput,
  type MuseCloudAuthWaitInput,
  type ProviderAccountLoginResult,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  MUSE_CLOUD_COOKIES_FILENAME,
  MUSE_CLOUD_NO_UPDATE_CHECK_ENV,
  MUSE_CLOUD_SESSION_COOKIE,
  parseMuseCloudCookies,
  resolveMuseCloudBinaryPath,
  resolveMuseCloudConfigDir,
  writeMuseCloudCookiesFile,
  type MuseCloudCookieEntry,
} from "./Drivers/MuseCloudHome.ts";
import { parseMuseCloudStatusJson, type MuseCloudStatusInfo } from "./Layers/MuseCloudProvider.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const MUSE_DRIVER = ProviderDriverKind.make("muse");
const MUSE_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("muse");
const MUSE_CLOUD_LOGIN_URL = "https://muse.ai/";
const MUSE_CLOUD_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const MUSE_CLOUD_POLL_INTERVAL_MS = 1_200;
const MUSE_CLOUD_CDP_STARTUP_GRACE_MS = 12_000;

const decodeMuseSettingsOption = Schema.decodeUnknownOption(MuseSettings);
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function loginError(detail: string): ProviderAccountLoginError {
  return new ProviderAccountLoginError({ detail });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeMuseConfigSafe(raw: unknown): MuseSettings {
  const decoded = decodeMuseSettingsOption(isPlainRecord(raw) ? raw : {});
  return Option.isSome(decoded) ? decoded.value : Schema.decodeSync(MuseSettings)({});
}

export interface SystemBrowserInfo {
  readonly executablePath: string;
  readonly label: string;
}

export function findSystemChromiumExecutable(): SystemBrowserInfo | undefined {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const candidates: ReadonlyArray<SystemBrowserInfo> =
    process.platform === "win32"
      ? [
          {
            executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            label: "Google Chrome",
          },
          {
            executablePath: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            label: "Google Chrome",
          },
          ...(localAppData
            ? [
                {
                  executablePath: NodePath.join(
                    localAppData,
                    "Google\\Chrome\\Application\\chrome.exe",
                  ),
                  label: "Google Chrome",
                },
              ]
            : []),
          {
            executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            label: "Microsoft Edge",
          },
          {
            executablePath: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            label: "Microsoft Edge",
          },
          ...(localAppData
            ? [
                {
                  executablePath: NodePath.join(
                    localAppData,
                    "Microsoft\\Edge\\Application\\msedge.exe",
                  ),
                  label: "Microsoft Edge",
                },
              ]
            : []),
          {
            executablePath:
              "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
            label: "Brave Browser",
          },
        ]
      : process.platform === "darwin"
        ? [
            {
              executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              label: "Google Chrome",
            },
            {
              executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
              label: "Microsoft Edge",
            },
            {
              executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
              label: "Brave Browser",
            },
          ]
        : [
            { executablePath: "/usr/bin/google-chrome", label: "Google Chrome" },
            { executablePath: "/usr/bin/google-chrome-stable", label: "Google Chrome" },
            { executablePath: "/usr/bin/chromium", label: "Chromium" },
            { executablePath: "/usr/bin/chromium-browser", label: "Chromium" },
          ];

  for (const candidate of candidates) {
    try {
      if (NodeFs.existsSync(candidate.executablePath)) {
        return candidate;
      }
    } catch {
      // Continue search.
    }
  }
  return undefined;
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Could not allocate loopback port")));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });
}

function httpGetJsonLoopback(port: number, urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = NodeHttp.get(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        timeout: 3_000,
        headers: { Connection: "close" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const decoded = decodeUnknownJson(body);
          if (Option.isSome(decoded)) {
            resolve(decoded.value);
          } else {
            reject(new Error("Invalid JSON from CDP endpoint"));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("CDP HTTP timeout"));
    });
  });
}

function assertLoopbackWsUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
  ) {
    throw new Error("Refusing non-loopback CDP WebSocket URL");
  }
  return wsUrl;
}

function cdpRequest(wsUrl: string, method: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const safeUrl = assertLoopbackWsUrl(wsUrl);
    const ws = new WebSocket(safeUrl);
    const timeoutSignal = AbortSignal.timeout(4_000);
    let settled = false;
    const onTimeout = () => {
      done(() => reject(new Error(`CDP ${method} timed out`)));
    };
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      timeoutSignal.removeEventListener("abort", onTimeout);
      try {
        ws.close();
      } catch {
        // Ignore close race.
      }
      fn();
    };
    timeoutSignal.addEventListener("abort", onTimeout, { once: true });

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params: {} }));
    });
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const parsed = decodeUnknownJson(raw);
      if (Option.isNone(parsed) || !isPlainRecord(parsed.value)) return;
      const msg = parsed.value;
      if (msg.id !== 1) return;
      if (isPlainRecord(msg.error)) {
        const errMessage =
          typeof msg.error.message === "string" ? msg.error.message : `CDP ${method} failed`;
        done(() => reject(new Error(errMessage)));
      } else {
        done(() => resolve(msg.result));
      }
    });
    ws.addEventListener("error", () => {
      done(() => reject(new Error(`CDP WebSocket error on ${method}`)));
    });
  });
}

export type MuseCdpProbeResult =
  | { readonly reachable: false }
  | {
      readonly reachable: true;
      readonly cookies?: ReadonlyArray<MuseCloudCookieEntry>;
    };

/**
 * Probe a local Chromium CDP endpoint (`127.0.0.1:<port>`).
 * Distinguishes between "browser CDP unreachable/closed" and
 * "browser alive, waiting for user to finish Google login".
 */
export async function probeMuseCdp(port: number, nowSec: number): Promise<MuseCdpProbeResult> {
  let versionInfo: unknown;
  try {
    versionInfo = await httpGetJsonLoopback(port, "/json/version");
  } catch {
    return { reachable: false };
  }
  if (!isPlainRecord(versionInfo) || typeof versionInfo.webSocketDebuggerUrl !== "string") {
    return { reachable: false };
  }
  const wsUrl = versionInfo.webSocketDebuggerUrl;
  let result: unknown;
  try {
    result = await cdpRequest(wsUrl, "Storage.getCookies");
  } catch {
    try {
      result = await cdpRequest(wsUrl, "Network.getAllCookies");
    } catch {
      return { reachable: false };
    }
  }
  if (!isPlainRecord(result) || !Array.isArray(result.cookies)) {
    return { reachable: true };
  }

  const museCookies: MuseCloudCookieEntry[] = [];
  for (const rawCookie of result.cookies) {
    if (!isPlainRecord(rawCookie)) continue;
    const domain = typeof rawCookie.domain === "string" ? rawCookie.domain.trim() : "";
    if (!domain.toLowerCase().endsWith("muse.ai")) continue;
    const name = typeof rawCookie.name === "string" ? rawCookie.name.trim() : "";
    const value = typeof rawCookie.value === "string" ? rawCookie.value.trim() : "";
    if (!name || !value) continue;
    const expires =
      typeof rawCookie.expires === "number" &&
      Number.isFinite(rawCookie.expires) &&
      rawCookie.expires > 0
        ? Math.floor(rawCookie.expires)
        : 0;
    museCookies.push({
      domain,
      path: typeof rawCookie.path === "string" ? rawCookie.path : "/",
      secure: typeof rawCookie.secure === "boolean" ? rawCookie.secure : true,
      expires,
      name,
      value,
    });
  }

  const hatch = museCookies.find((c) => c.name === MUSE_CLOUD_SESSION_COOKIE);
  if (!hatch || hatch.value.length < 16) {
    return { reachable: true };
  }
  if (hatch.expires > 0 && hatch.expires <= nowSec) {
    return { reachable: true };
  }
  return { reachable: true, cookies: museCookies };
}

/**
 * Poll a local Chromium CDP endpoint (`127.0.0.1:<port>`) for `muse.ai` cookies.
 * Returns only `muse.ai` cookies when a valid `hatch_sess` cookie is present.
 */
export async function pollMuseCookiesFromCdp(
  port: number,
  nowSec: number,
): Promise<ReadonlyArray<MuseCloudCookieEntry> | undefined> {
  const probed = await probeMuseCdp(port, nowSec);
  return probed.reachable ? probed.cookies : undefined;
}

/**
 * Ask a Chromium browser listening on loopback CDP to exit gracefully via `Browser.close`.
 * Works even when Chromium auto-de-elevated into a separate child process on Windows.
 */
export async function closeCdpBrowserQuietly(port: number): Promise<void> {
  try {
    const versionInfo = await httpGetJsonLoopback(port, "/json/version");
    if (!isPlainRecord(versionInfo) || typeof versionInfo.webSocketDebuggerUrl !== "string") {
      return;
    }
    await cdpRequest(versionInfo.webSocketDebuggerUrl, "Browser.close");
  } catch {
    // Ignore when already closed or unreachable.
  }
}

interface ResolvedCloudTarget {
  readonly instanceId: ProviderInstanceId;
  readonly isReauth: boolean;
  readonly existingInstance?: ProviderInstanceConfig;
  readonly targetHomePath: string;
  readonly targetConfigDir: string;
  readonly persistHomePath: boolean;
  readonly createdDedicatedHome: boolean;
  readonly cloudBinaryPath: string;
  readonly displayNameOverride?: string;
  readonly accentColorOverride?: string;
}

function resolveConfiguredCloudBinary(
  allSettings: ServerSettings,
  existingInstance?: ProviderInstanceConfig,
): string {
  const instanceBinary =
    existingInstance && isPlainRecord(existingInstance.config)
      ? typeof existingInstance.config.cloudBinaryPath === "string"
        ? existingInstance.config.cloudBinaryPath.trim()
        : ""
      : "";
  if (instanceBinary.length > 0) return instanceBinary;
  const defaultBinary = allSettings.providers.muse.cloudBinaryPath?.trim() ?? "";
  return defaultBinary.length > 0 ? defaultBinary : "muse-cli";
}

const resolveMuseCloudTarget = Effect.fn("resolveMuseCloudTarget")(function* (
  allSettings: ServerSettings,
  stateDir: string,
  input: {
    readonly instanceId?: ProviderInstanceId | undefined;
    readonly displayName?: string | undefined;
    readonly accentColor?: string | undefined;
    readonly homePath?: string | undefined;
  },
): Effect.fn.Return<ResolvedCloudTarget, ProviderAccountLoginError, Path.Path> {
  const path = yield* Path.Path;
  const requestedHomePath = input.homePath?.trim() ?? "";

  if (input.instanceId !== undefined) {
    const instanceId = input.instanceId;
    const existingInstance = allSettings.providerInstances[instanceId];
    const isDefaultSlot = String(instanceId) === String(MUSE_DEFAULT_INSTANCE_ID);
    if (!existingInstance && !isDefaultSlot) {
      return yield* loginError(`지정한 muse.ai 계정('${instanceId}')을 찾을 수 없습니다.`);
    }
    if (existingInstance && existingInstance.driver !== MUSE_DRIVER) {
      return yield* loginError(`'${instanceId}'은(는) Muse 계정이 아닙니다.`);
    }
    const existingConfig = existingInstance
      ? decodeMuseConfigSafe(existingInstance.config)
      : allSettings.providers.muse;
    const existingEnv = mergeProviderInstanceEnvironment(existingInstance?.environment);

    let targetHomePath: string;
    let targetConfigDir: string;
    let persistHomePath: boolean;
    let createdDedicatedHome = false;

    if (requestedHomePath.length > 0) {
      targetHomePath = path.resolve(expandHomePath(requestedHomePath));
      targetConfigDir = path.join(targetHomePath, ".config", "muse-cli");
      persistHomePath = true;
    } else if (existingConfig.homePath.trim().length > 0) {
      targetHomePath = path.resolve(expandHomePath(existingConfig.homePath));
      targetConfigDir = path.join(targetHomePath, ".config", "muse-cli");
      persistHomePath = true;
    } else {
      targetHomePath = path.join(stateDir, "provider-instances", String(instanceId), "muse-cloud");
      targetConfigDir = yield* resolveMuseCloudConfigDir({ homePath: targetHomePath }, existingEnv);
      persistHomePath = true;
      createdDedicatedHome = true;
    }

    return {
      instanceId,
      isReauth: true,
      ...(existingInstance ? { existingInstance } : {}),
      targetHomePath,
      targetConfigDir,
      persistHomePath,
      createdDedicatedHome,
      cloudBinaryPath: resolveConfiguredCloudBinary(allSettings, existingInstance),
      ...(input.displayName?.trim() ? { displayNameOverride: input.displayName.trim() } : {}),
      ...(input.accentColor?.trim() ? { accentColorOverride: input.accentColor.trim() } : {}),
    } satisfies ResolvedCloudTarget;
  }

  const instanceId = ProviderInstanceId.make(`muse_cloud_${NodeCrypto.randomUUID().slice(0, 8)}`);
  if (allSettings.providerInstances[instanceId]) {
    return yield* loginError(`인스턴스 '${instanceId}'가 이미 있습니다. 다시 시도하세요.`);
  }
  const targetHomePath =
    requestedHomePath.length > 0
      ? path.resolve(expandHomePath(requestedHomePath))
      : path.join(stateDir, "provider-instances", String(instanceId), "muse-cloud");
  const targetConfigDir = path.join(targetHomePath, ".config", "muse-cli");

  return {
    instanceId,
    isReauth: false,
    targetHomePath,
    targetConfigDir,
    persistHomePath: true,
    createdDedicatedHome: requestedHomePath.length === 0,
    cloudBinaryPath: resolveConfiguredCloudBinary(allSettings),
    ...(input.displayName?.trim() ? { displayNameOverride: input.displayName.trim() } : {}),
    ...(input.accentColor?.trim() ? { accentColorOverride: input.accentColor.trim() } : {}),
  } satisfies ResolvedCloudTarget;
});

function verifyMuseCloudStatusWithCli(input: {
  readonly cloudBinaryPath: string;
  readonly targetHomePath: string;
  readonly baseEnv: NodeJS.ProcessEnv;
}): Promise<{
  readonly ok: boolean;
  readonly info?: MuseCloudStatusInfo;
  readonly detail?: string;
}> {
  return new Promise((resolve) => {
    const resolved = resolveMuseCloudBinaryPath(input.cloudBinaryPath);
    const isScript = /\.[cm]?js$/i.test(resolved);
    const cmd = isScript ? process.execPath : resolved;
    const args = [...(isScript ? [resolved] : []), "status"];
    const child = NodeChildProcess.spawn(cmd, args, {
      env: {
        ...input.baseEnv,
        ...(isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        HOME: input.targetHomePath,
        USERPROFILE: input.targetHomePath,
        [MUSE_CLOUD_NO_UPDATE_CHECK_ENV]: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutSignal = AbortSignal.timeout(15_000);
    const finish = (result: {
      readonly ok: boolean;
      readonly info?: MuseCloudStatusInfo;
      readonly detail?: string;
    }) => {
      if (settled) return;
      settled = true;
      timeoutSignal.removeEventListener("abort", onTimeout);
      resolve(result);
    };
    const onTimeout = () => {
      try {
        child.kill();
      } catch {
        // Ignore.
      }
      finish({ ok: false, detail: "muse-cli status 검증 시간이 초과되었습니다." });
    };
    timeoutSignal.addEventListener("abort", onTimeout, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ ok: false, detail: `muse-cli 실행 실패: ${err.message}` });
    });
    child.on("close", (code) => {
      if (code === 0) {
        const info = parseMuseCloudStatusJson(stdout);
        finish(info ? { ok: true, info } : { ok: true });
      } else {
        const msg = (stderr || stdout).trim().slice(0, 260);
        finish({
          ok: false,
          detail: msg || `muse-cli status 실패 (종료 코드 ${code ?? -1})`,
        });
      }
    });
  });
}

const saveAuthenticatedMuseCloudInstance = Effect.fn("saveAuthenticatedMuseCloudInstance")(
  function* (
    settings: ServerSettingsService["Service"],
    target: ResolvedCloudTarget,
    statusInfo: MuseCloudStatusInfo | undefined,
  ): Effect.fn.Return<ProviderAccountLoginResult, ProviderAccountLoginError> {
    const email = statusInfo?.email?.trim() || undefined;
    const existingConfigRecord =
      target.existingInstance && isPlainRecord(target.existingInstance.config)
        ? { ...target.existingInstance.config }
        : {};
    existingConfigRecord.backendMode = "cloud";
    if (target.cloudBinaryPath && target.cloudBinaryPath !== "muse-cli") {
      existingConfigRecord.cloudBinaryPath = target.cloudBinaryPath;
    }
    if (target.persistHomePath && target.targetHomePath.length > 0) {
      existingConfigRecord.homePath = target.targetHomePath;
    }

    const cleanProfileName =
      statusInfo?.displayName && !statusInfo.displayName.includes("\uFFFD")
        ? statusInfo.displayName
        : undefined;
    const existingCleanDisplayName =
      target.existingInstance?.displayName?.trim() &&
      !target.existingInstance.displayName.includes("\uFFFD")
        ? target.existingInstance.displayName.trim()
        : undefined;
    const resolvedDisplayName =
      target.displayNameOverride ??
      existingCleanDisplayName ??
      (email
        ? `Muse Cloud (${email})`
        : cleanProfileName
          ? `Muse Cloud (${cleanProfileName})`
          : "Muse Cloud");
    const resolvedAccentColor = target.accentColorOverride ?? target.existingInstance?.accentColor;

    yield* settings
      .updateSettings({
        providerInstancesToUpsert: {
          [target.instanceId]: {
            driver: MUSE_DRIVER,
            enabled: true,
            displayName: resolvedDisplayName,
            ...(resolvedAccentColor ? { accentColor: resolvedAccentColor } : {}),
            ...(target.existingInstance?.environment
              ? { environment: target.existingInstance.environment }
              : {}),
            config: existingConfigRecord,
          },
        },
      })
      .pipe(
        Effect.mapError(() =>
          loginError("로그인은 성공했지만 muse.ai 클라우드 계정을 저장하지 못했습니다."),
        ),
      );

    return {
      instanceId: target.instanceId,
      driver: MUSE_DRIVER,
      ...(email ? { email } : {}),
      displayName: resolvedDisplayName,
      homePath: target.targetHomePath,
    };
  },
);

interface ActiveMuseCloudSession {
  readonly id: string;
  readonly target: ResolvedCloudTarget;
  readonly port: number;
  readonly profileDir: string;
  readonly browser: NodeChildProcess.ChildProcess;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  browserExited: boolean;
  cancelled: boolean;
  cleaned: boolean;
  timeoutFiber: Fiber.Fiber<void, never> | undefined;
}

const activeMuseCloudSessions = new Map<string, ActiveMuseCloudSession>();

function killProcessQuietly(child: NodeChildProcess.ChildProcess): void {
  try {
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
  } catch {
    // Ignore.
  }
}

const disposeMuseCloudSession = (
  fs: FileSystem.FileSystem,
  session: ActiveMuseCloudSession,
  options: { readonly removeCreatedHome: boolean; readonly markCancelled?: boolean },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fiberToInterrupt = yield* Effect.sync(() => {
      if (session.cleaned) return null;
      session.cleaned = true;
      if (options.markCancelled) {
        session.cancelled = true;
      }
      const fiber = session.timeoutFiber;
      session.timeoutFiber = undefined;
      activeMuseCloudSessions.delete(session.id);
      return fiber ?? undefined;
    });
    if (fiberToInterrupt === null) return;
    if (fiberToInterrupt !== undefined) {
      yield* Fiber.interrupt(fiberToInterrupt).pipe(Effect.ignore);
    }
    yield* Effect.promise(() => closeCdpBrowserQuietly(session.port)).pipe(
      Effect.timeoutOption(Duration.millis(2_000)),
      Effect.ignore,
    );
    yield* Effect.sync(() => {
      killProcessQuietly(session.browser);
    });
    // Give the browser a moment to release lock files before removing the temp profile.
    yield* Effect.sleep(Duration.millis(500));
    yield* fs.remove(session.profileDir, { recursive: true, force: true }).pipe(Effect.ignore);
    if (options.removeCreatedHome && session.target.createdDedicatedHome) {
      yield* fs
        .remove(session.target.targetHomePath, { recursive: true, force: true })
        .pipe(Effect.ignore);
    }
  });

/**
 * Open a clean, isolated system Chrome/Edge window (without `--enable-automation`
 * so Google OAuth works natively) pointing at `https://muse.ai/` with a loopback
 * CDP port so T3 can capture the `hatch_sess` cookie automatically after login.
 */
export const beginMuseCloudAuth = Effect.fn("beginMuseCloudAuth")(function* (
  input: MuseCloudAuthBeginInput,
): Effect.fn.Return<
  MuseCloudAuthBeginResult,
  ProviderAccountLoginError,
  ServerSettingsService | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const settings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const browserInfo = findSystemChromiumExecutable();
  if (!browserInfo) {
    return yield* loginError(
      "시스템에서 Google Chrome 또는 Microsoft Edge를 찾지 못했습니다. 아래 '쿠키 직접 입력' 방식으로 muse.ai 계정을 연결해 주세요.",
    );
  }

  const allSettings = yield* settings.getSettings.pipe(
    Effect.mapError(() => loginError("설정을 읽지 못했습니다.")),
  );
  const target = yield* resolveMuseCloudTarget(allSettings, serverConfig.stateDir, input);

  // Clean up any existing cloud login session for the same target.
  for (const existing of Array.from(activeMuseCloudSessions.values())) {
    if (existing.target.instanceId === target.instanceId) {
      yield* disposeMuseCloudSession(fs, existing, {
        removeCreatedHome: !target.isReauth,
        markCancelled: true,
      });
    }
  }

  const port = yield* Effect.tryPromise({
    try: () => allocateLoopbackPort(),
    catch: (cause) => loginError(`로컬 로그인 포트를 할당하지 못했습니다: ${String(cause)}`),
  });

  const sessionId = NodeCrypto.randomUUID();
  const profileDir = path.join(NodeOS.tmpdir(), `t3-muse-cloud-login-${sessionId.slice(0, 8)}`);
  yield* fs
    .makeDirectory(profileDir, { recursive: true })
    .pipe(Effect.mapError(() => loginError("임시 브라우저 프로필 폴더를 만들지 못했습니다.")));
  yield* fs
    .makeDirectory(target.targetConfigDir, { recursive: true })
    .pipe(Effect.mapError(() => loginError("muse.ai 설정 폴더를 만들지 못했습니다.")));

  const browser = yield* Effect.try({
    try: () =>
      NodeChildProcess.spawn(
        browserInfo.executablePath,
        [
          ...(process.platform === "win32" ? ["--do-not-de-elevate"] : []),
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--new-window",
          MUSE_CLOUD_LOGIN_URL,
        ],
        {
          stdio: "ignore",
          detached: false,
        },
      ),
    catch: (cause) =>
      loginError(`${browserInfo.label} 브라우저를 실행하지 못했습니다: ${String(cause)}`),
  });

  const startedAt = yield* DateTime.now;
  const startedAtMs = DateTime.toEpochMillis(startedAt);
  const expiresAtDate = DateTime.add(startedAt, { minutes: 5 });
  const expiresAt = DateTime.formatIso(expiresAtDate);
  const expiresAtMs = DateTime.toEpochMillis(expiresAtDate);

  const session: ActiveMuseCloudSession = {
    id: sessionId,
    target,
    port,
    profileDir,
    browser,
    startedAtMs,
    expiresAtMs,
    browserExited: false,
    cancelled: false,
    cleaned: false,
    timeoutFiber: undefined,
  };

  browser.on("exit", () => {
    session.browserExited = true;
  });

  activeMuseCloudSessions.set(sessionId, session);
  session.timeoutFiber = yield* Effect.sleep(Duration.millis(MUSE_CLOUD_LOGIN_TIMEOUT_MS)).pipe(
    Effect.andThen(
      disposeMuseCloudSession(fs, session, {
        removeCreatedHome: true,
        markCancelled: true,
      }),
    ),
    Effect.forkDetach,
  );

  return {
    sessionId,
    instanceId: target.instanceId,
    loginUrl: MUSE_CLOUD_LOGIN_URL,
    browserLabel: browserInfo.label,
    expiresAt,
  };
});

export const waitMuseCloudAuth = Effect.fn("waitMuseCloudAuth")(function* (
  input: MuseCloudAuthWaitInput,
): Effect.fn.Return<
  ProviderAccountLoginResult,
  ProviderAccountLoginError,
  ServerSettingsService | FileSystem.FileSystem | Path.Path
> {
  const settings = yield* ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;

  const session = activeMuseCloudSessions.get(input.sessionId);
  if (!session) {
    return yield* loginError("진행 중인 muse.ai 로그인 세션을 찾을 수 없습니다. 다시 시도하세요.");
  }

  let verifiedInfo: MuseCloudStatusInfo | undefined;
  let captured = false;
  let cdpEverConnected = false;
  let cdpMissedAfterConnect = 0;

  while (!captured) {
    if (session.cancelled) {
      return yield* loginError("muse.ai Google 로그인이 취소되었습니다.");
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs >= session.expiresAtMs) {
      yield* disposeMuseCloudSession(fs, session, { removeCreatedHome: true, markCancelled: true });
      return yield* loginError("muse.ai 로그인 대기 시간(5분)이 만료되었습니다. 다시 시도하세요.");
    }

    const probe = yield* Effect.promise(() => probeMuseCdp(session.port, Math.floor(nowMs / 1000)));

    if (probe.reachable) {
      cdpEverConnected = true;
      cdpMissedAfterConnect = 0;

      if (probe.cookies && probe.cookies.length > 0) {
        yield* writeMuseCloudCookiesFile(session.target.targetConfigDir, probe.cookies).pipe(
          Effect.mapError(() => loginError("muse.ai 쿠키 파일을 저장하지 못했습니다.")),
        );
        const baseEnv = mergeProviderInstanceEnvironment(
          session.target.existingInstance?.environment,
        );
        const check = yield* Effect.promise(() =>
          verifyMuseCloudStatusWithCli({
            cloudBinaryPath: session.target.cloudBinaryPath,
            targetHomePath: session.target.targetHomePath,
            baseEnv,
          }),
        );
        if (check.ok) {
          verifiedInfo = check.info;
          captured = true;
          break;
        }
      }
    } else if (cdpEverConnected) {
      cdpMissedAfterConnect += 1;
      if ((session.browserExited && cdpMissedAfterConnect >= 2) || cdpMissedAfterConnect >= 4) {
        yield* disposeMuseCloudSession(fs, session, {
          removeCreatedHome: true,
          markCancelled: true,
        });
        return yield* loginError(
          "로그인을 마치기 전에 브라우저 창이 닫혔습니다. 다시 시도하거나 '쿠키 직접 입력'을 사용하세요.",
        );
      }
    } else if (
      session.browserExited &&
      nowMs - session.startedAtMs >= MUSE_CLOUD_CDP_STARTUP_GRACE_MS
    ) {
      yield* disposeMuseCloudSession(fs, session, {
        removeCreatedHome: true,
        markCancelled: true,
      });
      return yield* loginError(
        "로그인 브라우저 디버깅 포트에 연결하지 못했거나 창이 먼저 닫혔습니다. 다시 시도하거나 아래 '수동 백업: 쿠키 직접 붙여넣기'를 사용하세요.",
      );
    }

    yield* Effect.sleep(Duration.millis(MUSE_CLOUD_POLL_INTERVAL_MS));
  }

  yield* disposeMuseCloudSession(fs, session, { removeCreatedHome: false });
  return yield* saveAuthenticatedMuseCloudInstance(settings, session.target, verifiedInfo);
});

export const cancelMuseCloudAuth = Effect.fn("cancelMuseCloudAuth")(function* (
  input: MuseCloudAuthCancelInput,
): Effect.fn.Return<Record<string, never>, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const session = activeMuseCloudSessions.get(input.sessionId);
  if (session) {
    yield* disposeMuseCloudSession(fs, session, {
      removeCreatedHome: true,
      markCancelled: true,
    });
  }
  return {};
});

export const importMuseCloudCookies = Effect.fn("importMuseCloudCookies")(function* (
  input: MuseCloudAuthCookieInput,
): Effect.fn.Return<
  ProviderAccountLoginResult,
  ProviderAccountLoginError,
  ServerSettingsService | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const settings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const parsedCookies = parseMuseCloudCookies(input.cookies);
  const hatch = parsedCookies.find((c) => c.name === MUSE_CLOUD_SESSION_COOKIE);
  if (!hatch || hatch.value.length < 16) {
    return yield* loginError(
      "유효한 `hatch_sess` 쿠키를 찾지 못했습니다. muse.ai에서 Google 로그인 후 개발자 도구(Application → Cookies → https://muse.ai)에서 `hatch_sess` 값을 복사해 붙여 넣으세요.",
    );
  }

  const allSettings = yield* settings.getSettings.pipe(
    Effect.mapError(() => loginError("설정을 읽지 못했습니다.")),
  );
  const target = yield* resolveMuseCloudTarget(allSettings, serverConfig.stateDir, input);

  const cookiesPath = path.join(target.targetConfigDir, MUSE_CLOUD_COOKIES_FILENAME);
  const previousCookies = yield* fs.readFileString(cookiesPath).pipe(Effect.option);

  yield* writeMuseCloudCookiesFile(target.targetConfigDir, parsedCookies).pipe(
    Effect.mapError(() => loginError("muse.ai 쿠키 파일을 저장하지 못했습니다.")),
  );

  const baseEnv = mergeProviderInstanceEnvironment(target.existingInstance?.environment);
  const check = yield* Effect.promise(() =>
    verifyMuseCloudStatusWithCli({
      cloudBinaryPath: target.cloudBinaryPath,
      targetHomePath: target.targetHomePath,
      baseEnv,
    }),
  );

  if (!check.ok) {
    if (Option.isSome(previousCookies)) {
      yield* fs.writeFileString(cookiesPath, previousCookies.value).pipe(Effect.ignore);
    } else if (target.createdDedicatedHome) {
      yield* fs.remove(target.targetHomePath, { recursive: true, force: true }).pipe(Effect.ignore);
    }
    return yield* loginError(
      `muse.ai 쿠키 인증 확인에 실패했습니다: ${check.detail ?? "만료되었거나 잘못된 쿠키입니다."}`,
    );
  }

  return yield* saveAuthenticatedMuseCloudInstance(settings, target, check.info);
});
