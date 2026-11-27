import {
  isValidOpenAiApiModelId,
  OPENAI_API_CONNECTION,
  type ModelCapabilities,
  type OpenCodeSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { LOCAL_OLLAMA_PROVIDER } from "../localOllama.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
} from "../opencodeRuntime.ts";
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2";

const OPENCODE_PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: false,
} as const;
const MINIMUM_OPENCODE_VERSION = "1.14.19";

class OpenCodeProbeError extends Data.TaggedError("OpenCodeProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message: "OpenCode server rejected authentication. Check the server URL and password.",
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured OpenCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted — try reinstalling OpenCode.",
    };
  }

  return {
    installed: true,
    message: detail
      ? `Failed to execute OpenCode CLI health check: ${detail}`
      : "Failed to execute OpenCode CLI health check.",
  };
}

function titleCaseSlug(value: string): string {
  const segments: Array<string> = [];
  for (const segment of value.split(/[-_/]+/)) {
    if (segment.length > 0) {
      segments.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  return segments.join(" ");
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function inferDefaultAgent(agents: ReadonlyArray<Agent>): string | undefined {
  return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? undefined;
}

const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const variantValues = Object.keys(input.model.variants ?? {});
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions = variantValues.map((value) =>
    defaultVariant === value
      ? { id: value, label: titleCaseSlug(value), isDefault: true as const }
      : { id: value, label: titleCaseSlug(value) },
  );
  const primaryAgents = input.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent = inferDefaultAgent(primaryAgents);
  const agentOptions = primaryAgents.map((agent) =>
    defaultAgent === agent.name
      ? { id: agent.name, label: titleCaseSlug(agent.name), isDefault: true as const }
      : { id: agent.name, label: titleCaseSlug(agent.name) },
  );
  return createModelCapabilities({
    optionDescriptors: [
      ...(variantOptions.length > 0
        ? [
            {
              id: "variant",
              label: "Variant",
              type: "select" as const,
              options: variantOptions,
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
      ...(agentOptions.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: agentOptions,
              ...(defaultAgent ? { currentValue: defaultAgent } : {}),
            },
          ]
        : []),
    ],
  });
}

function flattenOpenCodeModels(input: OpenCodeInventory): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models: Array<ServerProviderModel> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const name = nonEmptyTrimmed(model.name);
      if (!name) {
        continue;
      }

      const subProvider = nonEmptyTrimmed(provider.name);
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function apiConnectionModels(
  openCodeSettings: OpenCodeSettings,
): ReadonlyArray<ServerProviderModel> {
  const connection = openCodeSettings.apiConnection;
  if (!connection) return [];
  return connection.models.map((model) => ({
    slug: `${connection.providerId}/${model}`,
    name: model,
    subProvider: connection.providerId,
    isCustom: false,
    capabilities: DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  }));
}

function configuredModels(
  openCodeSettings: OpenCodeSettings,
  discovered: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  // Discovered inventory entries win over configured entries with the same
  // slug: they carry richer per-model capabilities (variants, agents).
  if (
    openCodeSettings.apiConnection?.providerId === OPENAI_API_CONNECTION.providerId ||
    openCodeSettings.apiConnection?.providerId === LOCAL_OLLAMA_PROVIDER
  ) {
    return apiConnectionModels(openCodeSettings).map(
      (model) => discovered.find((item) => item.slug === model.slug) ?? model,
    );
  }
  const seen = new Set<string>();
  const merged: ServerProviderModel[] = [];
  for (const model of [...discovered, ...apiConnectionModels(openCodeSettings)]) {
    if (seen.has(model.slug)) continue;
    seen.add(model.slug);
    merged.push(model);
  }
  return providerModelsFromSettings(
    merged,
    openCodeSettings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
}

export const makePendingOpenCodeProvider = (
  openCodeSettings: OpenCodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = configuredModels(openCodeSettings, []);

    if (!openCodeSettings.enabled) {
      return buildServerProvider({
        presentation: OPENCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message:
            openCodeSettings.serverUrl.trim().length > 0
              ? "OpenCode is disabled in T3 Code settings. A server URL is configured."
              : "OpenCode is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode provider status has not been checked in this session yet.",
      },
    });
  });

export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* (
  openCodeSettings: OpenCodeSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, OpenCodeRuntime> {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const isExternalServer = openCodeSettings.serverUrl.trim().length > 0;

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatOpenCodeProbeError({
      cause,
      isExternalServer,
      serverUrl: openCodeSettings.serverUrl,
    });
    const models = configuredModels(openCodeSettings, []);
    const hasVerifiedApiModels =
      openCodeSettings.apiConnection !== undefined &&
      models.length > 0 &&
      (openCodeSettings.apiConnection.providerId !== LOCAL_OLLAMA_PROVIDER || version !== null);
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: openCodeSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: failure.installed,
        version,
        status: hasVerifiedApiModels ? "ready" : "error",
        auth: { status: hasVerifiedApiModels ? "authenticated" : "unknown", type: "opencode" },
        message: hasVerifiedApiModels
          ? `${models.length} configured API model${models.length === 1 ? "" : "s"} available; OpenCode discovery failed: ${failure.message}`
          : failure.message,
      },
    });
  };

  if (!openCodeSettings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: configuredModels(openCodeSettings, []),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: isExternalServer
          ? "OpenCode is disabled in T3 Code settings. A server URL is configured."
          : "OpenCode is disabled in T3 Code settings.",
      },
    });
  }

  let version: string | null = null;
  if (!isExternalServer) {
    const versionExit = yield* Effect.exit(
      openCodeRuntime
        .runOpenCodeCommand({
          binaryPath: openCodeSettings.binaryPath,
          args: ["--version"],
          environment: resolvedEnvironment,
        })
        .pipe(
          Effect.mapError(
            (cause) => new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
          ),
        ),
    );
    if (versionExit._tag === "Failure") {
      return fallback(Cause.squash(versionExit.cause));
    }
    version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

    if (!version) {
      return fallback(
        new Error(
          `Unable to determine OpenCode version from \`opencode --version\` output. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
        ),
        null,
      );
    }
    if (compareSemverVersions(version, MINIMUM_OPENCODE_VERSION) < 0) {
      return buildServerProvider({
        presentation: OPENCODE_PRESENTATION,
        enabled: openCodeSettings.enabled,
        checkedAt,
        models: configuredModels(openCodeSettings, []),
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
        },
      });
    }
  }

  const inventoryExit = yield* Effect.exit(
    (isExternalServer
      ? Effect.scoped(
          Effect.gen(function* () {
            const server = yield* openCodeRuntime.connectToOpenCodeServer({
              binaryPath: openCodeSettings.binaryPath,
              serverUrl: openCodeSettings.serverUrl,
              environment: resolvedEnvironment,
            });
            return yield* openCodeRuntime.loadOpenCodeInventory(
              openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory: cwd,
                ...(openCodeSettings.serverPassword
                  ? { serverPassword: openCodeSettings.serverPassword }
                  : {}),
              }),
            );
          }),
        )
      : openCodeRuntime.loadInventoryFromCli({
          binaryPath: openCodeSettings.binaryPath,
          environment: resolvedEnvironment,
        })
    ).pipe(
      Effect.mapError(
        (cause) => new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
      ),
    ),
  );
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), version);
  }

  const models = configuredModels(openCodeSettings, flattenOpenCodeModels(inventoryExit.value));
  const connectedCount = inventoryExit.value.providerList.connected.length;
  const isOfficialOpenAi =
    openCodeSettings.apiConnection?.providerId === OPENAI_API_CONNECTION.providerId;
  const invalidOpenAiModels = isOfficialOpenAi
    ? (openCodeSettings.apiConnection?.models.filter((model) => !isValidOpenAiApiModelId(model)) ??
      [])
    : [];
  const hasInvalidOpenAiModel = invalidOpenAiModels.length > 0;
  return buildServerProvider({
    presentation: OPENCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: hasInvalidOpenAiModel
        ? "warning"
        : connectedCount > 0 || models.length > 0
          ? "ready"
          : "warning",
      auth: {
        status:
          !hasInvalidOpenAiModel && (connectedCount > 0 || models.length > 0)
            ? "authenticated"
            : "unknown",
        type: "opencode",
      },
      message: hasInvalidOpenAiModel
        ? `유효하지 않은 OpenAI API 모델 ID가 설정되어 있습니다(${invalidOpenAiModels.join(", ")}). 설정에서 실제 모델 ID(예: gpt-5.4, gpt-5-mini, o3)로 수정하세요.`
        : connectedCount > 0
          ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
          : openCodeSettings.apiConnection && models.length > 0
            ? `${models.length} configured API model${models.length === 1 ? "" : "s"} available.`
            : isExternalServer
              ? "Connected to the configured OpenCode server, but it did not report any connected upstream providers."
              : "OpenCode is available, but it did not report any connected upstream providers.",
    },
  });
});
