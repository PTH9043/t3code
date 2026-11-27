// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  type TelegramChannelCliPolicy,
  type TelegramChannelsStatusResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolveClaudeSdkExecutablePath } from "../provider/Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { systemPrompt, type SummaryRequest } from "./summary.ts";
import { codexUnavailable, createTelegramCodexCli } from "./codexCli.ts";

export interface TelegramCli {
  listModels(): Promise<TelegramChannelsStatusResult["cliModels"]>;
  unsupported?(
    choices: TelegramChannelsStatusResult["cliModels"],
  ): Promise<NonNullable<TelegramChannelsStatusResult["unsupportedCli"]>>;
  generate(
    selection: TelegramChannelCliPolicy,
    input: SummaryRequest,
    signal: AbortSignal,
  ): Promise<string>;
}
export type TelegramCliServices = {
  registry: Pick<ProviderInstanceRegistryShape, "listInstances">;
  settings: Pick<ServerSettingsService["Service"], "getSettings">;
};
const decodeClaudeConfig = Schema.decodeUnknownSync(ClaudeSettings);
const automaticModels = new Set([
  "auto",
  "default",
  "opus",
  "sonnet",
  "haiku",
  "opusplan",
  "fable",
]);
const foreignRoute =
  /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS)|CLAUDE_CODE_(?:USE_.+|FALLBACK_MODEL|SUBAGENT_MODEL))$/iu;

