import {
  LOCAL_OLLAMA_INSTANCE,
  ProviderDriverKind,
  ProviderInstanceId,
  type OpenCodeApiConnection,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";

export { LOCAL_OLLAMA_INSTANCE };
export const LOCAL_OLLAMA_PROVIDER = "t3_ollama";
const origin = "http://127.0.0.1:11434";
export const LOCAL_OLLAMA_BASE_URL = origin + "/v1";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function cloud(model: Record<string, unknown>): boolean {
  return Boolean(model.remote_model || model.remote_host);
}

/** Tags includes embeddings and cloud manifests. Only /show identifies local completion models. */
export function makeLocalOllamaDiscovery(
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
) {
  const known = new Map<string, boolean>();
  let pending: Promise<string[]> | undefined;
  async function discover() {
    const signal = AbortSignal.timeout(2500);
    const options = { signal, redirect: "error" as const };
    const tags = await request(origin + "/api/tags", options);
    if (!tags.ok) return [];
    const { models } = record(await tags.json());
    if (!Array.isArray(models)) return [];
    const found = new Set<string>();
    const current = new Set<string>();
    const entries = models[Symbol.iterator]();
    async function inspect() {
      for (const item of entries) {
        const tag = record(item);
        const name = tag.name;
        if (typeof name !== "string" || !name.trim() || cloud(tag)) continue;
        const key = typeof tag.digest === "string" && tag.digest ? name + "\0" + tag.digest : "";
        if (key) current.add(key);
        let completion = key ? known.get(key) : undefined;
        if (completion === undefined) {
          try {
            const response = await request(origin + "/api/show", {
              ...options,
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model: name }),
            });
            if (!response.ok) continue;
            const info = record(await response.json());
            completion =
              !cloud(info) &&
              Array.isArray(info.capabilities) &&
              info.capabilities.includes("completion");
            if (key) known.set(key, completion);
          } catch {
            continue;
          }
        }
        if (completion) found.add(name);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, models.length) }, inspect));
    for (const key of known.keys()) if (!current.has(key)) known.delete(key);
    return [...found].sort();
  }
  return () =>
    (pending ??= discover()
      .catch(() => [])
      .finally(() => {
        pending = undefined;
      }));
}

export const discoverLocalOllama = makeLocalOllamaDiscovery();

export async function localOllamaSelectionError(
  connection: OpenCodeApiConnection | undefined,
  model: { readonly providerID: string; readonly modelID: string } | null | undefined,
  discover = discoverLocalOllama,
): Promise<string | undefined> {
  if (connection?.providerId !== LOCAL_OLLAMA_PROVIDER) return;
  if (model?.providerID !== LOCAL_OLLAMA_PROVIDER || !connection.models.includes(model.modelID))
    return "Select an exact model configured on this local Ollama instance.";
  if (!(await discover()).includes(model.modelID))
    return "The selected model is unavailable for local generation in Ollama.";
}

/** This adapter exists only in the runtime registry. User-owned settings take precedence. */
export function withLocalOllama(
  instances: ProviderInstanceConfigMap,
  models: readonly string[],
): ProviderInstanceConfigMap {
  if (Object.hasOwn(instances, LOCAL_OLLAMA_INSTANCE)) return instances;
  const openCode = instances[ProviderInstanceId.make("opencode")];
  const config = record(openCode?.config);
  if (openCode?.driver !== "opencode" || !(openCode.enabled ?? config.enabled ?? true))
    return instances;
  if (!models.length) return instances;
  const apiConnection: OpenCodeApiConnection = {
    providerId: LOCAL_OLLAMA_PROVIDER,
    protocol: "chat-completions",
    baseUrl: LOCAL_OLLAMA_BASE_URL,
    models,
  };
  return {
    ...instances,
    [LOCAL_OLLAMA_INSTANCE]: {
      driver: ProviderDriverKind.make("opencode"),
      displayName: "Ollama",
      config: {
        ...(typeof config.binaryPath === "string" ? { binaryPath: config.binaryPath } : {}),
        apiConnection,
      },
    },
  };
}
