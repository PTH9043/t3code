// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  GeminiAuthError,
  ProviderDriverKind,
  ProviderInstanceId,
  type GeminiAuthBeginResult,
  type GeminiAuthCompleteResult,
  GeminiSettings,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import {
  decodeGeminiFileKeychainOAuthCredentials,
  ensureGeminiOAuthSettings,
  hasGeminiAccessAndRefreshTokens,
  makeGeminiEnvironment,
  readGeminiAccountEmail,
  resolveGeminiHomePath,
} from "./Drivers/GeminiHome.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const GEMINI_DRIVER = ProviderDriverKind.make("gemini");
const AUTH_SESSION_TTL = Duration.minutes(5);
const AUTH_URL_TIMEOUT = Duration.seconds(45);
const AUTH_COMPLETION_TIMEOUT = Duration.seconds(60);
const AUTH_POST_PROCESSING_GRACE = Duration.seconds(3);
const MAX_OUTPUT_BUFFER_CHARS = 128_000;

function geminiHomesMatch(left: string, right: string): boolean {
  const normalizedLeft = NodePath.normalize(left);
  const normalizedRight = NodePath.normalize(right);
  return NodePath.sep === "\\"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

const GeminiOAuthCredentials = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
});
const decodeGeminiSettings = Schema.decodeUnknownEffect(GeminiSettings);
const decodeGeminiOAuthCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(GeminiOAuthCredentials),
);
const GeminiGoogleAccounts = Schema.Struct({
  active: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeGeminiGoogleAccounts = Schema.decodeUnknownOption(
  Schema.fromJsonString(GeminiGoogleAccounts),
);

type GeminiAuthFailureKind = GeminiAuthError["kind"];

interface ResolvedGeminiInstance {
  readonly instanceId: ProviderInstanceId;
  readonly settings: GeminiSettings;
  readonly environment: NodeJS.ProcessEnv;
}

interface StagedGeminiCredentials {
  readonly fileName: "gemini-credentials.json" | "oauth_creds.json";
  readonly contents: string;
}

interface ActiveAuthSession {
  readonly id: string;
  readonly instance: ResolvedGeminiInstance;
  readonly process: PtyAdapter.PtyProcess;
  readonly authorizationUrl: Deferred.Deferred<string, GeminiAuthError>;
  readonly completion: Deferred.Deferred<void, GeminiAuthError>;
  readonly checkForCredentials: Effect.Effect<boolean>;
  readonly readStagedCredentials: Effect.Effect<Option.Option<StagedGeminiCredentials>>;
  readonly expiresAt: string;
  readonly actualHomePath: string;
  readonly loginRootPath: string;
  readonly loginHomePath: string;
  readonly scope: Scope.Closeable;
  unsubscribeData: () => void;
  unsubscribeExit: () => void;
  output: string;
  codeSubmitted: boolean;
  cleaned: boolean;
}

function authError(kind: GeminiAuthFailureKind, detail: string): GeminiAuthError {
  return new GeminiAuthError({ kind, detail });
}

export function stripTerminalControlSequences(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- PTY parsing requires matching OSC control bytes.
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
      // eslint-disable-next-line no-control-regex -- PTY parsing requires matching CSI control bytes.
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\r/g, "")
  );
}

export function extractGeminiAuthorizationUrl(output: string): string | undefined {
  const plain = stripTerminalControlSequences(output);
  const match = /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s]+/.exec(plain);
  if (!match) return undefined;
  try {
    const parsed = new URL(match[0]);
    if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com") {
      return undefined;
    }
    // Google only guarantees a refresh token when the user grants offline
    // access. Gemini CLI already asks for offline access; forcing a fresh
    // consent screen makes that grant reliable for each isolated T3 account,
    // while select_account prevents an existing browser session from silently
    // choosing the wrong Google identity for a second provider instance.
    parsed.searchParams.set("prompt", "consent select_account");
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function hasValidGeminiOAuthCredentials(contents: string): boolean {
  const decoded = decodeGeminiOAuthCredentials(contents);
  return (
    Option.isSome(decoded) &&
    decoded.value.access_token.trim().length > 0 &&
    decoded.value.refresh_token.trim().length > 0
  );
}