// Only drivers with an enforceable no-tool prompt path belong in this catalog.
// Claude's SDK launches the configured CLI and checks the account in that same
// child before the async input stream is allowed to yield any channel content.
function createClaudeCli({ registry, settings }: TelegramCliServices): TelegramCli {
  async function accounts() {
    const [instances, cfg] = await Promise.all([
      Effect.runPromise(registry.listInstances),
      Effect.runPromise(settings.getSettings),
    ]);
    const entries = await Promise.all(
      instances.map(async (instance) => {
        if (instance.driverKind !== "claudeAgent" || !instance.enabled) return [];
        const entry = cfg.providerInstances[instance.instanceId];
        if (entry && (entry.driver !== instance.driverKind || entry.enabled === false)) return [];
        const config = entry
          ? decodeClaudeConfig(entry.config)
          : instance.instanceId === "claudeAgent"
            ? cfg.providers.claudeAgent
            : null;
        if (!config || !config.enabled || config.authMode === "api-key" || config.launchArgs.trim())
          return [];
        const env = mergeProviderInstanceEnvironment(entry?.environment);
        if (Object.entries(env).some(([k, v]) => v?.trim() && foreignRoute.test(k))) return [];
        const snap = await Effect.runPromise(instance.snapshot.getSnapshot);
        if (
          !snap.enabled ||
          !snap.installed ||
          snap.availability === "unavailable" ||
          snap.auth.status !== "authenticated" ||
          !snap.auth.type ||
          /api.?key|bedrock|vertex|gateway|foundry/iu.test(snap.auth.type)
        )
          return [];
        return snap.models
          .filter((m) => m.slug.trim() && !automaticModels.has(m.slug.toLowerCase()))
          .map((m) => ({
            choice: {
              instanceId: instance.instanceId,
              modelId: m.slug,
              accountLabel: instance.displayName || snap.auth.label || instance.instanceId,
            },
            config,
            env,
            accountEmail: snap.auth.email,
          }));
      }),
    );
    return entries.flat();
  }
  return {
    async listModels() {
      return (await accounts()).map((e) => e.choice);
    },
    async generate(selection, input, signal) {
      const e = (await accounts()).find(
        ({ choice }) =>
          choice.instanceId === selection.instanceId && choice.modelId === selection.modelId,
      );
      if (!selection.allowExternalTransfer || !e)
        throw new Error("등록된 CLI 계정과 정확한 모델이 필요합니다.");
      const env = await Effect.runPromise(
        makeClaudeEnvironment(e.config, e.env).pipe(Effect.provide(Path.layer)),
      );
      const binary = await Effect.runPromise(
        resolveClaudeSdkExecutablePath(e.config.binaryPath, env),
      );
      signal.throwIfAborted();
      const root = NodePath.resolve(NodeOS.tmpdir());
      const cwd = await NodeFSP.mkdtemp(NodePath.join(root, "t3-telegram-summary-"));
      try {
        return await generateWithClaude(
          { env, binary, cwd, model: selection.modelId, accountEmail: e.accountEmail },
          input,
          signal,
        );
      } finally {
        if (NodePath.dirname(NodePath.resolve(cwd)) === root)
          await NodeFSP.rm(cwd, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  };
}
const reasons: Record<string, string> = {
  codex: codexUnavailable,
  claudeAgent: "로그인된 구독 CLI와 도구 없이 호출할 정확한 모델이 필요합니다.",
  cursor: "현재 Cursor ACP 경로는 도구 없는 생성과 응답 모델 ID를 함께 보증하지 않습니다.",
  gemini: "현재 Antigravity ACP 경로에서 내장 도구 전체를 끄는 기능을 확인할 수 없습니다.",
  grok: "Grok의 내장 도구 설정만으로 플러그인 및 MCP 도구까지 차단할 수 없습니다.",
  opencode: "이 OpenCode 연결에서는 선택한 모델의 CLI 로그인 경로와 인증을 확인할 수 없습니다.",
};
export function createTelegramCli(
  services: TelegramCliServices,
  additional: readonly TelegramCli[] = [],
): TelegramCli {
  const adapters = [createClaudeCli(services), createTelegramCodexCli(services), ...additional];
  return {
    async listModels() {
      return (await Promise.all(adapters.map((a) => a.listModels()))).flat();
    },
    async unsupported(choices) {
      const instances = await Effect.runPromise(services.registry.listInstances);
      const specific = (
        await Promise.all(adapters.map((a) => a.unsupported?.(choices) ?? []))
      ).flat();
      return instances
        .filter((i) => i.enabled && !choices.some((m) => m.instanceId === i.instanceId))
        .map((i) => ({
          instanceId: i.instanceId,
          driver: i.driverKind,
          accountLabel: i.displayName || i.instanceId,
          reason:
            specific.find((row) => row.instanceId === i.instanceId)?.reason ??
            reasons[i.driverKind] ??
            "이 드라이버에는 검증된 요약 전용 CLI 호출 경로가 없습니다.",
        }));
    },
    async generate(selection, input, signal) {
      for (const adapter of adapters) {
        if (
          (await adapter.listModels()).some(
            (m) => m.instanceId === selection.instanceId && m.modelId === selection.modelId,
          )
        ) {
          signal.throwIfAborted();
          return adapter.generate(selection, input, signal);
        }
      }
      throw new Error("선택한 CLI 모델을 사용할 수 없습니다.");
    },
  };
}
type Launch = {
  env: NodeJS.ProcessEnv;
  binary: string;
  cwd: string;
  model: string;
  accountEmail: string | undefined;
};
export async function generateWithClaude(
  launch: Launch,
  input: SummaryRequest,
  signal: AbortSignal,
  create: typeof query = query,
) {
  const controller = new AbortController();
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  const abort = () => controller.abort();
  timeout.throwIfAborted();
  timeout.addEventListener("abort", abort, { once: true });
  const ready = Promise.withResolvers<boolean>();
  let client: ReturnType<typeof query> | undefined;
  try {
    client = create({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        if ((await ready.promise) && !controller.signal.aborted)
          yield {
            type: "user",
            message: { role: "user", content: input.prompt },
            parent_tool_use_id: null,
          };
      })(),
      options: {
        cwd: launch.cwd,
        env: { ...launch.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
        pathToClaudeCodeExecutable: launch.binary,
        abortController: controller,
        model: launch.model,
        systemPrompt,
        tools: [],
        allowedTools: [],
        strictMcpConfig: true,
        mcpServers: {},
        settingSources: [],
        settings: {
          disableAllHooks: true,
          autoMemoryEnabled: false,
          includeGitInstructions: false,
        },
        persistSession: false,
        maxTurns: 1,
        promptSuggestions: false,
        agentProgressSummaries: false,
        extraArgs: { "disable-slash-commands": null },
        canUseTool: async () => ({
          behavior: "deny",
          message: "문서 요약에는 도구를 사용할 수 없습니다.",
        }),
      },
    });
    const { account, models } = await client.initializationResult();
    if (
      account?.apiProvider !== "firstParty" ||
      !account.subscriptionType ||
      (account.apiKeySource && account.apiKeySource !== "none") ||
      (launch.accountEmail && account.email !== launch.accountEmail) ||
      !models.some((m) => (m.resolvedModel ?? m.value) === launch.model)
    )
      throw new Error("CLI 계정 인증 또는 선택한 모델을 확인할 수 없습니다.");
    timeout.throwIfAborted();
    ready.resolve(true);
    let confirmed = false;
    for await (const m of client) {
      if (m.type === "assistant") {
        if (
          m.message.model !== launch.model ||
          m.message.content.some((c) => c.type === "tool_use")
        )
          throw new Error("선택한 CLI 모델의 텍스트 응답을 확인할 수 없습니다.");
        confirmed = true;
      }
      if (m.type === "result" && m.subtype === "success" && !m.is_error && confirmed)
        return m.result;
    }
    throw new Error("CLI가 문서 요약을 마치지 못했습니다.");
  } finally {
    ready.resolve(false);
    controller.abort();
    client?.close();
    timeout.removeEventListener("abort", abort);
  }
}
