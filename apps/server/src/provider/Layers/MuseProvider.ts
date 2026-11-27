import {
  type ModelCapabilities,
  type MuseSettings,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderUsage,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  DEFAULT_MUSE_MODEL_ID,
  makeMuseAcpRuntime,
  resolveMuseAcpBaseModelId,
} from "../acp/MuseAcpSupport.ts";
import {
  hasMuseApiKeyInEnv,
  readMuseAuthSummary,
  resolveMuseBinaryPath,
  resolveMuseConfigDir,
} from "../Drivers/MuseHome.ts";

const MUSE_PRESENTATION = {
  displayName: "Muse Code",
  badgeLabel: "Meta",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const MODEL_LIST_PROBE_TIMEOUT_MS = 12_000;
const USAGE_PROBE_TIMEOUT_MS = 8_000;

const MUSE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_MUSE_MODEL_ID,
    name: "Muse Spark 1.3",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatMuseModelDisplayName(slug: string): string {
  return slug
    .split(/[-_]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      /^[0-9.]+$/u.test(segment)
        ? segment
        : `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`,
    )
    .join(" ");
}

export function parseMuseListModelsOutput(stdout: string): ReadonlyArray<ServerProviderModel> {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  const pushModel = (rawSlug: string, rawName?: string, isDefault?: boolean) => {
    const slug = rawSlug.trim();
    if (!slug || seen.has(slug) || /\s/.test(slug)) return;
    seen.add(slug);
    models.push({
      slug,
      name: rawName?.trim() || formatMuseModelDisplayName(slug),
      isCustom: false,
      ...(isDefault ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    });
  };

  const jsonOption = decodeUnknownJson(trimmed);
  if (Option.isSome(jsonOption)) {
    const parsed = jsonOption.value;
    const entries = Array.isArray(parsed)
      ? parsed
      : isPlainRecord(parsed) && Array.isArray(parsed.models)
        ? parsed.models
        : [];
    for (const entry of entries) {
      if (typeof entry === "string") {
        pushModel(entry);
      } else if (isPlainRecord(entry)) {
        const id =
          typeof entry.id === "string"
            ? entry.id
            : typeof entry.slug === "string"
              ? entry.slug
              : typeof entry.modelId === "string"
                ? entry.modelId
                : typeof entry.model === "string"
                  ? entry.model
                  : undefined;
        if (!id) continue;
        const name = typeof entry.name === "string" ? entry.name : undefined;
        const isDefault = entry.isDefault === true || entry.default === true;
        pushModel(id, name, isDefault);
      }
    }
    return models;
  }

  for (const line of trimmed.split(/\r?\n/u)) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#") || clean.endsWith(":")) continue;
    const normalized = clean.replace(/^[-*•]\s*/u, "").trim();
    const firstToken = normalized.split(/\s+/u)[0];
    if (!firstToken || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(firstToken)) continue;
    const isDefault = /\(default\)/i.test(normalized) || normalized.includes("*");
    pushModel(firstToken.replace(/\*+$/u, ""), undefined, isDefault);
  }

  return models;
}

function parseUsageWindow(raw: unknown, label: string): ServerProviderUsageWindow | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const rawPct =
    typeof raw.usedPercent === "number"
      ? raw.usedPercent
      : typeof raw.used_percent === "number"
        ? raw.used_percent
        : undefined;
  if (rawPct === undefined || !Number.isFinite(rawPct)) return undefined;
  const usedPercent = Math.max(0, Math.min(100, rawPct));
  const rawResetsMs =
    typeof raw.resetsAtMs === "number"
      ? raw.resetsAtMs
      : typeof raw.resets_at_ms === "number"
        ? raw.resets_at_ms
        : undefined;
  const resetsAt =
    rawResetsMs !== undefined && Number.isFinite(rawResetsMs) && rawResetsMs > 0
      ? Math.floor(rawResetsMs > 1e12 ? rawResetsMs / 1000 : rawResetsMs)
      : undefined;
  return {
    label,
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

export function parseMuseUsageJson(
  stdout: string,
  checkedAtIso: string,
): ServerProviderUsage | undefined {
  const parsed = decodeUnknownJson(stdout.trim());
  if (Option.isNone(parsed) || !isPlainRecord(parsed.value)) {
    return undefined;
  }
  const root = isPlainRecord(parsed.value.allowance) ? parsed.value.allowance : parsed.value;
  const primary = parseUsageWindow(root.window, "세션 한도");
  const secondary = parseUsageWindow(root.weekly, "주간 한도");
  const planType =
    typeof root.tier === "string" && root.tier.trim().length > 0 ? root.tier.trim() : undefined;
  if (!primary && !secondary && !planType) {
    return undefined;
  }
  return {
    source: "provider",
    updatedAt: checkedAtIso,
    sessionTokens: 0,
    sessionCount: 0,
    activeSessionCount: 0,
    ...(planType ? { planType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

function museModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = MUSE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function buildMuseDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const currentId = modelState.currentModelId?.trim();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveMuseAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || formatMuseModelDisplayName(slug),
        isCustom: false,
        ...(currentId && slug === currentId ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

export function buildInitialMuseProviderSnapshot(
  museSettings: MuseSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = museModelsFromSettings(museSettings.customModels);

    if (!museSettings.enabled) {
      return buildServerProvider({
        presentation: MUSE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Muse가 T3 Code 설정에서 비활성화되어 있습니다.",
        },
      });
    }

    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Muse Code CLI 상태를 확인하는 중입니다...",
      },
    });
  });
}

const runMuseCliCommand = (
  museSettings: MuseSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = resolveMuseBinaryPath(museSettings.binaryPath, environment);
    const spawnCommand = yield* resolveSpawnCommand(command, args, {
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

const discoverMuseModelsViaAcp = (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeMuseAcpRuntime({
      museSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      noSessionLog: true,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildMuseDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models);
  }).pipe(Effect.scoped);

export const checkMuseProviderStatus = Effect.fn("checkMuseProviderStatus")(function* (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = museModelsFromSettings(museSettings.customModels);

  if (!museSettings.enabled) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Muse가 T3 Code 설정에서 비활성화되어 있습니다.",
      },
    });
  }

  const versionResult = yield* runMuseCliCommand(museSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Muse CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Muse Code CLI (`muse`)가 설치되어 있지 않거나 경로를 찾을 수 없습니다."
          : "Muse Code CLI 상태 확인을 실행하지 못했습니다.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse Code CLI 버전 확인(`muse --version`) 시간이 초과되었습니다.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse Code CLI가 설치되어 있지만 실행에 실패했습니다.",
      },
    });
  }

  const configDir = yield* resolveMuseConfigDir(museSettings, environment);
  const authSummary = yield* readMuseAuthSummary(configDir);
  const hasApiKey = hasMuseApiKeyInEnv(environment);
  const auth: ServerProviderAuth = hasApiKey
    ? {
        status: "authenticated",
        type: "apiKey",
        label: "Meta API 키",
      }
    : authSummary.authenticated
      ? {
          status: "authenticated",
          type: authSummary.mechanism === "api_key" ? "apiKey" : "oauth",
          label:
            authSummary.mechanism === "api_key"
              ? "Meta API 키"
              : authSummary.fullName
                ? `Muse (${authSummary.fullName})`
                : "Muse 계정",
          ...(authSummary.email ? { email: authSummary.email } : {}),
        }
      : {
          status: "unauthenticated",
          ...(authSummary.email ? { email: authSummary.email } : {}),
        };

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: museSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth,
        message:
          authSummary.exists && authSummary.expired
            ? "Muse 로그인 세션이 만료되었습니다. 'Google · Meta 로그인' 버튼으로 다시 로그인하세요."
            : "Muse 계정에 로그인되어 있지 않습니다. 'Google · Meta 로그인' 버튼으로 로그인하거나 META_API_KEY를 설정하세요.",
      },
    });
  }

  let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
  const listModelsExit = yield* runMuseCliCommand(
    museSettings,
    ["exec", "--list-models"],
    environment,
  ).pipe(Effect.timeoutOption(MODEL_LIST_PROBE_TIMEOUT_MS), Effect.exit);

  if (
    Exit.isSuccess(listModelsExit) &&
    Option.isSome(listModelsExit.value) &&
    listModelsExit.value.value.code === 0
  ) {
    discoveredModels = parseMuseListModelsOutput(listModelsExit.value.value.stdout);
  }

  if (discoveredModels.length === 0) {
    const acpDiscoveryExit = yield* discoverMuseModelsViaAcp(museSettings, environment).pipe(
      Effect.timeoutOption(MODEL_LIST_PROBE_TIMEOUT_MS),
      Effect.exit,
    );
    if (Exit.isSuccess(acpDiscoveryExit) && Option.isSome(acpDiscoveryExit.value)) {
      discoveredModels = acpDiscoveryExit.value.value;
    }
  }

  let usage: ServerProviderUsage | undefined;
  if (auth.type === "oauth") {
    const usageExit = yield* runMuseCliCommand(museSettings, ["usage", "--json"], environment).pipe(
      Effect.timeoutOption(USAGE_PROBE_TIMEOUT_MS),
      Effect.exit,
    );
    if (
      Exit.isSuccess(usageExit) &&
      Option.isSome(usageExit.value) &&
      usageExit.value.value.code === 0
    ) {
      usage = parseMuseUsageJson(usageExit.value.value.stdout, checkedAt);
    }
  }

  const models =
    discoveredModels.length > 0
      ? museModelsFromSettings(museSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: museSettings.enabled,
    checkedAt,
    models,
    ...(usage ? { usage } : {}),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export const enrichMuseSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Muse version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
