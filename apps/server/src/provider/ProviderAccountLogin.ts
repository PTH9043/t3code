import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeConnectionError,
  OpenCodeConnectInput,
  ProviderAccountLoginError,
  ProviderDriverKind,
  ProviderInstanceId,
  type GrokDeviceAuthBeginInput,
  type GrokDeviceAuthBeginResult,
  type GrokDeviceAuthCancelInput,
  type GrokDeviceAuthWaitInput,
  type ProviderAccountLoginInput,
  type ProviderAccountLoginResult,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { isCommandMissingCause, spawnAndCollect } from "./providerSnapshot.ts";
import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import {
  GROK_API_KEY_ENV,
  GROK_HOME_ENV,
  normalizeGrokEmail,
  readGrokAuthSummary,
  resolveGrokHomePath,
  type GrokAuthSummary,
} from "./Drivers/GrokHome.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const decodeGrokSettingsOption = Schema.decodeUnknownOption(GrokSettings);

const GROK_DRIVER = ProviderDriverKind.make("grok");
const GROK_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("grok");
const GROK_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const GROK_DEVICE_PROMPT_TIMEOUT_MS = 30 * 1000;
const MAX_GROK_OUTPUT_CHARS = 64_000;

function loginError(detail: string): ProviderAccountLoginError {
  return new ProviderAccountLoginError({ detail });
}

function stripTerminalControlSequences(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- Strip OSC escape sequences from CLI output.
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
      // eslint-disable-next-line no-control-regex -- Strip CSI ANSI escape sequences from CLI output.
      .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\r/g, "\n")
  );
}

export interface GrokDeviceAuthPrompt {
  readonly verificationUrl: string;
  readonly userCode?: string;
}

/**
 * Extract verification URL and optional one-time user code from
 * `grok login --device-auth` stdout/stderr.
 */
