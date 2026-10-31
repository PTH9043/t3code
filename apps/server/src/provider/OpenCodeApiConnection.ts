import * as NodeCrypto from "node:crypto";
import { OPENCODE_API_KEY_ENV, type OpenCodeSettings } from "@t3tools/contracts";

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
): NodeJS.ProcessEnv {
  const connection = settings.apiConnection;
  if (!connection) return environment;
  if (settings.serverUrl.trim()) {
    throw new Error(
      "API connection settings require a T3-managed OpenCode server. Clear Server URL.",
    );
  }
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
    connection.models.map((model) => [
      model,
      {
        name: model,
        ...(connection.contextTokens || connection.outputTokens
          ? {
              limit: {
                ...(connection.contextTokens ? { context: connection.contextTokens } : {}),
                ...(connection.outputTokens ? { output: connection.outputTokens } : {}),
              },
            }
          : {}),
      },
    ]),
  );
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      enabled_providers: [connection.providerId],
      provider: {
        ...providers,
        [connection.providerId]: {
          npm: connection.protocol === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
          name: connection.providerId,
          options: { baseURL: connection.baseUrl, apiKey: `{env:${OPENCODE_API_KEY_ENV}}` },
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
