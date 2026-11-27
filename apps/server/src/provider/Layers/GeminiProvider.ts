import {
  type GeminiSettings,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type { AntigravityLaunch } from "../Drivers/AntigravityLaunch.ts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  discoverGeminiSkills,
  syncAntigravityIsolatedSkillsConfig,
} from "../Drivers/GeminiSkills.ts";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { discoverAntigravityModels, makeGeminiAcpRuntime } from "../acp/GeminiAcpSupport.ts";
import {
  ANTIGRAVITY_USAGE_PROBE_TIMEOUT_MS,
  antigravityAccountUsage,
  parseAntigravityUsageOutput,
} from "../antigravityUsageLimits.ts";

const GEMINI_PRESENTATION = {
  displayName: "Antigravity CLI",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;
const VERSION_PROBE_TIMEOUT_MS = 12_000;
const GEMINI_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const GEMINI_MODEL_CATALOG_TTL_MS = 10 * 60_000;
export const GEMINI_AUTH_COOLDOWN_MS = 2 * 60_000;
export const GEMINI_AUTH_REQUIRED_MESSAGE =
  "Antigravity 로그인 또는 외부 네트워크 연결 확인이 필요합니다. 인터넷 연결이 정상이라면 Antigravity 연결 창에서 다시 로그인(sign in)해 주세요.";

interface CachedGeminiCatalog {
  readonly version: string | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly updatedAtMs: number;
}

const geminiModelCatalogCache = new Map<string, CachedGeminiCatalog>();
const geminiAuthCooldownCache = new Map<string, number>();
const geminiInflightDiscovery = new Map<
  string,
  Deferred.Deferred<
    Exit.Exit<
      Option.Option<{
        readonly models: ReadonlyArray<ServerProviderModel>;
        readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
      }>,
      unknown
    >
  >
>();

function buildGeminiCacheKey(
  geminiSettings: GeminiSettings,
  launch: AntigravityLaunch | undefined,
): string {
  return `${geminiSettings.binaryPath || "agy"}::${launch?.profileDirectory ?? geminiSettings.homePath ?? ""}`;
}

export function clearGeminiAuthCooldown(
  geminiSettings: GeminiSettings,
  launch?: AntigravityLaunch,
): void {
  geminiAuthCooldownCache.delete(buildGeminiCacheKey(geminiSettings, launch));
}

export function clearGeminiModelCatalogCacheForTest(): void {
  geminiModelCatalogCache.clear();
  geminiAuthCooldownCache.clear();
  geminiInflightDiscovery.clear();
}

export function buildInitialGeminiProviderSnapshot(
  geminiSettings: GeminiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = [] as const;

    if (!geminiSettings.enabled) {
      return buildServerProvider({
        presentation: GEMINI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Antigravity CLI availability...",
      },
    });
  });
}