export function extractGrokDeviceAuthPrompt(rawOutput: string): GrokDeviceAuthPrompt | undefined {
  const plain = stripTerminalControlSequences(rawOutput);
  const urlMatches = plain.match(/https:\/\/[^\s"'<>)\]]+/gi);
  if (!urlMatches || urlMatches.length === 0) {
    return undefined;
  }

  const cleanedUrls = urlMatches
    .map((candidate) => candidate.replace(/[.,;:!?]+$/u, ""))
    .filter((candidate) => {
      try {
        const parsed = new URL(candidate);
        return parsed.protocol === "https:";
      } catch {
        return false;
      }
    });
  if (cleanedUrls.length === 0) {
    return undefined;
  }

  const verificationUrl =
    cleanedUrls.find((candidate) => /(?:x\.ai|grok|device|auth|oauth|verify)/i.test(candidate)) ??
    cleanedUrls[0]!;

  let userCode: string | undefined;
  const codeLineMatch =
    /(?:^|[\s(])(?:user[_\s-]?code|verification[_\s-]?code|one[- ]time[_\s-]?code|code)\s*[:=]\s*([A-Z0-9]{3,16}(?:-[A-Z0-9]{2,16})+|[A-Z0-9]{6,16})\b/i.exec(
      plain,
    );
  if (codeLineMatch?.[1]) {
    userCode = codeLineMatch[1].trim().toUpperCase();
  } else {
    try {
      const parsed = new URL(verificationUrl);
      const queryCode = parsed.searchParams.get("user_code") ?? parsed.searchParams.get("code");
      if (queryCode && queryCode.trim().length >= 4) {
        userCode = queryCode.trim().toUpperCase();
      }
    } catch {
      // Ignore malformed query string; URL validity was already checked.
    }
  }

  return {
    verificationUrl,
    ...(userCode ? { userCode } : {}),
  };
}

function summarizeCliFailureOutput(rawOutput: string): string {
  const lines = stripTerminalControlSequences(rawOutput)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-3).join(" / ");
  return tail.length > 260 ? `${tail.slice(0, 257)}...` : tail;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeGrokConfigSafe(raw: unknown): GrokSettings {
  const decoded = decodeGrokSettingsOption(isPlainRecord(raw) ? raw : {});
  return Option.isSome(decoded) ? decoded.value : Schema.decodeSync(GrokSettings)({});
}

function resolveGrokBinaryPath(
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
  const defaultBinary = allSettings.providers.grok.binaryPath.trim();
  return defaultBinary.length > 0 ? defaultBinary : "grok";
}

interface ResolvedGrokTarget {
  readonly instanceId: ProviderInstanceId;
  readonly isReauth: boolean;
  readonly existingInstance?: ProviderInstanceConfig;
  readonly targetHomePath: string;
  readonly persistHomePath: boolean;
  readonly createdDedicatedHome: boolean;
  readonly binaryPath: string;
  readonly displayNameOverride?: string;
  readonly accentColorOverride?: string;
}

const resolveGrokLoginTarget = Effect.fn("resolveGrokLoginTarget")(function* (
  allSettings: ServerSettings,
  stateDir: string,
  input: {
    readonly instanceId?: ProviderInstanceId | undefined;
    readonly displayName?: string | undefined;
    readonly accentColor?: string | undefined;
    readonly homePath?: string | undefined;
  },
): Effect.fn.Return<ResolvedGrokTarget, ProviderAccountLoginError, Path.Path> {
  const path = yield* Path.Path;
  const requestedHomePath = input.homePath?.trim() ?? "";

  if (input.instanceId !== undefined) {
    const instanceId = input.instanceId;
    const existingInstance = allSettings.providerInstances[instanceId];
    const isDefaultSlot = String(instanceId) === String(GROK_DEFAULT_INSTANCE_ID);
    if (!existingInstance && !isDefaultSlot) {
      return yield* loginError(`지정한 Grok 계정('${instanceId}')을 찾을 수 없습니다.`);
    }
    if (existingInstance && existingInstance.driver !== GROK_DRIVER) {
      return yield* loginError(`'${instanceId}'은(는) Grok 계정이 아닙니다.`);
    }

    const existingConfig = existingInstance
      ? decodeGrokConfigSafe(existingInstance.config)
      : allSettings.providers.grok;
    const existingEnv = mergeProviderInstanceEnvironment(existingInstance?.environment);

    let targetHomePath: string;
    let persistHomePath: boolean;
    let createdDedicatedHome = false;

    if (requestedHomePath.length > 0) {
      targetHomePath = path.resolve(expandHomePath(requestedHomePath));
      persistHomePath = true;
    } else if (existingConfig.homePath.trim().length > 0) {
      targetHomePath = yield* resolveGrokHomePath(existingConfig, existingEnv);
      persistHomePath = true;
    } else if (existingEnv[GROK_HOME_ENV]?.trim()) {
      targetHomePath = yield* resolveGrokHomePath(existingConfig, existingEnv);
      persistHomePath = false;
    } else if (isDefaultSlot) {
      targetHomePath = yield* resolveGrokHomePath(existingConfig, existingEnv);
      persistHomePath = false;
    } else {
      targetHomePath = path.join(stateDir, "provider-instances", String(instanceId), "grok-home");
      persistHomePath = true;
      createdDedicatedHome = true;
    }

    return {
      instanceId,
      isReauth: true,
      ...(existingInstance ? { existingInstance } : {}),
      targetHomePath,
      persistHomePath,
      createdDedicatedHome,
      binaryPath: resolveGrokBinaryPath(allSettings, existingInstance),
      ...(input.displayName?.trim() ? { displayNameOverride: input.displayName.trim() } : {}),
      ...(input.accentColor?.trim() ? { accentColorOverride: input.accentColor.trim() } : {}),
    } satisfies ResolvedGrokTarget;
  }

  const instanceId = ProviderInstanceId.make(`grok_${NodeCrypto.randomUUID().slice(0, 8)}`);
  if (allSettings.providerInstances[instanceId]) {
    return yield* loginError(`인스턴스 '${instanceId}'가 이미 있습니다. 다시 시도하세요.`);
  }
  const targetHomePath =
    requestedHomePath.length > 0
      ? path.resolve(expandHomePath(requestedHomePath))
      : path.join(stateDir, "provider-instances", String(instanceId), "grok-home");

  return {
    instanceId,
    isReauth: false,
    targetHomePath,
    persistHomePath: true,
    createdDedicatedHome: requestedHomePath.length === 0,
    binaryPath: resolveGrokBinaryPath(allSettings),
    ...(input.displayName?.trim() ? { displayNameOverride: input.displayName.trim() } : {}),
    ...(input.accentColor?.trim() ? { accentColorOverride: input.accentColor.trim() } : {}),
  } satisfies ResolvedGrokTarget;
});

interface DuplicateGrokAccountMatch {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly email?: string;
}

const findDuplicateGrokAccount = Effect.fn("findDuplicateGrokAccount")(function* (
  allSettings: ServerSettings,
  candidate: GrokAuthSummary,
  excludeInstanceId: ProviderInstanceId,
) {
  const candidateEmail = normalizeGrokEmail(candidate.email);
  const candidateUserId = candidate.userId?.trim() || undefined;
  if (!candidateEmail && !candidateUserId) {
    return undefined as DuplicateGrokAccountMatch | undefined;
  }

  const entries: Array<{
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string;
    readonly config: GrokSettings;
    readonly environment?: ProviderInstanceConfig["environment"];
  }> = [];

  if (String(excludeInstanceId) !== String(GROK_DEFAULT_INSTANCE_ID)) {
    const defaultOverride = allSettings.providerInstances[GROK_DEFAULT_INSTANCE_ID];
    entries.push({
      instanceId: GROK_DEFAULT_INSTANCE_ID,
      displayName: defaultOverride?.displayName?.trim() || "Grok",
      config: defaultOverride
        ? decodeGrokConfigSafe(defaultOverride.config)
        : allSettings.providers.grok,
      ...(defaultOverride?.environment ? { environment: defaultOverride.environment } : {}),
    });
  }

  for (const [rawId, instance] of Object.entries(allSettings.providerInstances)) {
    if (instance.driver !== GROK_DRIVER) continue;
    if (rawId === String(excludeInstanceId) || rawId === String(GROK_DEFAULT_INSTANCE_ID)) continue;
    entries.push({
      instanceId: ProviderInstanceId.make(rawId),
      displayName: instance.displayName?.trim() || rawId,
      config: decodeGrokConfigSafe(instance.config),
      ...(instance.environment ? { environment: instance.environment } : {}),
    });
  }

  for (const entry of entries) {
    const env = mergeProviderInstanceEnvironment(entry.environment);
    const homePath = yield* resolveGrokHomePath(entry.config, env);
    const summary = yield* readGrokAuthSummary(homePath);
    if (!summary.authenticated) continue;
    const otherEmail = normalizeGrokEmail(summary.email);
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
      } satisfies DuplicateGrokAccountMatch;
    }
  }

  return undefined;
});

function buildGrokLoginEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  targetHomePath: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...baseEnv,
    [GROK_HOME_ENV]: targetHomePath,
  };
  delete next[GROK_API_KEY_ENV];
  return next;
}

