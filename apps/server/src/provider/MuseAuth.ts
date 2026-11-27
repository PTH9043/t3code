// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import {
  MuseSettings,
  ProviderAccountLoginError,
  ProviderDriverKind,
  ProviderInstanceId,
  type MuseAuthBeginInput,
  type MuseAuthBeginResult,
  type MuseAuthCancelInput,
  type MuseAuthWaitInput,
  type ProviderAccountLoginResult,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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
  MUSE_API_KEY_ENV,
  MUSE_LOGIN_ENV,
  MUSE_NO_AUTO_UPDATE_ENV,
  normalizeMuseEmail,
  readMuseAuthSummary,
  resolveMuseBinaryPath,
  resolveMuseConfigDir,
  type MuseAuthSummary,
} from "./Drivers/MuseHome.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const MUSE_DRIVER = ProviderDriverKind.make("muse");
const MUSE_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("muse");
const MUSE_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MUSE_PROMPT_TIMEOUT_MS = 30 * 1000;

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

export interface MuseElicitationPrompt {
  readonly requestId: string | number;
  readonly verificationUrl: string;
  readonly userCode?: string;
}

/**
 * Parse a JSON-RPC `elicitation/create` request emitted by `muse acp` during
 * `authenticate({ methodId: "muse-login" })`.
 */
export function extractMuseElicitationPrompt(message: unknown): MuseElicitationPrompt | undefined {
  if (!isPlainRecord(message)) return undefined;
  if (message.method !== "elicitation/create") return undefined;
  const reqId = message.id;
  if (typeof reqId !== "number" && typeof reqId !== "string") return undefined;
  const params = message.params;
  if (!isPlainRecord(params)) return undefined;
  const rawUrl = typeof params.url === "string" ? params.url.trim() : "";
  if (!rawUrl.startsWith("https://")) return undefined;

  let userCode: string | undefined;
  try {
    const parsedUrl = new URL(rawUrl);
    const queryCode = parsedUrl.searchParams.get("code") ?? parsedUrl.searchParams.get("user_code");
    if (queryCode && queryCode.trim().length >= 4) {
      userCode = queryCode.trim().toUpperCase();
    }
  } catch {
    return undefined;
  }

  if (!userCode && typeof params.message === "string") {
    const match = /\bcode\s+([A-Z0-9]{3,16}(?:-[A-Z0-9]{2,16})+|[A-Z0-9]{6,16})\b/i.exec(
      params.message,
    );
    if (match?.[1]) {
      userCode = match[1].trim().toUpperCase();
    }
  }

  return {
    requestId: reqId,
    verificationUrl: rawUrl,
    ...(userCode ? { userCode } : {}),
  };
}

interface ResolvedMuseTarget {
  readonly instanceId: ProviderInstanceId;
  readonly isReauth: boolean;
  readonly existingInstance?: ProviderInstanceConfig;
  readonly targetHomePath: string;
  readonly targetConfigDir: string;
  readonly persistHomePath: boolean;
  readonly createdDedicatedHome: boolean;
  readonly binaryPath: string;
  readonly displayNameOverride?: string;
  readonly accentColorOverride?: string;
}

function resolveConfiguredMuseBinary(
  allSettings: ServerSettings,
  existingInstance?: ProviderInstanceConfig,
): string {
  const instanceBinary =
    existingInstance && isPlainRecord(existingInstance.config)
      ? typeof existingInstance.config.binaryPath === "string"
        ? existingInstance.config.binaryPath.trim()
        : ""
      : "";
  if (instanceBinary.length > 0) {
    return instanceBinary;
  }
  const defaultBinary = allSettings.providers.muse.binaryPath.trim();
  return defaultBinary.length > 0 ? defaultBinary : "muse";
}

