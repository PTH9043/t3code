import {
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import {
  LOCAL_OLLAMA_INSTANCE,
  localOllamaSelectionError,
  makeLocalOllamaDiscovery,
  withLocalOllama,
} from "./localOllama.ts";
import { openCodeApiEnvironment } from "./OpenCodeApiConnection.ts";
import { parseOpenCodeModelSlug } from "./opencodeRuntime.ts";
import { resolveTurnDelegateTeam } from "./subagentSelection.ts";

const openCode = ProviderInstanceId.make("opencode");
const instances = {
  [openCode]: {
    driver: ProviderDriverKind.make("opencode"),
    config: { binaryPath: "custom-opencode" },
  },
};
const names = ["org/Model:Q4", "embed:latest", "remote:latest", "unknown:latest"];

it("discovers only installed local completion tags and shares simultaneous metadata reads", async () => {
  let digest = "v1";
  const request = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(
    async (url, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url === "http://127.0.0.1:11434/api/tags") {
        return Response.json({ models: names.map((name) => ({ name, digest })) });
      }
      expect(url).toBe("http://127.0.0.1:11434/api/show");
      const { model } = JSON.parse(String(init?.body));
      const info =
        model === names[1]
          ? { capabilities: ["embedding"] }
          : model === names[2] || digest === "v2"
            ? { capabilities: ["completion"], remote_host: "cloud" }
            : model === names[3]
              ? {}
              : { capabilities: ["completion", "tools"] };
      return Response.json(info);
    },
  );
  const discover = makeLocalOllamaDiscovery(request);
  expect(await Promise.all([discover(), discover()])).toEqual([[names[0]], [names[0]]]);
  expect(request).toHaveBeenCalledTimes(5);
  expect(await discover()).toEqual([names[0]]);
  expect(request).toHaveBeenCalledTimes(6);
  digest = "v2";
  expect(await discover()).toEqual([]);
});

it("preserves explicit and disabled accounts, and leaves no runtime account for an offline daemon", async () => {
  const offline = makeLocalOllamaDiscovery(async () => {
    throw new Error("offline");
  });
  expect(withLocalOllama(instances, await offline())).toBe(instances);
  const disabled = { [openCode]: { ...instances[openCode]!, enabled: false } };
  expect(withLocalOllama(disabled, names)).toBe(disabled);
  const explicit = { ...instances, [LOCAL_OLLAMA_INSTANCE]: disabled[openCode]! };
  expect(withLocalOllama(explicit, names)).toBe(explicit);
});

it("routes the chosen subordinate role and exact tag through the local OpenCode connection", async () => {
  const tags = ["org/Model:Q4"];
  const runtime = withLocalOllama(instances, tags);
  const member = {
    instanceId: LOCAL_OLLAMA_INSTANCE,
    role: "scout" as const,
    model: "t3_ollama/org/Model:Q4",
  };
  const team = resolveTurnDelegateTeam(
    {
      globalSubordinateTeam: [member],
      providerInstances: runtime,
      subordinateModels: [],
    },
    { threadId: ThreadId.make("room"), answeringInstanceId: openCode, forModel: "another" },
  );
  expect(team.members).toEqual([{ ...member, account: "Ollama" }]);
  const settings = Schema.decodeUnknownSync(OpenCodeSettings)(
    runtime[LOCAL_OLLAMA_INSTANCE]!.config,
  );
  expect(settings.binaryPath).toBe("custom-opencode");
  const inline = JSON.parse(
    openCodeApiEnvironment(settings, { T3_OPENCODE_API_KEY: "unrelated" }).OPENCODE_CONFIG_CONTENT!,
  );
  expect(inline.enabled_providers).toEqual(["t3_ollama"]);
  expect(inline.provider.t3_ollama.options).toEqual({
    baseURL: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
  });
  expect(Object.keys(inline.provider.t3_ollama.models)).toEqual(tags);
  const parsed = parseOpenCodeModelSlug(member.model);
  expect(parsed).toEqual({ providerID: "t3_ollama", modelID: tags[0] });
  expect(
    await localOllamaSelectionError(settings.apiConnection, parsed, async () => tags),
  ).toBeUndefined();
  expect(await localOllamaSelectionError(settings.apiConnection, parsed, async () => [])).toContain(
    "unavailable",
  );
  expect(
    await localOllamaSelectionError(
      settings.apiConnection,
      parseOpenCodeModelSlug("paid/org/Model:Q4"),
      async () => tags,
    ),
  ).toContain("exact model");
  expect(() =>
    openCodeApiEnvironment(
      {
        ...settings,
        apiConnection: { ...settings.apiConnection!, baseUrl: "https://example.com" },
      },
      {},
    ),
  ).toThrow("loopback");
});