const cleanupCreatedGrokHomeIfNeeded = (
  fs: FileSystem.FileSystem,
  target: Pick<ResolvedGrokTarget, "createdDedicatedHome" | "targetHomePath">,
): Effect.Effect<void> =>
  target.createdDedicatedHome
    ? fs.remove(target.targetHomePath, { recursive: true, force: true }).pipe(Effect.ignore)
    : Effect.void;

const saveAuthenticatedGrokInstance = Effect.fn("saveAuthenticatedGrokInstance")(function* (
  settings: ServerSettingsService["Service"],
  target: ResolvedGrokTarget,
  summary: GrokAuthSummary,
): Effect.fn.Return<ProviderAccountLoginResult, ProviderAccountLoginError> {
  const email = summary.email?.trim() || undefined;
  const isDefaultSlot = String(target.instanceId) === String(GROK_DEFAULT_INSTANCE_ID);
  const existingConfigRecord =
    target.existingInstance && isPlainRecord(target.existingInstance.config)
      ? { ...target.existingInstance.config }
      : {};
  if (target.binaryPath && target.binaryPath !== "grok") {
    existingConfigRecord.binaryPath = target.binaryPath;
  }
  if (target.persistHomePath) {
    existingConfigRecord.homePath = target.targetHomePath;
  }

  const resolvedDisplayName =
    target.displayNameOverride ??
    target.existingInstance?.displayName?.trim() ??
    (isDefaultSlot ? undefined : email ? `Grok ${email}` : "Grok 계정");
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
          grok: {
            enabled: true,
          },
        },
      })
      .pipe(
        Effect.mapError(() => loginError("로그인은 성공했지만 Grok 설정을 저장하지 못했습니다.")),
      );
  } else {
    yield* settings
      .updateSettings({
        providerInstancesToUpsert: {
          [target.instanceId]: {
            driver: GROK_DRIVER,
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
        Effect.mapError(() => loginError("로그인은 성공했지만 Grok 계정을 저장하지 못했습니다.")),
      );
  }

  return {
    instanceId: target.instanceId,
    driver: GROK_DRIVER,
    ...(email ? { email } : {}),
    ...(resolvedDisplayName ? { displayName: resolvedDisplayName } : {}),
    homePath: target.targetHomePath,
  };
});

interface ActiveGrokDeviceSession {
  readonly id: string;
  readonly target: ResolvedGrokTarget;
  readonly expiresAtMs: number;
  readonly scope: Scope.Closeable;
  readonly exitDeferred: Deferred.Deferred<number, ProviderAccountLoginError>;
  output: string;
  cleaned: boolean;
}

const activeGrokDeviceSessions = new Map<string, ActiveGrokDeviceSession>();

const disposeGrokDeviceSession = (
  fs: FileSystem.FileSystem,
  session: ActiveGrokDeviceSession,
  options: { readonly removeCreatedHome: boolean; readonly cancelReason?: string },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const shouldDispose = yield* Effect.sync(() => {
      if (session.cleaned) return false;
      session.cleaned = true;
      activeGrokDeviceSessions.delete(session.id);
      return true;
    });
    if (!shouldDispose) return;
    if (options.cancelReason) {
      yield* Deferred.fail(session.exitDeferred, loginError(options.cancelReason)).pipe(
        Effect.ignore,
      );
    }
    yield* Scope.close(session.scope, Exit.void).pipe(Effect.ignore);
    if (options.removeCreatedHome) {
      yield* cleanupCreatedGrokHomeIfNeeded(fs, session.target);
    }
  });

const sweepExpiredGrokDeviceSessions = (fs: FileSystem.FileSystem): Effect.Effect<void> =>
  Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const expired = Array.from(activeGrokDeviceSessions.values()).filter(
      (session) => session.expiresAtMs <= nowMs,
    );
    for (const session of expired) {
      yield* disposeGrokDeviceSession(fs, session, {
        removeCreatedHome: true,
        cancelReason: "Grok 장치 코드 로그인 시간이 만료되었습니다. 다시 시도하세요.",
      });
    }
  });

