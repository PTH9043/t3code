import * as NodeCrypto from "node:crypto";
import {
  OPENAI_API_CONNECTION,
  OPENAI_API_CREDENTIAL_ENV,
  OPENCODE_API_KEY_ENV,
  type OpenCodeSettings,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import { LOCAL_OLLAMA_BASE_URL, LOCAL_OLLAMA_PROVIDER } from "./localOllama.ts";
import { antseedApiBaseUrl } from "./antseedApiUrl.ts";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenCode inline configuration must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

/** Apply a configured API to the same environment used by discovery and execution. */
export function openCodeApiEnvironment(
  settings: OpenCodeSettings,
  environment: NodeJS.ProcessEnv,
  accountEnvironment?: ProviderInstanceEnvironment,
  options?: { readonly baseUrlOverride?: string | undefined },
): NodeJS.ProcessEnv {
  const connection = settings.apiConnection;
  const official = connection?.providerId === OPENAI_API_CONNECTION.providerId;
  const accountKey = accountEnvironment?.find((entry) => entry.name === OPENAI_API_CREDENTIAL_ENV);
  if (
    official &&
    (connection.baseUrl !== OPENAI_API_CONNECTION.baseUrl ||
      connection.protocol !== OPENAI_API_CONNECTION.protocol)
  )
    throw new Error("OpenAI API accounts require the official OpenAI Responses endpoint.");
  if (official && !accountKey?.value.trim())
    throw new Error("This OpenAI API account needs its own API key.");
  if (accountKey && !official)
    throw new Error("An OpenAI API credential requires an official OpenAI API account.");
  if (!connection) return environment;
  if (settings.serverUrl.trim()) {
    throw new Error(
      "API connection settings require a T3-managed OpenCode server. Clear Server URL.",
    );
  }
  const localOllama = connection.providerId === LOCAL_OLLAMA_PROVIDER;
  if (
    localOllama &&
    (connection.baseUrl !== LOCAL_OLLAMA_BASE_URL || connection.protocol !== "chat-completions")
  )
    throw new Error("The local Ollama provider requires the loopback chat completions endpoint.");
  const url = new URL(connection.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("API base URL must be HTTP(S), without credentials, query, or fragment.");
  }
  const inline = environment.OPENCODE_CONFIG_CONTENT?.trim();
  const config = inline ? object(JSON.parse(inline)) : {};
  const providers = config.provider === undefined ? {} : object(config.provider);
  const models = Object.fromEntries(
    connection.models.map((model) => {
      const isExaone = connection.providerId === "t3_exaone" && model === "k-exaone_v2.5";
      const context = isExaone
        ? Math.min(connection.contextTokens ?? 524288, 524288)
        : connection.contextTokens;
      if (isExaone && context !== undefined && context < 2) {
        throw new Error("EXAONE context limit must leave room for input and output.");
      }
      const output =
        isExaone && context !== undefined && (connection.outputTokens ?? context) >= context
          ? Math.min(32000, context - 1)
          : connection.outputTokens;
      return [
        model,
        {
          name: model,
          ...(connection.providerId === "t3_exaone" && model === "k-exaone_v2.5"
            ? {
                reasoning: true,
                tool_call: true,
                interleaved: { field: "reasoning_content" },
                modalities: { input: ["text"], output: ["text"] },
                variants: {
                  low: { reasoningEffort: "low" },
                  high: { reasoningEffort: "high" },
                  max: { reasoningEffort: "max" },
                  medium: { disabled: true },
                },
              }
            : {}),
          // These Antseed names have been verified with actual image requests.
          // Individual network peers may still reject images; surface that error.
          ...(connection.providerId === "t3_antseed" &&
          ["deepseek-v4.1-flash", "kimi-k3.1-pro"].includes(model)
            ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } }
            : {}),
          ...(context || output
            ? {
                limit: {
                  ...(context ? { context } : {}),
                  ...(output ? { output } : {}),
                },
              }
            : {}),
        },
      ];
    }),
  );
  return {
    ...environment,
    ...(official && accountKey ? { [OPENAI_API_CREDENTIAL_ENV]: accountKey.value } : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      enabled_providers: [connection.providerId],
      provider: {
        ...providers,
        [connection.providerId]: {
          npm: connection.protocol === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
          name: connection.providerId,
          options: {
            baseURL:
              options?.baseUrlOverride ??
              (connection.providerId === "t3_antseed"
                ? antseedApiBaseUrl(connection.baseUrl)
                : connection.baseUrl),
            apiKey: localOllama
              ? "ollama"
              : `{env:${official ? OPENAI_API_CREDENTIAL_ENV : OPENCODE_API_KEY_ENV}}`,
          },
          models,
        },
      },
    }),
  };
}

/** An endpoint/storage change cannot silently resume a session in another namespace. */
export function openCodeContinuationKey(
  defaultKey: string,
  settings: OpenCodeSettings,
  environment: NodeJS.ProcessEnv,
): string {
  if (!settings.apiConnection && !settings.serverUrl.trim() && !environment.XDG_DATA_HOME)
    return defaultKey;
  const identity = {
    server: settings.serverUrl.trim(),
    dataHome: environment.XDG_DATA_HOME ?? environment.USERPROFILE ?? environment.HOME ?? "",
    api: settings.apiConnection
      ? {
          provider: settings.apiConnection.providerId,
          endpoint: settings.apiConnection.baseUrl,
          protocol: settings.apiConnection.protocol,
        }
      : null,
  };
  return `${defaultKey}:${NodeCrypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}