function hasValidGeminiAccountMetadata(contents: string): boolean {
  return Option.isSome(decodeGeminiGoogleAccounts(contents));
}

function outputIndicatesAuthFailure(output: string): boolean {
  const normalized = stripTerminalControlSequences(output).toLowerCase();
  return (
    normalized.includes("failed to authenticate with user code") ||
    normalized.includes("failed to authenticate with authorization code") ||
    normalized.includes("authorization code is required") ||
    normalized.includes("authorization timed out")
  );
}

export class GeminiAuth extends Context.Service<
  GeminiAuth,
  {
    readonly begin: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<GeminiAuthBeginResult, GeminiAuthError>;
    readonly complete: (
      sessionId: string,
      code: string,
    ) => Effect.Effect<GeminiAuthCompleteResult, GeminiAuthError>;
    readonly cancel: (sessionId: string) => Effect.Effect<void, GeminiAuthError>;
  }
>()("t3/provider/GeminiAuth") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pty = yield* PtyAdapter.PtyAdapter;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const authMutex = yield* Semaphore.make(1);
  const sessions = new Map<string, ActiveAuthSession>();
  const authStagingRoot = path.join(serverConfig.stateDir, "provider-auth", "gemini");

  yield* fs
    .remove(authStagingRoot, { recursive: true, force: true })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to remove stale Gemini login directories.", { cause }),
      ),
    );

  const cleanup = (session: ActiveAuthSession): Effect.Effect<void> =>
    Effect.gen(function* () {
      const shouldClean = yield* Effect.sync(() => {
        if (session.cleaned) return false;
        session.cleaned = true;
        try {
          session.unsubscribeData();
        } catch {
          // Listener disposal is best-effort during shutdown.
        }
        try {
          session.unsubscribeExit();
        } catch {
          // Listener disposal is best-effort during shutdown.
        }
        sessions.delete(session.id);
        session.output = "";
        try {
          session.process.kill("SIGTERM");
        } catch {
          // The process may already have exited after a failed code exchange.
        }
        return true;
      });
      if (!shouldClean) return;
      yield* Deferred.fail(
        session.authorizationUrl,
        authError("session-not-found", "Google 로그인 세션이 취소되었습니다."),
      ).pipe(Effect.ignore);
      yield* Deferred.fail(
        session.completion,
        authError("session-not-found", "Google 로그인 세션이 취소되었습니다."),
      ).pipe(Effect.ignore);
      yield* Scope.close(session.scope, Exit.void);
      yield* fs.remove(session.loginRootPath, { recursive: true, force: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to remove an isolated Gemini login directory.", {
            cause,
          }),
        ),
      );
    });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(Array.from(sessions.values()), cleanup, { discard: true }),
  );

  const resolveInstance = Effect.fn("GeminiAuth.resolveInstance")(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<ResolvedGeminiInstance, GeminiAuthError> {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) =>
        authError("storage-failed", `제공자 설정을 읽지 못했습니다: ${cause.message}`),
      ),
    );
    const explicit = settings.providerInstances[instanceId];
    let envelope: ProviderInstanceConfig;
    if (explicit !== undefined) {
      envelope = explicit;
    } else if (instanceId === ProviderInstanceId.make("gemini")) {
      envelope = {
        driver: GEMINI_DRIVER,
        enabled: settings.providers.gemini.enabled,
        config: settings.providers.gemini,
      };
    } else {
      return yield* authError(
        "instance-not-found",
        `Gemini CLI 계정 '${instanceId}'을(를) 찾을 수 없습니다.`,
      );
    }
    if (envelope.driver !== GEMINI_DRIVER) {
      return yield* authError("wrong-driver", `'${instanceId}'은(는) Gemini CLI 계정이 아닙니다.`);
    }
    const decoded = yield* decodeGeminiSettings(envelope.config ?? {}).pipe(
      Effect.mapError((cause) =>
        authError("storage-failed", `Gemini CLI 계정 설정이 올바르지 않습니다: ${cause.message}`),
      ),
    );
    const baseEnvironment = mergeProviderInstanceEnvironment(envelope.environment ?? []);
    const environment = makeGeminiEnvironment({
      settings: decoded,
      instanceId,
      stateDir: serverConfig.stateDir,
      baseEnv: baseEnvironment,
    });
    return { instanceId, settings: decoded, environment };
  });

  const startSession = Effect.fn("GeminiAuth.startSession")(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<ActiveAuthSession, GeminiAuthError> {
    const instance = yield* resolveInstance(instanceId);
    const actualHomePath = resolveGeminiHomePath({
      settings: instance.settings,
      instanceId,
      stateDir: serverConfig.stateDir,
    });
    const existing = Array.from(sessions.values()).find(
      (session) =>
        session.instance.instanceId === instanceId ||
        geminiHomesMatch(session.actualHomePath, actualHomePath),
    );
    if (existing) {
      yield* cleanup(existing);
    }

    const id = NodeCrypto.randomUUID();
    const startedAt = yield* DateTime.now;
    const expiresAt = DateTime.formatIso(DateTime.add(startedAt, { minutes: 5 }));
    const loginRootPath = path.join(authStagingRoot, id);
    const loginHomePath = path.join(loginRootPath, "home");
    const authWorkspacePath = path.join(loginRootPath, "workspace");
    const stagedEncryptedCredentialPath = path.join(
      loginHomePath,
      ".gemini",
      "gemini-credentials.json",
    );
    const stagedCredentialPath = path.join(loginHomePath, ".gemini", "oauth_creds.json");
    const ensureOAuthSettings = (homePath: string) =>
      ensureGeminiOAuthSettings({ homePath }).pipe(
        Effect.mapError((cause) =>
          authError("storage-failed", `Gemini 로그인 설정을 저장하지 못했습니다: ${cause}`),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    yield* ensureOAuthSettings(loginHomePath).pipe(
      Effect.mapError((cause) =>
        authError("storage-failed", `격리된 Gemini 로그인 환경을 만들지 못했습니다: ${cause}`),
      ),
      Effect.onError(() =>
        fs.remove(loginRootPath, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    yield* fs.makeDirectory(authWorkspacePath, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        authError("storage-failed", `격리된 Gemini 로그인 작업 공간을 만들지 못했습니다: ${cause}`),
      ),
      Effect.onError(() =>
        fs.remove(loginRootPath, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    const environment = {
      ...instance.environment,
      GEMINI_CLI_HOME: loginHomePath,
      NO_BROWSER: "true",
    } satisfies NodeJS.ProcessEnv;
    // On Windows the Gemini CLI is an npm `gemini.cmd` shim, and node-pty's
    // CreateProcess cannot execute a batch shim — passing the bare name (or even
    // its full path) throws, so login always failed on Windows even though the
    // provider card reported the CLI installed (its version probe resolves the
    // command). Resolve the command the same way the version probe and ACP
    // runtime do, and when resolution routes through a shell (a .cmd/.bat on
    // win32) run it through cmd.exe, mirroring WorkspaceProgramSupervisor.
    const resolvedGemini = yield* resolveSpawnCommand(
      instance.settings.binaryPath || "gemini",
      ["--skip-trust"],
      { env: environment, extendEnv: true },
    );
    const comSpec = (environment as NodeJS.ProcessEnv).ComSpec ?? "cmd.exe";
    const geminiInvocation = resolvedGemini.shell
      ? {
          shell: comSpec,
          args: ["/d", "/s", "/c", [resolvedGemini.command, ...resolvedGemini.args].join(" ")],
        }
      : { shell: resolvedGemini.command, args: [...resolvedGemini.args] };
    const authProcess = yield* pty
      .spawn({
        shell: geminiInvocation.shell,
        args: geminiInvocation.args,
        cwd: authWorkspacePath,
        cols: 1000,
        rows: 40,
        env: environment,
      })
      .pipe(
        Effect.mapError((cause) =>
          authError(
            "start-failed",
            `Gemini CLI를 시작하지 못했습니다. 설치 상태와 실행 파일 경로를 확인하세요: ${cause.message}`,
          ),
        ),
        Effect.onError(() =>
          fs.remove(loginRootPath, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );

    const authorizationUrl = yield* Deferred.make<string, GeminiAuthError>();
    const completion = yield* Deferred.make<void, GeminiAuthError>();
    const sessionScope = yield* Scope.make("sequential");
    const stagedAccountPath = path.join(loginHomePath, ".gemini", "google_accounts.json");
    let credentialSettlementStarted = false;
    const waitForAccountMetadata = Effect.gen(function* () {
      const contents = yield* fs.readFileString(stagedAccountPath).pipe(Effect.option);
      if (Option.isSome(contents) && hasValidGeminiAccountMetadata(contents.value)) return;
      return yield* Effect.fail(undefined);
    }).pipe(Effect.retry(Schedule.spaced(Duration.millis(100))), Effect.asVoid);
    const settleCredentialCompletion = Effect.raceFirst(
      waitForAccountMetadata,
      Effect.sleep(AUTH_POST_PROCESSING_GRACE),
    ).pipe(Effect.andThen(Deferred.succeed(completion, undefined)), Effect.asVoid);
    const readStagedCredentials = Effect.gen(function* () {
      const encryptedContents = yield* fs
        .readFileString(stagedEncryptedCredentialPath)
        .pipe(Effect.option);
      if (Option.isSome(encryptedContents)) {
        const encryptedCredentials = decodeGeminiFileKeychainOAuthCredentials(
          encryptedContents.value,
        );
        if (
          Option.isSome(encryptedCredentials) &&
          hasGeminiAccessAndRefreshTokens(encryptedCredentials.value)
        ) {
          const staged: StagedGeminiCredentials = {
            fileName: "gemini-credentials.json",
            contents: encryptedContents.value,
          };
          return Option.some(staged);
        }
      }

      const legacyContents = yield* fs.readFileString(stagedCredentialPath).pipe(Effect.option);
      return Option.filter(
        Option.map(
          legacyContents,
          (contents): StagedGeminiCredentials => ({
            fileName: "oauth_creds.json",
            contents,
          }),
        ),
        (credentials) => hasValidGeminiOAuthCredentials(credentials.contents),
      );
    });
    const completeWhenCredentialsExist = readStagedCredentials.pipe(
      Effect.flatMap((credentials) => {
        const credentialsExist = Option.isSome(credentials);
        if (!credentialsExist) return Effect.succeed(false);
        return Effect.sync(() => {
          if (credentialSettlementStarted) return false;
          credentialSettlementStarted = true;
          return true;
        }).pipe(
          Effect.flatMap((shouldStart) =>
            shouldStart
              ? settleCredentialCompletion.pipe(Effect.forkIn(sessionScope), Effect.asVoid)
              : Effect.void,
          ),
          Effect.as(true),
        );
      }),
    );
    const session: ActiveAuthSession = {
      id,
      instance,
      process: authProcess,
      authorizationUrl,
      completion,
      checkForCredentials: completeWhenCredentialsExist,
      readStagedCredentials,
      expiresAt,
      actualHomePath,
      loginRootPath,
      loginHomePath,
      scope: sessionScope,
      output: "",
      codeSubmitted: false,
      cleaned: false,
      unsubscribeData: () => {},
      unsubscribeExit: () => {},
    };

    const onData = (data: string) => {
      session.output = `${session.output}${data}`.slice(-MAX_OUTPUT_BUFFER_CHARS);
      const url = extractGeminiAuthorizationUrl(session.output);
      if (url) {
        runFork(Deferred.succeed(authorizationUrl, url).pipe(Effect.ignore));
      }
      if (session.codeSubmitted) {
        runFork(completeWhenCredentialsExist);
      }
      if (session.codeSubmitted && outputIndicatesAuthFailure(session.output)) {
        runFork(
          Deferred.fail(
            completion,
            authError("authorization-failed", "Google 인증 코드를 확인하지 못했습니다."),
          ).pipe(Effect.ignore),
        );
      }
    };
    const onExit = (event: PtyAdapter.PtyExitEvent) => {
      runFork(
        Deferred.fail(
          authorizationUrl,
          authError(
            "authorization-url-missing",
            `Gemini CLI가 로그인 주소를 표시하기 전에 종료되었습니다 (종료 코드 ${event.exitCode}).`,
          ),
        ).pipe(Effect.ignore),
      );
      runFork(
        completeWhenCredentialsExist.pipe(
          Effect.flatMap((credentialsExist) =>
            credentialsExist
              ? Effect.void
              : Deferred.fail(
                  completion,
                  authError(
                    "authorization-failed",
                    `Gemini CLI 로그인이 완료되기 전에 종료되었습니다 (종료 코드 ${event.exitCode}).`,
                  ),
                ),
          ),
          Effect.ignore,
        ),
      );
    };
    session.unsubscribeData = authProcess.onData(onData);
    session.unsubscribeExit = authProcess.onExit(onExit);
    sessions.set(id, session);

    const credentialDirectory = path.dirname(stagedCredentialPath);
    const credentialFiles = new Set([
      path.basename(stagedCredentialPath),
      path.basename(stagedEncryptedCredentialPath),
    ]);
    yield* Stream.runForEach(
      fs.watch(credentialDirectory).pipe(
        Stream.filter(
          (event) =>
            credentialFiles.has(event.path) ||
            credentialFiles.has(path.basename(path.resolve(credentialDirectory, event.path))),
        ),
        Stream.debounce(Duration.millis(50)),
      ),
      () => completeWhenCredentialsExist,
    ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(sessionScope));
    yield* Effect.sleep(AUTH_SESSION_TTL).pipe(
      Effect.andThen(
        Deferred.fail(
          completion,
          authError("authorization-timeout", "Google 로그인 제한 시간(5분)이 지났습니다."),
        ).pipe(Effect.ignore),
      ),
      Effect.andThen(Effect.sync(() => runFork(authMutex.withPermits(1)(cleanup(session))))),
      Effect.forkIn(sessionScope),
    );

    return session;
  });

  const begin = Effect.fn("GeminiAuth.begin")(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<GeminiAuthBeginResult, GeminiAuthError> {
    const session = yield* authMutex.withPermits(1)(startSession(instanceId));
    const url = yield* Deferred.await(session.authorizationUrl).pipe(
      Effect.timeoutOption(AUTH_URL_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              authError(
                "authorization-url-missing",
                "Gemini CLI에서 Google 로그인 주소를 받지 못했습니다.",
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.onError(() => authMutex.withPermits(1)(cleanup(session))),
    );
    return yield* authMutex.withPermits(1)(
      Effect.gen(function* () {
        if (session.cleaned || sessions.get(session.id) !== session) {
          return yield* authError(
            "session-not-found",
            "Google 로그인 세션을 찾을 수 없거나 제한 시간이 지났습니다.",
          );
        }
        return {
          sessionId: session.id,
          authorizationUrl: url,
          expiresAt: session.expiresAt,
        };
      }),
    );
  });

  const complete = Effect.fn("GeminiAuth.complete")(function* (
    sessionId: string,
    code: string,
  ): Effect.fn.Return<GeminiAuthCompleteResult, GeminiAuthError> {
    const session = yield* authMutex.withPermits(1)(
      Effect.gen(function* () {
        const activeSession = sessions.get(sessionId);
        if (!activeSession) {
          return yield* authError(
            "session-not-found",
            "Google 로그인 세션을 찾을 수 없거나 제한 시간이 지났습니다.",
          );
        }
        if (activeSession.codeSubmitted) {
          return yield* authError(
            "authorization-failed",
            "이 Google 로그인 세션에는 인증 코드가 이미 제출되었습니다.",
          );
        }
        activeSession.codeSubmitted = true;
        return activeSession;
      }),
    );
    yield* Effect.try({
      try: () => session.process.write(`${code.trim()}\r`),
      catch: (cause) =>
        authError("authorization-failed", `인증 코드를 전달하지 못했습니다: ${String(cause)}`),
    }).pipe(Effect.onError(() => authMutex.withPermits(1)(cleanup(session))));
    yield* session.checkForCredentials.pipe(
      Effect.repeat({ schedule: Schedule.spaced(Duration.millis(500)) }),
      Effect.forkIn(session.scope),
    );

    yield* Deferred.await(session.completion).pipe(
      Effect.timeoutOption(AUTH_COMPLETION_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              authError(
                "authorization-timeout",
                "Google 로그인 응답을 기다리다 시간이 초과되었습니다.",
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.onError(() => authMutex.withPermits(1)(cleanup(session))),
    );

    return yield* authMutex.withPermits(1)(
      Effect.gen(function* () {
        if (session.cleaned || sessions.get(sessionId) !== session) {
          return yield* authError(
            "session-not-found",
            "Google 로그인 세션을 찾을 수 없거나 제한 시간이 지났습니다.",
          );
        }

        const stagedCredentialOption = yield* session.readStagedCredentials;
        if (Option.isNone(stagedCredentialOption)) {
          yield* cleanup(session);
          return yield* authError(
            "authorization-failed",
            "Gemini CLI가 장기 사용 가능한 인증 정보를 만들지 않았습니다. Google 로그인을 다시 시도하세요.",
          );
        }
        const stagedCredentials = stagedCredentialOption.value;
        const stagedAccountPath = path.join(
          session.loginHomePath,
          ".gemini",
          "google_accounts.json",
        );
        const actualAccountPath = path.join(
          session.actualHomePath,
          ".gemini",
          "google_accounts.json",
        );
        const stagedAccount = yield* fs.readFileString(stagedAccountPath).pipe(Effect.option);

        yield* ensureGeminiOAuthSettings({ homePath: session.actualHomePath }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) =>
            authError("storage-failed", `Gemini 로그인 설정을 적용하지 못했습니다: ${cause}`),
          ),
          Effect.onError(() => cleanup(session)),
        );
        const actualCredentialPath = path.join(
          session.actualHomePath,
          ".gemini",
          stagedCredentials.fileName,
        );
        yield* writeFileStringAtomically({
          filePath: actualCredentialPath,
          contents: stagedCredentials.contents,
          mode: 0o600,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) =>
            authError("storage-failed", `Gemini 인증 정보를 적용하지 못했습니다: ${cause.message}`),
          ),
          Effect.onError(() => cleanup(session)),
        );
        const supersededCredentialPath = path.join(
          session.actualHomePath,
          ".gemini",
          stagedCredentials.fileName === "gemini-credentials.json"
            ? "oauth_creds.json"
            : "gemini-credentials.json",
        );
        yield* fs
          .remove(supersededCredentialPath, { force: true })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to remove superseded Gemini credentials.", { cause }),
            ),
          );
        if (Option.isSome(stagedAccount)) {
          yield* writeFileStringAtomically({
            filePath: actualAccountPath,
            contents: stagedAccount.value,
            mode: 0o600,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to promote Gemini account metadata.", { cause }).pipe(
                Effect.andThen(fs.remove(actualAccountPath, { force: true }).pipe(Effect.ignore)),
              ),
            ),
          );
        } else {
          yield* fs.remove(actualAccountPath, { force: true }).pipe(Effect.ignore);
        }

        yield* cleanup(session);
        const email = yield* readGeminiAccountEmail({ homePath: session.actualHomePath }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        return {
          instanceId: session.instance.instanceId,
          ...(email ? { email } : {}),
        };
      }),
    );
  });

  const cancel = Effect.fn("GeminiAuth.cancel")(function* (
    sessionId: string,
  ): Effect.fn.Return<void, GeminiAuthError> {
    yield* authMutex.withPermits(1)(
      Effect.gen(function* () {
        const session = sessions.get(sessionId);
        if (!session) return;
        yield* cleanup(session);
      }),
    );
  });

  return { begin, complete, cancel } as const;
});

export const layer = Layer.effect(GeminiAuth, make);