const verifyAndPersistGrokLogin = Effect.fn("verifyAndPersistGrokLogin")(function* (
  settings: ServerSettingsService["Service"],
  fs: FileSystem.FileSystem,
  target: ResolvedGrokTarget,
  mode: "oauth" | "device-auth",
) {
  const summary = yield* readGrokAuthSummary(target.targetHomePath);
  if (!summary.authenticated) {
    yield* cleanupCreatedGrokHomeIfNeeded(fs, target);
    return yield* loginError(
      "브라우저에서 로그인을 마쳤지만 Grok 인증 파일(auth.json)을 확인하지 못했습니다. 다시 시도하세요.",
    );
  }

  const latestSettings = yield* settings.getSettings.pipe(
    Effect.mapError(() => loginError("설정을 다시 읽지 못했습니다.")),
  );
  const duplicate = yield* findDuplicateGrokAccount(latestSettings, summary, target.instanceId);
  if (duplicate) {
    yield* cleanupCreatedGrokHomeIfNeeded(fs, target);
    const emailLabel = duplicate.email ?? summary.email ?? duplicate.displayName;
    const hint =
      mode === "oauth"
        ? " 다른 계정을 추가하려면 '다른 계정 (장치 코드 · 시크릿 창)' 방식을 사용하거나 브라우저에서 x.ai를 로그아웃한 뒤 다시 시도하세요."
        : " 시크릿 창 또는 다른 브라우저 프로필에서 아직 등록되지 않은 Grok 계정으로 승인하세요.";
    return yield* loginError(
      `이미 등록된 Grok 계정('${duplicate.displayName}', ${emailLabel})과 같은 계정으로 로그인되었습니다.${hint}`,
    );
  }

  return yield* saveAuthenticatedGrokInstance(settings, target, summary);
});

const loginGrokAccountOAuth = Effect.fn("loginGrokAccountOAuth")(function* (
  input: ProviderAccountLoginInput,
) {
  const settings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const allSettings = yield* settings.getSettings.pipe(
    Effect.mapError(() => loginError("설정을 읽지 못했습니다.")),
  );
  const target = yield* resolveGrokLoginTarget(allSettings, serverConfig.stateDir, input);

  yield* fs
    .makeDirectory(target.targetHomePath, { recursive: true })
    .pipe(
      Effect.mapError(() =>
        loginError(`Grok 홈 디렉터리를 만들지 못했습니다: ${target.targetHomePath}`),
      ),
    );

  const processEnv = mergeProviderInstanceEnvironment(target.existingInstance?.environment);
  const environment = buildGrokLoginEnvironment(processEnv, target.targetHomePath);
  const loginArgs = ["--no-auto-update", "login", "--oauth"];

  const spawnCommand = yield* resolveSpawnCommand(target.binaryPath, loginArgs, {
    env: environment,
    extendEnv: true,
  });

  const runResult = yield* Effect.scoped(
    Effect.gen(function* () {
      const loginProcess = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const child = yield* spawner.spawn(loginProcess).pipe(
        Effect.mapError((cause) => {
          if (isCommandMissingCause(cause)) {
            return loginError(
              `${target.binaryPath} CLI를 찾을 수 없습니다. Grok CLI 설치 상태를 확인하세요.`,
            );
          }
          return loginError(`Grok 로그인 프로세스를 시작하지 못했습니다: ${String(cause)}`);
        }),
      );

      let outputBuffer = "";
      const drainFiber = yield* Stream.merge(child.stdout, child.stderr).pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            if (outputBuffer.length < MAX_GROK_OUTPUT_CHARS) {
              outputBuffer += chunk.slice(0, MAX_GROK_OUTPUT_CHARS - outputBuffer.length);
            }
          }),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );

      const exitOption = yield* child.exitCode.pipe(
        Effect.map(Number),
        Effect.timeoutOption(Duration.millis(GROK_LOGIN_TIMEOUT_MS)),
        Effect.mapError((cause) =>
          loginError(`Grok 로그인 프로세스 종료를 확인하지 못했습니다: ${String(cause)}`),
        ),
      );
      yield* Fiber.await(drainFiber).pipe(Effect.timeoutOption(Duration.seconds(2)), Effect.ignore);

      return { exitOption, output: outputBuffer };
    }),
  ).pipe(Effect.tapError(() => cleanupCreatedGrokHomeIfNeeded(fs, target)));

  if (Option.isNone(runResult.exitOption)) {
    yield* cleanupCreatedGrokHomeIfNeeded(fs, target);
    return yield* loginError(
      "Grok 브라우저 로그인 대기 시간(5분)이 초과되었습니다. 브라우저에서 승인한 뒤 다시 시도하세요.",
    );
  }
  if (runResult.exitOption.value !== 0) {
    yield* cleanupCreatedGrokHomeIfNeeded(fs, target);
    const detail = summarizeCliFailureOutput(runResult.output);
    return yield* loginError(
      detail
        ? `Grok 로그인이 완료되지 않았습니다 (종료 코드 ${runResult.exitOption.value}): ${detail}`
        : `Grok 로그인이 완료되지 않았습니다 (종료 코드 ${runResult.exitOption.value}). 브라우저에서 로그인을 완료했는지 확인하세요.`,
    );
  }

  return yield* verifyAndPersistGrokLogin(settings, fs, target, "oauth");
});

/**
 * Start `grok --no-auto-update login --device-auth` in an isolated `GROK_HOME`
 * and return the verification URL + one-time user code so the user can approve
 * in an incognito window or another browser profile without colliding with the
 * default browser's cookies.
 */