const discoverGeminiModelsViaAcp = (
  geminiSettings: GeminiSettings,
  launch: AntigravityLaunch | undefined,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGeminiAcpRuntime({
      geminiSettings,
      launch,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const models = yield* discoverAntigravityModels(acp, started.sessionSetupResult);
    const rawCommands = yield* acp.getAvailableCommands;
    const slashCommands: ServerProviderSlashCommand[] = rawCommands.map((cmd) => ({
      name: cmd.name,
      ...(cmd.description ? { description: cmd.description } : {}),
      ...(cmd.inputHint ? { input: { hint: cmd.inputHint } } : {}),
    }));
    return { models, slashCommands };
  }).pipe(Effect.scoped);

const runGeminiVersionCommand = (
  geminiSettings: GeminiSettings,
  launch: AntigravityLaunch | undefined,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = launch?.command ?? (geminiSettings.binaryPath || "agy");
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const probeAntigravityUsage = (
  geminiSettings: GeminiSettings,
  launch: AntigravityLaunch | undefined,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const pathOpt = yield* Effect.serviceOption(Path.Path);
    const customUserRoot =
      geminiSettings.homePath.trim().length > 0 && launch?.geminiDir && Option.isSome(pathOpt)
        ? pathOpt.value.dirname(launch.geminiDir)
        : undefined;
    const probeEnv: NodeJS.ProcessEnv = {
      ...environment,
      ...(launch?.geminiDir ? { GEMINI_HOME: launch.geminiDir } : {}),
      ...(customUserRoot ? { HOME: customUserRoot, USERPROFILE: customUserRoot } : {}),
    };
    const command = launch?.command ?? (geminiSettings.binaryPath || "agy");
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["-p", "/usage", "--print-timeout", "15s"],
      { env: probeEnv },
    );
    const result = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: probeEnv,
        shell: spawnCommand.shell,
      }),
    );
    if (result.code !== 0) return undefined;
    const rateLimits = parseAntigravityUsageOutput(result.stdout);
    const fetchedAt = DateTime.formatIso(yield* DateTime.now);
    return antigravityAccountUsage({ fetchedAt, rateLimits });
  }).pipe(
    Effect.timeoutOption(ANTIGRAVITY_USAGE_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) =>
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined,
    ),
  );

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  launch?: AntigravityLaunch,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = [] as const;
  if (launch?.geminiDir) {
    syncAntigravityIsolatedSkillsConfig({ geminiDir: launch.geminiDir });
  }
  const fsOpt = yield* Effect.serviceOption(FileSystem.FileSystem);
  const pathOpt = yield* Effect.serviceOption(Path.Path);
  const discoveredSkills =
    Option.isSome(fsOpt) && Option.isSome(pathOpt)
      ? yield* discoverGeminiSkills(geminiSettings, {
          ...(launch?.geminiDir ? { geminiDir: launch.geminiDir } : {}),
          environment,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fsOpt.value),
          Effect.provideService(Path.Path, pathOpt.value),
        )
      : [];

  if (!geminiSettings.enabled) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      skills: discoveredSkills,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Antigravity is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runGeminiVersionCommand(geminiSettings, launch, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Antigravity CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills: discoveredSkills,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Antigravity CLI (`agy`) is not installed or not on PATH."
          : "Failed to execute Antigravity CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills: discoveredSkills,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Antigravity CLI is installed but timed out while running `agy --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Antigravity CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills: discoveredSkills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Antigravity CLI is installed but failed to run.",
      },
    });
  }

  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const cacheKey = buildGeminiCacheKey(geminiSettings, launch);
  const cachedCatalog = geminiModelCatalogCache.get(cacheKey);
  const canReuseCachedCatalog =
    cachedCatalog !== undefined &&
    cachedCatalog.models.length > 0 &&
    cachedCatalog.version === version &&
    nowMs - cachedCatalog.updatedAtMs < GEMINI_MODEL_CATALOG_TTL_MS;

  let models: ReadonlyArray<ServerProviderModel>;
  let slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [];
  if (canReuseCachedCatalog) {
    models = cachedCatalog.models;
    slashCommands = cachedCatalog.slashCommands;
  } else {
    const authCooldownUntilMs = geminiAuthCooldownCache.get(cacheKey);
    if (authCooldownUntilMs !== undefined && nowMs < authCooldownUntilMs) {
      yield* Effect.logDebug("Skipping Antigravity ACP probe during auth cooldown.", {
        remainingMs: authCooldownUntilMs - nowMs,
      });
      return buildServerProvider({
        presentation: GEMINI_PRESENTATION,
        enabled: geminiSettings.enabled,
        checkedAt,
        models: fallbackModels,
        skills: discoveredSkills,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unauthenticated" },
          message: GEMINI_AUTH_REQUIRED_MESSAGE,
        },
      });
    }

    const existingInflight = geminiInflightDiscovery.get(cacheKey);
    let discoveryExit: Exit.Exit<
      Option.Option<{
        readonly models: ReadonlyArray<ServerProviderModel>;
        readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
      }>,
      unknown
    >;
    if (existingInflight) {
      discoveryExit = yield* Deferred.await(existingInflight);
    } else {
      const inflight = yield* Deferred.make<
        Exit.Exit<
          Option.Option<{
            readonly models: ReadonlyArray<ServerProviderModel>;
            readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
          }>,
          unknown
        >
      >();
      geminiInflightDiscovery.set(cacheKey, inflight);
      discoveryExit = yield* discoverGeminiModelsViaAcp(geminiSettings, launch, environment).pipe(
        Effect.timeoutOption(GEMINI_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
        Effect.exit,
        Effect.onExit((outerExit) =>
          Effect.sync(() => {
            if (geminiInflightDiscovery.get(cacheKey) === inflight) {
              geminiInflightDiscovery.delete(cacheKey);
            }
          }).pipe(
            Effect.andThen(
              Deferred.succeed(
                inflight,
                Exit.isSuccess(outerExit) ? outerExit.value : Exit.failCause(outerExit.cause),
              ).pipe(Effect.ignore),
            ),
          ),
        ),
      );
    }

    if (Exit.isFailure(discoveryExit)) {
      const authRequired = discoveryExit.cause.reasons.some(
        (reason) =>
          Cause.isFailReason(reason) &&
          typeof reason.error === "object" &&
          reason.error !== null &&
          "_tag" in reason.error &&
          reason.error._tag === "AcpRequestError" &&
          "code" in reason.error &&
          reason.error.code === -32000,
      );
      if (authRequired) {
        geminiModelCatalogCache.delete(cacheKey);
        const completedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
        geminiAuthCooldownCache.set(cacheKey, completedAtMs + GEMINI_AUTH_COOLDOWN_MS);
      }
      yield* Effect.logWarning("Antigravity ACP model discovery failed", {
        errorTag: causeErrorTag(discoveryExit.cause),
        authRequired,
      });
      return buildServerProvider({
        presentation: GEMINI_PRESENTATION,
        enabled: geminiSettings.enabled,
        checkedAt,
        models: fallbackModels,
        skills: discoveredSkills,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: authRequired ? "unauthenticated" : "unknown" },
          message: authRequired
            ? GEMINI_AUTH_REQUIRED_MESSAGE
            : "Antigravity CLI (agy) ACP 세션을 시작하지 못했습니다. 실행 파일과 계정 프로필, 네트워크 연결을 확인해 주세요.",
        },
      });
    }
    if (Option.isNone(discoveryExit.value)) {
      yield* Effect.logWarning(
        `Antigravity ACP model discovery timed out after ${GEMINI_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      );
      return buildServerProvider({
        presentation: GEMINI_PRESENTATION,
        enabled: geminiSettings.enabled,
        checkedAt,
        models: fallbackModels,
        skills: discoveredSkills,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `Antigravity CLI is installed but ACP startup timed out after ${GEMINI_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
        },
      });
    }
    models = discoveryExit.value.value.models;
    slashCommands = discoveryExit.value.value.slashCommands;
    geminiAuthCooldownCache.delete(cacheKey);
    if (models.length > 0) {
      geminiModelCatalogCache.set(cacheKey, {
        version,
        models,
        slashCommands,
        updatedAtMs: nowMs,
      });
    }
  }
  // Only query subscription quota once ACP discovery already confirmed sign-in,
  // so an unauthenticated profile never triggers an interactive login flow.
  const usage = models.length
    ? yield* probeAntigravityUsage(geminiSettings, launch, environment)
    : undefined;
  return buildServerProvider({
    presentation: GEMINI_PRESENTATION,
    enabled: geminiSettings.enabled,
    checkedAt,
    models,
    slashCommands,
    skills: discoveredSkills,
    ...(usage ? { usage } : {}),
    probe: {
      installed: true,
      version,
      status: models.length ? "ready" : "warning",
      ...(models.length
        ? {}
        : {
            message:
              "Antigravity CLI (agy) returned no models for this profile. Check the Antigravity connection and refresh the model list.",
          }),
      auth: { status: models.length ? "authenticated" : "unknown" },
    },
  });
});