const resolveMuseLoginTarget = Effect.fn("resolveMuseLoginTarget")(function* (
  allSettings: ServerSettings,
  stateDir: string,
  input: MuseAuthBeginInput,
): Effect.fn.Return<ResolvedMuseTarget, ProviderAccountLoginError, Path.Path> {
  const path = yield* Path.Path;
  const requestedHomePath = input.homePath?.trim() ?? "";

  if (input.instanceId !== undefined) {
    const instanceId = input.instanceId;
    const existingInstance = allSettings.providerInstances[instanceId];
    const isDefaultSlot = String(instanceId) === String(MUSE_DEFAULT_INSTANCE_ID);
    if (!existingInstance && !isDefaultSlot) {
      return yield* loginError(`지정한 Muse 계정('${instanceId}')을 찾을 수 없습니다.`);
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
      targetConfigDir = path.join(targetHomePath, "config", "muse");
      persistHomePath = true;
    } else if (existingConfig.homePath.trim().length > 0) {
      targetHomePath = path.resolve(expandHomePath(existingConfig.homePath));
      targetConfigDir = path.join(targetHomePath, "config", "muse");
      persistHomePath = true;
    } else if (isDefaultSlot) {
      targetHomePath = "";
      targetConfigDir = yield* resolveMuseConfigDir(existingConfig, existingEnv);
      persistHomePath = false;
    } else {
      targetHomePath = path.join(stateDir, "provider-instances", String(instanceId), "muse-home");
      targetConfigDir = path.join(targetHomePath, "config", "muse");
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
      binaryPath: resolveConfiguredMuseBinary(allSettings, existingInstance),
      ...(input.displayName?.trim() ? { displayNameOverride: input.displayName.trim() } : {}),
      ...(input.accentColor?.trim() ? { accentColorOverride: input.accentColor.trim() } : {}),
    } satisfies ResolvedMuseTarget;
  }

  const instanceId = ProviderInstanceId.make(`muse_${NodeCrypto.randomUUID().slice(0, 8)}`);
  if (allSettings.providerInstances[instanceId]) {
    return yield* loginError(`인스턴스 '${instanceId}'가 이미 있습니다. 다시 시도하세요.`);
  }
  const targetHomePath =
    requestedHomePath.length > 0
      ? path.resolve(expandHomePath(requestedHomePath))
      : path.join(stateDir, "provider-instances", String(instanceId), "muse-home");
  const targetConfigDir = path.join(targetHomePath, "config", "muse");

  return {
    instanceId,
    isReauth: false,
    targetHomePath,
    targetConfigDir,
    persistHomePath: true,
    createdDedicatedHome: requestedHomePath.length === 0,
    binaryPath: resolveConfiguredMuseBinary(allSettings),
    ...(input.displayName?.trim() ? { displayNameOverride: input.displayName.trim() } : {}),
    ...(input.accentColor?.trim() ? { accentColorOverride: input.accentColor.trim() } : {}),
  } satisfies ResolvedMuseTarget;
});

function buildMuseLoginEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  target: Pick<ResolvedMuseTarget, "persistHomePath" | "targetHomePath">,
  path: Path.Path,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...baseEnv,
    [MUSE_NO_AUTO_UPDATE_ENV]: "1",
    [MUSE_LOGIN_ENV]: "0",
  };
  delete next[MUSE_API_KEY_ENV];
  if (target.persistHomePath && target.targetHomePath.length > 0) {
    next.XDG_CONFIG_HOME = path.join(target.targetHomePath, "config");
    next.XDG_DATA_HOME = path.join(target.targetHomePath, "data");
    next.XDG_STATE_HOME = path.join(target.targetHomePath, "state");
  }
  return next;
}

const cleanupCreatedMuseHomeIfNeeded = (
  fs: FileSystem.FileSystem,
  target: Pick<ResolvedMuseTarget, "createdDedicatedHome" | "targetHomePath">,
): Effect.Effect<void> =>
  target.createdDedicatedHome && target.targetHomePath.length > 0
    ? fs.remove(target.targetHomePath, { recursive: true, force: true }).pipe(Effect.ignore)
    : Effect.void;

interface DuplicateMuseAccountMatch {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly email?: string;
}