export const beginGrokDeviceAuth = Effect.fn("beginGrokDeviceAuth")(function* (
  input: GrokDeviceAuthBeginInput,
): Effect.fn.Return<
  GrokDeviceAuthBeginResult,
  ProviderAccountLoginError,
  | ServerSettingsService
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> {
  const settings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  yield* sweepExpiredGrokDeviceSessions(fs);

  const allSettings = yield* settings.getSettings.pipe(
    Effect.mapError(() => loginError("설정을 읽지 못했습니다.")),
  );
  const target = yield* resolveGrokLoginTarget(allSettings, serverConfig.stateDir, input);

  // Cancel any stale device-auth session targeting the exact same instanceId or homePath.
  for (const existing of Array.from(activeGrokDeviceSessions.values())) {
    if (
      existing.target.instanceId === target.instanceId ||
      existing.target.targetHomePath.toLowerCase() === target.targetHomePath.toLowerCase()
    ) {
      yield* disposeGrokDeviceSession(fs, existing, {
        removeCreatedHome: existing.target.createdDedicatedHome && !target.isReauth,
        cancelReason: "새 Grok 로그인 요청이 시작되어 이전 세션을 종료했습니다.",
      });
    }
  }

  yield* fs
    .makeDirectory(target.targetHomePath, { recursive: true })
    .pipe(
      Effect.mapError(() =>
        loginError(`Grok 홈 디렉터리를 만들지 못했습니다: ${target.targetHomePath}`),
      ),
    );

  const processEnv = mergeProviderInstanceEnvironment(target.existingInstance?.environment);
  const environment = buildGrokLoginEnvironment(processEnv, target.targetHomePath);
  const spawnCommand = yield* resolveSpawnCommand(
    target.binaryPath,
    ["--no-auto-update", "login", "--device-auth"],
    {
      env: environment,
      extendEnv: true,
    },
  );

  const scope = yield* Scope.make();
  const promptDeferred = yield* Deferred.make<GrokDeviceAuthPrompt, ProviderAccountLoginError>();
  const exitDeferred = yield* Deferred.make<number, ProviderAccountLoginError>();
  const startedAt = yield* DateTime.now;
  const expiresAtDate = DateTime.add(startedAt, { minutes: 5 });
  const expiresAt = DateTime.formatIso(expiresAtDate);
  const expiresAtMs = DateTime.toEpochMillis(expiresAtDate);
  const sessionId = NodeCrypto.randomUUID();

  const session: ActiveGrokDeviceSession = {
    id: sessionId,
    target,
    expiresAtMs,
    scope,
    exitDeferred,
    output: "",
    cleaned: false,
  };

  const loginProcess = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: environment,
    shell: spawnCommand.shell,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const childExit = yield* spawner.spawn(loginProcess).pipe(Scope.provide(scope), Effect.exit);

  if (Exit.isFailure(childExit)) {
    yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    yield* cleanupCreatedGrokHomeIfNeeded(fs, target);
    return yield* loginError(
      `Grok 장치 코드 로그인을 시작하지 못했습니다: ${String(childExit.cause)}`,
    );
  }
  const child = childExit.value;

  yield* Stream.merge(child.stdout, child.stderr).pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        if (session.output.length < MAX_GROK_OUTPUT_CHARS) {
          session.output += chunk.slice(0, MAX_GROK_OUTPUT_CHARS - session.output.length);
        }
        const prompt = extractGrokDeviceAuthPrompt(session.output);
        if (prompt) {
          yield* Deferred.succeed(promptDeferred, prompt).pipe(Effect.ignore);
        }
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  yield* child.exitCode.pipe(
    Effect.map(Number),
    Effect.tap((code) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(exitDeferred, code).pipe(Effect.ignore);
        const detail = summarizeCliFailureOutput(session.output);
        yield* Deferred.fail(
          promptDeferred,
          loginError(
            detail
              ? `Grok 장치 코드 발급 전에 CLI가 종료되었습니다 (종료 코드 ${code}): ${detail}`
              : `Grok 장치 코드 발급 전에 CLI가 종료되었습니다 (종료 코드 ${code}).`,
          ),
        ).pipe(Effect.ignore);
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const err = loginError(`Grok 장치 코드 프로세스 오류: ${String(cause)}`);
        yield* Deferred.fail(promptDeferred, err).pipe(Effect.ignore);
        yield* Deferred.fail(exitDeferred, err).pipe(Effect.ignore);
      }),
    ),
    Effect.forkIn(scope),
  );

  const promptOption = yield* Deferred.await(promptDeferred).pipe(
    Effect.timeoutOption(Duration.millis(GROK_DEVICE_PROMPT_TIMEOUT_MS)),
    Effect.tapError(() => disposeGrokDeviceSession(fs, session, { removeCreatedHome: true })),
  );

  if (Option.isNone(promptOption)) {
    const detail = summarizeCliFailureOutput(session.output);
    yield* disposeGrokDeviceSession(fs, session, { removeCreatedHome: true });
    return yield* loginError(
      detail
        ? `Grok 장치 코드를 30초 안에 받지 못했습니다: ${detail}`
        : "Grok 장치 코드를 30초 안에 받지 못했습니다. Grok CLI 버전과 네트워크 상태를 확인하세요.",
    );
  }

  activeGrokDeviceSessions.set(sessionId, session);

  // Auto-expire uncompleted device-auth sessions; tied to `scope` so normal completion/cancel cancels this timer cleanly.
  yield* Effect.sleep(Duration.millis(GROK_LOGIN_TIMEOUT_MS)).pipe(
    Effect.andThen(
      disposeGrokDeviceSession(fs, session, {
        removeCreatedHome: true,
        cancelReason: "Grok 장치 코드 로그인 대기 시간(5분)이 만료되었습니다. 다시 시도하세요.",
      }),
    ),
    Effect.forkIn(scope),
  );

  return {
    sessionId,
    instanceId: target.instanceId,
    verificationUrl: promptOption.value.verificationUrl,
    ...(promptOption.value.userCode ? { userCode: promptOption.value.userCode } : {}),
    expiresAt,
  };
});

