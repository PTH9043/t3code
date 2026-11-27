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
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  makeAntigravityEnvironment,
  resolveAntigravityLaunch,
} from "./Drivers/AntigravityLaunch.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
const GEMINI_DRIVER = ProviderDriverKind.make("gemini");
const AUTH_SESSION_TTL = Duration.minutes(5);
const AUTH_URL_TIMEOUT = Duration.seconds(45);
const AUTH_COMPLETION_TIMEOUT = Duration.seconds(60);
const MAX_OUTPUT_BUFFER_CHARS = 128_000;

function geminiHomesMatch(left: string, right: string): boolean {
  const normalizedLeft = NodePath.normalize(left);
  const normalizedRight = NodePath.normalize(right);
  return NodePath.sep === "\\"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

const decodeGeminiSettings = Schema.decodeUnknownEffect(GeminiSettings);

type GeminiAuthFailureKind = GeminiAuthError["kind"];

interface ResolvedGeminiInstance {
  readonly instanceId: ProviderInstanceId;
  readonly settings: GeminiSettings;
  readonly environment: NodeJS.ProcessEnv;
}

interface ActiveAuthSession {
  readonly id: string;
  readonly instance: ResolvedGeminiInstance;
  readonly process: PtyAdapter.PtyProcess;
  readonly authorizationUrl: Deferred.Deferred<string, GeminiAuthError>;
  readonly completion: Deferred.Deferred<void, GeminiAuthError>;
  readonly expiresAt: string;
  readonly actualHomePath: string;
  readonly scope: Scope.Closeable;
  unsubscribeData: () => void;
  unsubscribeExit: () => void;
  output: string;
  authorizationUrlSeen: boolean;
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
  const match = /https:\/\/accounts\.google\.com\/o\/oauth2\/(?:v2\/)?auth\?[^\s]+/.exec(plain);
  if (!match) return undefined;
  try {
    const parsed = new URL(match[0]);
    if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
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
  const pty = yield* PtyAdapter.PtyAdapter;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const authMutex = yield* Semaphore.make(1);
  const sessions = new Map<string, ActiveAuthSession>();
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
        `Antigravity CLI 계정 '${instanceId}'을(를) 찾을 수 없습니다.`,
      );
    }
    if (envelope.driver !== GEMINI_DRIVER) {
      return yield* authError(
        "wrong-driver",
        `'${instanceId}'은(는) Antigravity CLI 계정이 아닙니다.`,
      );
    }
    const decoded = yield* decodeGeminiSettings(envelope.config ?? {}).pipe(
      Effect.mapError((cause) =>
        authError(
          "storage-failed",
          `Antigravity CLI 계정 설정이 올바르지 않습니다: ${cause.message}`,
        ),
      ),
    );
    const environment = makeAntigravityEnvironment(envelope.environment);
    return { instanceId, settings: decoded, environment };
  });

  const startSession = Effect.fn("GeminiAuth.startSession")(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<ActiveAuthSession, GeminiAuthError> {
    const instance = yield* resolveInstance(instanceId);
    const launch = resolveAntigravityLaunch({
      settings: instance.settings,
      instanceId,
      stateDir: serverConfig.stateDir,
    });
    const actualHomePath = launch.profileDirectory;
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
    yield* fs
      .makeDirectory(actualHomePath, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          authError("storage-failed", "Antigravity 계정 폴더를 열 수 없습니다."),
        ),
      );

    const authProcess = yield* pty
      .spawn({
        shell: launch.command,
        args: [
          ...launch.args.filter((argument) => argument !== "--process-per-session"),
          "--login",
        ],
        cwd: actualHomePath,
        env: { ...instance.environment, NO_BROWSER: "true" },
        cols: 2048,
        rows: 30,
      })
      .pipe(
        Effect.mapError(() =>
          authError(
            "start-failed",
            "Antigravity CLI를 시작하지 못했습니다. 실행 파일 경로를 확인하세요.",
          ),
        ),
      );

    const authorizationUrl = yield* Deferred.make<string, GeminiAuthError>();
    const completion = yield* Deferred.make<void, GeminiAuthError>();
    const sessionScope = yield* Scope.make("sequential");
    const session: ActiveAuthSession = {
      id,
      instance,
      process: authProcess,
      authorizationUrl,
      completion,
      expiresAt,
      actualHomePath,
      scope: sessionScope,
      output: "",
      authorizationUrlSeen: false,
      codeSubmitted: false,
      cleaned: false,
      unsubscribeData: () => {},
      unsubscribeExit: () => {},
    };

    const onData = (data: string) => {
      if (session.codeSubmitted) return;
      session.output = `${session.output}${data}`.slice(-MAX_OUTPUT_BUFFER_CHARS);
      const lineEnd = session.output.lastIndexOf("\n");
      if (lineEnd < 0) return;
      const url = extractGeminiAuthorizationUrl(session.output.slice(0, lineEnd));
      if (url) {
        session.authorizationUrlSeen = true;
        runFork(Deferred.succeed(authorizationUrl, url).pipe(Effect.ignore));
      }
    };
    const onExit = (event: PtyAdapter.PtyExitEvent) => {
      runFork(
        Deferred.fail(
          authorizationUrl,
          authError(
            "authorization-url-missing",
            `Antigravity CLI가 로그인 주소를 표시하기 전에 종료되었습니다 (종료 코드 ${event.exitCode}).`,
          ),
        ).pipe(Effect.ignore),
      );
      runFork(
        (event.exitCode === 0 && (session.codeSubmitted || session.authorizationUrlSeen)
          ? Deferred.succeed(completion, undefined)
          : Deferred.fail(
              completion,
              authError(
                "authorization-failed",
                `Antigravity 로그인이 완료되지 않았습니다 (종료 코드 ${event.exitCode}).`,
              ),
            )
        ).pipe(Effect.ignore),
      );
    };
    session.unsubscribeData = authProcess.onData(onData);
    session.unsubscribeExit = authProcess.onExit(onExit);
    sessions.set(id, session);

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
                "Antigravity CLI에서 Google 로그인 주소를 받지 못했습니다.",
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
        activeSession.output = "";
        return activeSession;
      }),
    );
    const alreadyCompleted = yield* Deferred.isDone(session.completion);
    if (!alreadyCompleted) {
      yield* Effect.try({
        try: () => session.process.write(`${code.trim()}\r`),
        catch: (cause) =>
          authError("authorization-failed", `인증 코드를 전달하지 못했습니다: ${String(cause)}`),
      }).pipe(Effect.onError(() => authMutex.withPermits(1)(cleanup(session))));
    }
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

        yield* cleanup(session);
        return {
          instanceId: session.instance.instanceId,
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