const findDuplicateMuseAccount = Effect.fn("findDuplicateMuseAccount")(function* (
  allSettings: ServerSettings,
  candidate: MuseAuthSummary,
  excludeInstanceId: ProviderInstanceId,
) {
  const candidateEmail = normalizeMuseEmail(candidate.email);
  const candidateUserId = candidate.userId?.trim() || undefined;
  if (!candidateEmail && !candidateUserId) {
    return undefined as DuplicateMuseAccountMatch | undefined;
  }

  const entries: Array<{
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string;
    readonly config: MuseSettings;
    readonly environment?: ProviderInstanceConfig["environment"];
  }> = [];

  if (String(excludeInstanceId) !== String(MUSE_DEFAULT_INSTANCE_ID)) {
    const defaultOverride = allSettings.providerInstances[MUSE_DEFAULT_INSTANCE_ID];
    entries.push({
      instanceId: MUSE_DEFAULT_INSTANCE_ID,
      displayName: defaultOverride?.displayName?.trim() || "Muse",
      config: defaultOverride
        ? decodeMuseConfigSafe(defaultOverride.config)
        : allSettings.providers.muse,
      ...(defaultOverride?.environment ? { environment: defaultOverride.environment } : {}),
    });
  }

  for (const [rawId, instance] of Object.entries(allSettings.providerInstances)) {
    if (instance.driver !== MUSE_DRIVER) continue;
    if (rawId === String(excludeInstanceId) || rawId === String(MUSE_DEFAULT_INSTANCE_ID)) continue;
    entries.push({
      instanceId: ProviderInstanceId.make(rawId),
      displayName: instance.displayName?.trim() || rawId,
      config: decodeMuseConfigSafe(instance.config),
      ...(instance.environment ? { environment: instance.environment } : {}),
    });
  }

  for (const entry of entries) {
    const env = mergeProviderInstanceEnvironment(entry.environment);
    const configDir = yield* resolveMuseConfigDir(entry.config, env);
    const summary = yield* readMuseAuthSummary(configDir);
    if (!summary.authenticated) continue;
    const otherEmail = normalizeMuseEmail(summary.email);
    const otherUserId = summary.userId?.trim() || undefined;
    const emailMatches = Boolean(candidateEmail && otherEmail && candidateEmail === otherEmail);
    const userIdMatches = Boolean(
      candidateUserId && otherUserId && candidateUserId === otherUserId,
    );
    if (emailMatches || userIdMatches) {
      return {
        instanceId: entry.instanceId,
        displayName: entry.displayName,
        ...(summary.email ? { email: summary.email } : {}),
      } satisfies DuplicateMuseAccountMatch;
    }
  }

  return undefined;
});

const saveAuthenticatedMuseInstance = Effect.fn("saveAuthenticatedMuseInstance")(function* (
  settings: ServerSettingsService["Service"],
  target: ResolvedMuseTarget,
  summary: MuseAuthSummary,
): Effect.fn.Return<ProviderAccountLoginResult, ProviderAccountLoginError> {
  const email = summary.email?.trim() || undefined;
  const isDefaultSlot = String(target.instanceId) === String(MUSE_DEFAULT_INSTANCE_ID);
  const existingConfigRecord =
    target.existingInstance && isPlainRecord(target.existingInstance.config)
      ? { ...target.existingInstance.config }
      : {};
  if (existingConfigRecord.backendMode === "cloud") {
    existingConfigRecord.backendMode = "code";
  }
  if (target.binaryPath && target.binaryPath !== "muse") {
    existingConfigRecord.binaryPath = target.binaryPath;
  }
  if (target.persistHomePath && target.targetHomePath.length > 0) {
    existingConfigRecord.homePath = target.targetHomePath;
  }

  const resolvedDisplayName =
    target.displayNameOverride ??
    target.existingInstance?.displayName?.trim() ??
    (isDefaultSlot
      ? undefined
      : email
        ? `Muse ${email}`
        : summary.fullName
          ? `Muse ${summary.fullName}`
          : "Muse 계정");
  const resolvedAccentColor = target.accentColorOverride ?? target.existingInstance?.accentColor;

  if (
    isDefaultSlot &&
    !target.existingInstance &&
    !target.persistHomePath &&
    !resolvedDisplayName &&
    !resolvedAccentColor
  ) {
    yield* settings
      .updateSettings({
        providers: {
          muse: {
            enabled: true,
          },
        },
      })
      .pipe(
        Effect.mapError(() => loginError("로그인은 성공했지만 Muse 설정을 저장하지 못했습니다.")),
      );
  } else {
    yield* settings
      .updateSettings({
        providerInstancesToUpsert: {
          [target.instanceId]: {
            driver: MUSE_DRIVER,
            enabled: true,
            ...(resolvedDisplayName ? { displayName: resolvedDisplayName } : {}),
            ...(resolvedAccentColor ? { accentColor: resolvedAccentColor } : {}),
            ...(target.existingInstance?.environment
              ? { environment: target.existingInstance.environment }
              : {}),
            ...(Object.keys(existingConfigRecord).length > 0
              ? { config: existingConfigRecord }
              : {}),
          },
        },
      })
      .pipe(
        Effect.mapError(() => loginError("로그인은 성공했지만 Muse 계정을 저장하지 못했습니다.")),
      );
  }

  return {
    instanceId: target.instanceId,
    driver: MUSE_DRIVER,
    ...(email ? { email } : {}),
    ...(resolvedDisplayName ? { displayName: resolvedDisplayName } : {}),
    ...(target.targetHomePath ? { homePath: target.targetHomePath } : {}),
  };
});