export const waitGrokDeviceAuth = Effect.fn("waitGrokDeviceAuth")(function* (
  input: GrokDeviceAuthWaitInput,
): Effect.fn.Return<
  ProviderAccountLoginResult,
  ProviderAccountLoginError,
  ServerSettingsService | FileSystem.FileSystem | Path.Path
> {
  const settings = yield* ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;

  const session = activeGrokDeviceSessions.get(input.sessionId);
  if (!session) {
    return yield* loginError(
      "Grok 장치 코드 로그인 세션을 찾을 수 없거나 이미 만료되었습니다. 다시 발급하세요.",
    );
  }

  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const remainingMs = Math.max(1_000, session.expiresAtMs - nowMs);
  const exitOption = yield* Deferred.await(session.exitDeferred).pipe(
    Effect.timeoutOption(Duration.millis(remainingMs)),
    Effect.tapError(() => disposeGrokDeviceSession(fs, session, { removeCreatedHome: true })),
  );

  if (Option.isNone(exitOption)) {
    yield* disposeGrokDeviceSession(fs, session, { removeCreatedHome: true });
    return yield* loginError(
      "Grok 장치 코드 로그인 대기 시간이 초과되었습니다. 코드를 다시 발급받아 진행하세요.",
    );
  }

  const exitCode = exitOption.value;
  if (exitCode !== 0) {
    const detail = summarizeCliFailureOutput(session.output);
    yield* disposeGrokDeviceSession(fs, session, { removeCreatedHome: true });
    return yield* loginError(
      detail
        ? `Grok 장치 코드 로그인이 완료되지 않았습니다 (종료 코드 ${exitCode}): ${detail}`
        : `Grok 장치 코드 로그인이 완료되지 않았습니다 (종료 코드 ${exitCode}).`,
    );
  }

  // Keep the home directory while verifying and saving; release process scope right away.
  yield* disposeGrokDeviceSession(fs, session, { removeCreatedHome: false });

  return yield* verifyAndPersistGrokLogin(settings, fs, session.target, "device-auth");
});

export const cancelGrokDeviceAuth = Effect.fn("cancelGrokDeviceAuth")(function* (
  input: GrokDeviceAuthCancelInput,
): Effect.fn.Return<{}, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const session = activeGrokDeviceSessions.get(input.sessionId);
  if (session) {
    yield* disposeGrokDeviceSession(fs, session, {
      removeCreatedHome: true,
      cancelReason: "Grok 장치 코드 로그인이 취소되었습니다.",
    });
  }
  return {};
});

const AuthStatusResponseShape = Schema.Struct({
  loggedIn: Schema.Boolean,
  account: Schema.optional(
    Schema.Struct({
      email: Schema.optional(Schema.String),
    }),
  ),
});
const decodeAuthStatus = Schema.decodeUnknownOption(Schema.fromJsonString(AuthStatusResponseShape));

type BrowserLoginDriver = "codex" | "claudeAgent" | "cursor" | "grok";

interface BrowserLoginSpec {
  readonly instancePrefix: string;
  readonly displayName: string;
  readonly homeFolder: string;
  readonly homeEnvVar?: string;
  readonly binary: string;
  readonly loginArgs: ReadonlyArray<string>;
  readonly statusArgs: ReadonlyArray<string>;
}

const BROWSER_LOGIN_SPECS: Record<BrowserLoginDriver, BrowserLoginSpec> = {
  codex: {
    instancePrefix: "codex",
    displayName: "Codex",
    homeFolder: "codex-home",
    homeEnvVar: "CODEX_HOME",
    binary: "codex",
    loginArgs: ["login"],
    statusArgs: ["login", "status"],
  },
  claudeAgent: {
    instancePrefix: "claude",
    displayName: "Claude",
    homeFolder: "claude-home",
    binary: "claude",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
  },
  cursor: {
    instancePrefix: "cursor",
    displayName: "Cursor",
    homeFolder: "cursor-home",
    homeEnvVar: "CURSOR_HOME",
    binary: "cursor-agent",
    loginArgs: ["login"],
    statusArgs: ["status"],
  },
  grok: {
    instancePrefix: "grok",
    displayName: "Grok",
    homeFolder: "grok-home",
    homeEnvVar: "GROK_HOME",
    binary: "grok",
    loginArgs: ["--no-auto-update", "login", "--oauth"],
    statusArgs: ["status"],
  },
  // NOTE: opencode is intentionally absent. `opencode auth login` is an
  // interactive TUI — there is no non-interactive browser OAuth path. OpenCode
  // Go (Zen) accepts an API key only, so users paste the key through the
  // OpenCode API settings form instead of a browser login.
};

export function isBrowserLoginDriver(driver: string): driver is BrowserLoginDriver {
  return Object.hasOwn(BROWSER_LOGIN_SPECS, driver);
}

/**
 * Create a fresh per-account provider instance (or re-authenticate an existing
 * Grok instance), run the provider CLI login in that instance's dedicated home,
 * confirm the account landed, and save the instance into settings.
 */
export const loginProviderAccount = Effect.fn("loginProviderAccount")(function* (
  input: ProviderAccountLoginInput,
): Effect.fn.Return<
  ProviderAccountLoginResult,
  ProviderAccountLoginError,
  | ServerSettingsService
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> {
  const driver = input.driver;
  if (driver === "gemini") {
    return yield* loginError(
      "Antigravity CLI 계정을 추가한 뒤 해당 계정 카드에서 Google로 로그인을 선택하세요.",
    );
  }
  if (driver === "grok") {
    return yield* loginGrokAccountOAuth(input);
  }
  if (!isBrowserLoginDriver(driver)) {
    return yield* loginError(`'${driver}' 드라이버는 브라우저 로그인을 지원하지 않습니다.`);
  }
  const spec = BROWSER_LOGIN_SPECS[driver];

  const settings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const instanceId = ProviderInstanceId.make(
    `${spec.instancePrefix}_${NodeCrypto.randomUUID().slice(0, 8)}`,
  );
  const dedicatedHomePath = path.join(
    serverConfig.stateDir,
    "provider-instances",
    instanceId,
    spec.homeFolder,
  );

  const allSettings = yield* settings.getSettings.pipe(
    Effect.mapError(() => loginError("설정을 읽지 못했습니다.")),
  );
  if (allSettings.providerInstances[instanceId]) {
    return yield* loginError(`인스턴스 '${instanceId}'가 이미 있습니다. 다시 시도하세요.`);
  }

  const processEnv = mergeProviderInstanceEnvironment([]);

  let binaryPath: string;
  let environment: NodeJS.ProcessEnv;
  const loginArgs = spec.loginArgs;
  const statusArgs = spec.statusArgs;

  if (driver === "codex") {
    const config = decodeCodexSettings({ homePath: dedicatedHomePath });
    const homeLayout = yield* resolveCodexHomeLayout(config);
    binaryPath = config.binaryPath || spec.binary;
    environment = {
      ...processEnv,
      CODEX_HOME: homeLayout.effectiveHomePath ?? dedicatedHomePath,
    };
    yield* fs
      .makeDirectory(homeLayout.effectiveHomePath ?? dedicatedHomePath, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          loginError(`Codex 홈 디렉터리를 만들지 못했습니다: ${dedicatedHomePath}`),
        ),
      );
  } else if (driver === "claudeAgent") {
    const config = decodeClaudeSettings({ homePath: dedicatedHomePath });
    binaryPath = config.binaryPath || spec.binary;
    environment = yield* makeClaudeEnvironment(config, processEnv);
    yield* fs
      .makeDirectory(dedicatedHomePath, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          loginError(`Claude 홈 디렉터리를 만들지 못했습니다: ${dedicatedHomePath}`),
        ),
      );
  } else {
    const config = decodeCursorSettings({});
    binaryPath = config.binaryPath || spec.binary;
    environment = {
      ...processEnv,
      ...(spec.homeEnvVar ? { [spec.homeEnvVar]: dedicatedHomePath } : {}),
    };
    yield* fs
      .makeDirectory(dedicatedHomePath, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          loginError(`${spec.displayName} 홈 디렉터리를 만들지 못했습니다: ${dedicatedHomePath}`),
        ),
      );
  }

  const spawnCommand = yield* resolveSpawnCommand(binaryPath, loginArgs, {
    env: environment,
    extendEnv: true,
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const loginProcess = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: environment,
    shell: spawnCommand.shell,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(loginProcess)
        .pipe(
          Effect.mapError((cause) =>
            loginError(`로그인 프로세스를 시작하지 못했습니다: ${String(cause)}`),
          ),
        );
      return yield* child.exitCode.pipe(
        Effect.mapError((cause) =>
          loginError(`로그인 프로세스 종료를 확인하지 못했습니다: ${String(cause)}`),
        ),
        Effect.map(Number),
      );
    }),
  );

  if (exitCode !== 0) {
    return yield* loginError(
      `로그인이 완료되지 않았습니다 (종료 코드 ${exitCode}). 브라우저에서 로그인을 완료했는지 확인하세요.`,
    );
  }

  const statusSpawn = yield* resolveSpawnCommand(binaryPath, statusArgs, {
    env: environment,
    extendEnv: true,
  });
  const statusCommand = ChildProcess.make(statusSpawn.command, statusSpawn.args, {
    env: environment,
    shell: statusSpawn.shell,
    extendEnv: true,
  });
  const statusResult = yield* spawnAndCollect(binaryPath, statusCommand).pipe(
    Effect.mapError((cause) => {
      if (isCommandMissingCause(cause))
        return loginError(`${binaryPath} CLI를 찾을 수 없습니다. 설치 상태를 확인하세요.`);
      return loginError(`로그인 확인에 실패했습니다: ${String(cause)}`);
    }),
  );

  const parsed = decodeAuthStatus(statusResult.stdout);
  if (Option.isNone(parsed) || !parsed.value.loggedIn) {
    return yield* loginError(
      "브라우저에서 로그인을 완료했지만 CLI가 로그인 상태를 인식하지 못했습니다. CLI 버전과 네트워크 상태를 확인하세요.",
    );
  }

  const email = parsed.value.account?.email;
  const displayName =
    input.displayName?.trim() ||
    (email ? `${spec.displayName} ${email}` : `${spec.displayName} 계정`);

  // homePath is a real setting only for drivers that support it; other
  // drivers isolate auth through the spawned environment at runtime.
  const supportsHomePath = driver === "codex" || driver === "claudeAgent";
  yield* settings
    .updateSettings({
      providerInstancesToUpsert: {
        [instanceId]: {
          driver: ProviderDriverKind.make(driver),
          enabled: true,
          displayName,
          ...(input.accentColor?.trim() ? { accentColor: input.accentColor.trim() } : {}),
          ...(supportsHomePath ? { config: { homePath: dedicatedHomePath } } : {}),
        },
      },
    })
    .pipe(Effect.mapError(() => loginError("로그인은 성공했지만 계정을 저장하지 못했습니다.")));

  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    ...(email ? { email } : {}),
    displayName,
    ...(supportsHomePath ? { homePath: dedicatedHomePath } : {}),
  };
});