interface ActiveMuseAuthSession {
  readonly id: string;
  readonly target: ResolvedMuseTarget;
  readonly expiresAtMs: number;
  readonly child: NodeChildProcess.ChildProcess;
  readonly completionDeferred: Deferred.Deferred<void, ProviderAccountLoginError>;
  timeoutFiber: Fiber.Fiber<void, never> | undefined;
  cleaned: boolean;
}

const activeMuseAuthSessions = new Map<string, ActiveMuseAuthSession>();

function killChildQuietly(child: NodeChildProcess.ChildProcess): void {
  try {
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
  } catch {
    // Ignore kill race when child already exited.
  }
}

const disposeMuseAuthSession = (
  fs: FileSystem.FileSystem,
  session: ActiveMuseAuthSession,
  options: { readonly removeCreatedHome: boolean; readonly cancelReason?: string },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fiberToInterrupt = yield* Effect.sync(() => {
      if (session.cleaned) return null;
      session.cleaned = true;
      const fiber = session.timeoutFiber;
      session.timeoutFiber = undefined;
      activeMuseAuthSessions.delete(session.id);
      killChildQuietly(session.child);
      return fiber ?? undefined;
    });
    if (fiberToInterrupt === null) return;
    if (fiberToInterrupt !== undefined) {
      yield* Fiber.interrupt(fiberToInterrupt).pipe(Effect.ignore);
    }
    if (options.cancelReason) {
      yield* Deferred.fail(session.completionDeferred, loginError(options.cancelReason)).pipe(
        Effect.ignore,
      );
    }
    if (options.removeCreatedHome) {
      yield* cleanupCreatedMuseHomeIfNeeded(fs, session.target);
    }
  });

function writeJsonRpcLine(child: NodeChildProcess.ChildProcess, payload: unknown): void {
  if (!child.stdin || child.stdin.destroyed) return;
  try {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Ignore EPIPE when child exits concurrently.
  }
}

/**
 * Start an interactive Meta Muse Code device-code login session via `muse acp`
 * (`authenticate({ methodId: "muse-login" })` + `elicitation/create`).
 *
 * Because ACP URL elicitation is used, the server never launches or steals focus
 * with a browser window; instead it returns the official `auth.meta.com`
 * verification URL and 8-character code so the user can sign in with Google or
 * Meta in their chosen browser (or incognito window for multi-account login).
 */
export const beginMuseAuth = Effect.fn("beginMuseAuth")(function* (
  input: MuseAuthBeginInput,
): Effect.fn.Return<
  MuseAuthBeginResult,
  ProviderAccountLoginError,
  ServerSettingsService | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const settings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  for (const stale of Array.from(activeMuseAuthSessions.values())) {
    if (stale.expiresAtMs <= nowMs) {
      yield* disposeMuseAuthSession(fs, stale, {
        removeCreatedHome: true,
        cancelReason: "Muse 로그인 대기 시간이 만료되었습니다. 다시 시도하세요.",
      });
    }
  }

  const allSettings = yield* settings.getSettings.pipe(
    Effect.mapError(() => loginError("설정을 읽지 못했습니다.")),
  );
  const target = yield* resolveMuseLoginTarget(allSettings, serverConfig.stateDir, input);

  for (const existing of Array.from(activeMuseAuthSessions.values())) {
    if (
      existing.target.instanceId === target.instanceId ||
      existing.target.targetConfigDir.toLowerCase() === target.targetConfigDir.toLowerCase()
    ) {
      yield* disposeMuseAuthSession(fs, existing, {
        removeCreatedHome: existing.target.createdDedicatedHome && !target.isReauth,
        cancelReason: "새 Muse 로그인 요청이 시작되어 이전 세션을 종료했습니다.",
      });
    }
  }

  yield* fs
    .makeDirectory(target.targetConfigDir, { recursive: true })
    .pipe(
      Effect.mapError(() =>
        loginError(`Muse 설정 디렉터리를 만들지 못했습니다: ${target.targetConfigDir}`),
      ),
    );

  const baseEnv = mergeProviderInstanceEnvironment(target.existingInstance?.environment);
  const environment = buildMuseLoginEnvironment(baseEnv, target, path);
  const resolvedBinary = resolveMuseBinaryPath(target.binaryPath, environment);
  const isScript = /\.[cm]?js$/i.test(resolvedBinary);
  const spawnCmd = isScript ? process.execPath : resolvedBinary;
  const spawnArgs = [...(isScript ? [resolvedBinary] : []), "acp", "--no-session-log"];

  const promptDeferred = yield* Deferred.make<MuseElicitationPrompt, ProviderAccountLoginError>();
  const completionDeferred = yield* Deferred.make<void, ProviderAccountLoginError>();
  const startedAt = yield* DateTime.now;
  const expiresAtDate = DateTime.add(startedAt, { minutes: 10 });
  const expiresAt = DateTime.formatIso(expiresAtDate);
  const expiresAtMs = DateTime.toEpochMillis(expiresAtDate);
  const sessionId = NodeCrypto.randomUUID();

  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(spawnCmd, spawnArgs, {
      env: {
        ...environment,
        ...(isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (cause) {
    yield* cleanupCreatedMuseHomeIfNeeded(fs, target);
    return yield* loginError(`Muse CLI 실행에 실패했습니다: ${String(cause)}`);
  }

  let stderrTail = "";
  let stdoutBuffer = "";
  let authSent = false;

  const failBoth = (message: string) => {
    const err = loginError(message);
    Effect.runSync(Deferred.fail(promptDeferred, err).pipe(Effect.ignore));
    Effect.runSync(Deferred.fail(completionDeferred, err).pipe(Effect.ignore));
  };

  child.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      failBoth(`Muse Code CLI('${target.binaryPath}')를 찾을 수 없습니다. 설치 경로를 확인하세요.`);
    } else {
      failBoth(`Muse 로그인 프로세스 오류: ${err.message}`);
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf("\n");
      if (!line) continue;

      const parsedOption = decodeUnknownJson(line);
      if (Option.isNone(parsedOption) || !isPlainRecord(parsedOption.value)) continue;
      const msg = parsedOption.value;

      if (msg.id === 1 && !authSent) {
        if (isPlainRecord(msg.error)) {
          const detail =
            typeof msg.error.message === "string"
              ? msg.error.message
              : "Muse ACP 초기화에 실패했습니다.";
          failBoth(detail);
          continue;
        }
        authSent = true;
        writeJsonRpcLine(child, {
          jsonrpc: "2.0",
          id: 2,
          method: "authenticate",
          params: { methodId: "muse-login" },
        });
        continue;
      }

      const elicitation = extractMuseElicitationPrompt(msg);
      if (elicitation) {
        writeJsonRpcLine(child, {
          jsonrpc: "2.0",
          id: elicitation.requestId,
          result: { action: "accept" },
        });
        Effect.runSync(Deferred.succeed(promptDeferred, elicitation).pipe(Effect.ignore));
        continue;
      }

      if (msg.id === 2) {
        if (isPlainRecord(msg.error)) {
          const detail =
            typeof msg.error.message === "string"
              ? msg.error.message
              : "Muse 로그인이 완료되지 않았습니다.";
          failBoth(detail);
        } else {
          Effect.runSync(Deferred.succeed(completionDeferred, undefined).pipe(Effect.ignore));
        }
      }
    }
  });

  child.on("exit", (code) => {
    const cleanTail = stderrTail.trim();
    failBoth(
      cleanTail
        ? `Muse 로그인 프로세스가 종료되었습니다 (코드 ${code ?? -1}): ${cleanTail.slice(0, 240)}`
        : `Muse 로그인 프로세스가 예상보다 일찍 종료되었습니다 (코드 ${code ?? -1}).`,
    );
  });

  // Send ACP initialize advertising URL elicitation capability (no forced browser launch).
  writeJsonRpcLine(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
      clientInfo: { name: "t3-code-auth", version: "0.0.0" },
    },
  });

  const session: ActiveMuseAuthSession = {
    id: sessionId,
    target,
    expiresAtMs,
    child,
    completionDeferred,
    timeoutFiber: undefined,
    cleaned: false,
  };

  const promptOption = yield* Deferred.await(promptDeferred).pipe(
    Effect.timeoutOption(Duration.millis(MUSE_PROMPT_TIMEOUT_MS)),
    Effect.tapError(() => disposeMuseAuthSession(fs, session, { removeCreatedHome: true })),
  );

  if (Option.isNone(promptOption)) {
    yield* disposeMuseAuthSession(fs, session, { removeCreatedHome: true });
    return yield* loginError(
      "Muse 로그인 링크를 30초 안에 받지 못했습니다. Muse Code CLI 설치 상태와 네트워크를 확인하세요.",
    );
  }

  activeMuseAuthSessions.set(sessionId, session);
  session.timeoutFiber = yield* Effect.sleep(Duration.millis(MUSE_LOGIN_TIMEOUT_MS)).pipe(
    Effect.andThen(
      disposeMuseAuthSession(fs, session, {
        removeCreatedHome: true,
        cancelReason: "Muse 로그인 대기 시간(10분)이 만료되었습니다. 다시 시도하세요.",
      }),
    ),
    Effect.forkDetach,
  );

  return {
    sessionId,
    instanceId: target.instanceId,
    verificationUrl: promptOption.value.verificationUrl,
    ...(promptOption.value.userCode ? { userCode: promptOption.value.userCode } : {}),
    expiresAt,
  };
});