const OPENCODE_AUTH_FILE = "auth.json";
const OPENCODE_AUTH_DIR = "opencode";
const OpenCodeAuthObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeOpenCodeAuth = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeAuthObject));
const encodeOpenCodeAuth = Schema.encodeEffect(fromJsonStringPretty(OpenCodeAuthObject));

/**
 * OpenCode Go stores credentials under the distinct `opencode-go` provider id.
 * Other providers' entries, including OpenCode Zen, are preserved by
 * merging into the raw JSON object rather than a schema-decoded projection.
 */
export const connectOpenCodeGoAccountAtPath = Effect.fn("connectOpenCodeGoAccountAtPath")(
  function* (input: OpenCodeConnectInput, authPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = yield* fs.exists(authPath).pipe(
      Effect.mapError(
        () =>
          new OpenCodeConnectionError({
            detail: "OpenCode 인증 파일의 상태를 확인하지 못했습니다.",
          }),
      ),
    );
    let next: Record<string, unknown> = {};
    if (exists) {
      const existing = yield* fs
        .readFileString(authPath)
        .pipe(
          Effect.mapError(
            () => new OpenCodeConnectionError({ detail: "OpenCode 인증 파일을 읽지 못했습니다." }),
          ),
        );
      next = yield* decodeOpenCodeAuth(existing).pipe(
        Effect.mapError(
          () =>
            new OpenCodeConnectionError({
              detail: "OpenCode 인증 파일의 형식이 올바르지 않습니다.",
            }),
        ),
      );
    }

    const hasRegisteredKey = (() => {
      const entry = next["opencode-go"];
      return (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof (entry as { key?: unknown }).key === "string" &&
        (entry as { key: string }).key.trim().length > 0
      );
    })();

    // Read-only probe: report registration status without writing.
    if (input.apiKey === undefined) {
      return { connected: hasRegisteredKey, keyRegistered: hasRegisteredKey };
    }

    next["opencode-go"] = { type: "api", key: input.apiKey.trim() };
    const serialized = yield* encodeOpenCodeAuth(next).pipe(
      Effect.mapError(
        () => new OpenCodeConnectionError({ detail: "OpenCode 인증 정보를 저장할 수 없습니다." }),
      ),
    );
    yield* fs
      .makeDirectory(path.dirname(authPath), { recursive: true })
      .pipe(
        Effect.mapError(
          () =>
            new OpenCodeConnectionError({ detail: "OpenCode 인증 디렉터리를 만들지 못했습니다." }),
        ),
      );
    yield* fs.writeFileString(authPath, serialized + "\n").pipe(
      Effect.mapError(
        () =>
          new OpenCodeConnectionError({
            detail: "OpenCode 인증 파일을 쓰지 못했습니다.",
          }),
      ),
    );

    return { connected: true, keyRegistered: true };
  },
);

export const connectOpenCodeGoAccount = Effect.fn("connectOpenCodeGoAccount")(function* (
  input: OpenCodeConnectInput,
) {
  const path = yield* Path.Path;
  return yield* connectOpenCodeGoAccountAtPath(
    input,
    path.join(
      process.env.XDG_DATA_HOME || path.join(NodeOS.homedir(), ".local", "share"),
      OPENCODE_AUTH_DIR,
      OPENCODE_AUTH_FILE,
    ),
  );
});