export const waitMuseAuth = Effect.fn("waitMuseAuth")(function* (
  input: MuseAuthWaitInput,
): Effect.fn.Return<
  ProviderAccountLoginResult,
  ProviderAccountLoginError,
  ServerSettingsService | FileSystem.FileSystem | Path.Path
> {
  const settings = yield* ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;

  const session = activeMuseAuthSessions.get(input.sessionId);
  if (!session) {
    return yield* loginError("진행 중인 Muse 로그인 세션을 찾을 수 없습니다. 다시 시도하세요.");
  }

  const remainingMs = Math.max(
    1_000,
    session.expiresAtMs - DateTime.toEpochMillis(yield* DateTime.now),
  );
  const waitOption = yield* Deferred.await(session.completionDeferred).pipe(
    Effect.timeoutOption(Duration.millis(remainingMs)),
    Effect.tapError(() => disposeMuseAuthSession(fs, session, { removeCreatedHome: true })),
  );

  if (Option.isNone(waitOption)) {
    yield* disposeMuseAuthSession(fs, session, {
      removeCreatedHome: true,
      cancelReason: "Muse 로그인 대기 시간이 만료되었습니다. 다시 시도하세요.",
    });
    return yield* loginError("Muse 로그인 대기 시간이 만료되었습니다. 다시 시도하세요.");
  }

  yield* disposeMuseAuthSession(fs, session, { removeCreatedHome: false });

  const summary = yield* readMuseAuthSummary(session.target.targetConfigDir);
  if (!summary.authenticated) {
    yield* cleanupCreatedMuseHomeIfNeeded(fs, session.target);
    return yield* loginError(
      "브라우저 승인은 끝났지만 Muse 인증 파일(auth.json)을 확인하지 못했습니다. 다시 시도하세요.",
    );
  }

  const latestSettings = yield* settings.getSettings.pipe(
    Effect.mapError(() => loginError("설정을 다시 읽지 못했습니다.")),
  );
  const duplicate = yield* findDuplicateMuseAccount(
    latestSettings,
    summary,
    session.target.instanceId,
  );
  if (duplicate) {
    yield* cleanupCreatedMuseHomeIfNeeded(fs, session.target);
    const emailLabel = duplicate.email ?? summary.email ?? duplicate.displayName;
    return yield* loginError(
      `이미 등록된 Muse 계정('${duplicate.displayName}', ${emailLabel})과 같은 계정으로 로그인되었습니다. 시크릿 창이나 다른 브라우저 프로필에서 다른 Google · Meta 계정으로 승인하세요.`,
    );
  }

  return yield* saveAuthenticatedMuseInstance(settings, session.target, summary);
});

export const cancelMuseAuth = Effect.fn("cancelMuseAuth")(function* (
  input: MuseAuthCancelInput,
): Effect.fn.Return<Record<string, never>, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const session = activeMuseAuthSessions.get(input.sessionId);
  if (session) {
    yield* disposeMuseAuthSession(fs, session, {
      removeCreatedHome: true,
      cancelReason: "사용자가 Muse 로그인을 취소했습니다.",
    });
  }
  return {};
});
