// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings } from "@t3tools/contracts";
import { resolveSpawnCommand, type ResolvedSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import { expandHomePath } from "../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import type { TelegramCli, TelegramCliServices } from "./cli.ts";
import { systemPrompt, type SummaryRequest } from "./summary.ts";

const version = "0.170.0";
export const codexUnavailable =
  "Codex 0.170.0의 로그인된 ChatGPT 계정, 정확한 모델, 별도 지침을 불러오지 않는 계정 홈이 필요합니다.";
const inherited = "Codex 계정에 별도 지침이나 실행 설정이 있어 요약 입력을 격리할 수 없습니다.";
const mismatch = "선택한 Codex 로그인 계정 또는 모델을 확인하지 못했습니다.";
const invalidResponse = "Codex가 선택한 모델의 도구 없는 텍스트 요약을 완료하지 못했습니다.";
export class CodexSummaryFailure extends Data.TaggedError("CodexSummaryFailure")<{
  readonly message: string;
}> {}
const decodeConfig = Schema.decodeUnknownSync(CodexSettings);
const textOnlySettings: Record<string, boolean | string | number> = {
  model_provider: "openai",
  web_search: "disabled",
  "tools.experimental_request_user_input.enabled": false,
  "tools.update_plan.enabled": false,
  project_doc_max_bytes: 0,
  "skills.include_instructions": false,
  include_apps_instructions: false,
  include_environment_context: false,
  include_environment_context_time: false,
  include_permissions_instructions: false,
  include_collaboration_mode_instructions: false,
  "memories.use_memories": false,
  "memories.generate_memories": false,
  "features.skip_host_skill_discovery": true,
};
for (const feature of [
  "shell_tool",
  "unified_exec",
  "browser_use",
  "computer_use",
  "plugins",
  "multi_agent",
  "apps",
  "sleep_tool",
  "skill_search",
  "tool_suggest",
  "image_generation",
  "code_mode",
  "goals",
  "hooks",
  "agent_message_board",
  "view_image",
  "default_mode_request_user_input",
  "incremental_tools",
  "incremental_tools_legacy",
  "code_mode_host",
  "multi_agent_v2",
]) {
  textOnlySettings["features." + feature] = false;
}
export const codexSummaryArgs = [
  "app-server",
  "--strict-config",
  ...Object.entries(textOnlySettings).flatMap(([k, v]) => ["-c", k + "=" + JSON.stringify(v)]),
];

// 0.170.0 can transmit tools inside input.additional_tools even when tools is empty.
// This thread-only catalog removes model-advertised code mode and multi-agent capabilities.
export function codexTextCatalog(model: string) {
  return {
    models: [
      {
        slug: model,
        display_name: model,
        description: "",
        default_reasoning_level: "low",
        supported_reasoning_levels: [{ effort: "low", description: "" }],
        shell_type: "disabled",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        base_instructions: systemPrompt,
        truncation_policy: { mode: "tokens", limit: 10000 },
        input_modalities: ["text"],
        supports_search_tool: false,
        node_repl_disabled: true,
        experimental_supported_tools: [],
        support_verbosity: false,
        supports_image_detail_original: false,
      },
    ],
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(mismatch);
  return value as Record<string, unknown>;
}
const harmless = new Set([
  "model",
  "review_model",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "service_tier",
  "approval_policy",
  "sandbox_mode",
  "sandbox_workspace_write",
  "windows",
  "tui",
  "notice",
  "projects",
  "history",
  "cli_auth_credentials_store",
  "forced_chatgpt_workspace_id",
  "forced_login_method",
  "personality",
  "hide_agent_reasoning",
  "show_raw_agent_reasoning",
  "check_for_update_on_startup",
  "preferred_auth_method",
]);

// Check the other configuration layers before starting even an empty thread.
function checkLayers(raw: unknown) {
  const layers = object(raw).layers;
  if (!Array.isArray(layers)) throw new Error(inherited);
  for (const l of layers) {
    const layer = object(l);
    if (object(layer.name).type === "sessionFlags" || layer.disabledReason) continue;
    if (Object.keys(object(layer.config)).some((k) => !harmless.has(k))) throw new Error(inherited);
  }
}
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export async function prepareCodexThread(
  request: Request,
  launch: { email: string; model: string; cwd: string; catalog: string },
) {
  const init = object(
    await request("initialize", {
      clientInfo: { name: "t3_telegram_summary", version: "1" },
      capabilities: { experimentalApi: true },
    }),
  );
  if (
    typeof init.userAgent !== "string" ||
    !init.userAgent.split(" ").some((t) => t.endsWith("/" + version))
  )
    throw new Error(codexUnavailable);
  checkLayers(await request("config/read", { includeLayers: true, cwd: launch.cwd }));
  const verifyAccount = async () => {
    const a = object(object(await request("account/read", { refreshToken: false })).account);
    if (a.type !== "chatgpt" || a.email !== launch.email) throw new Error(mismatch);
  };
  await verifyAccount();
  let cursor: string | null = null;
  const seen = new Set<string>();
  let found = false;
  do {
    const page = object(await request("model/list", cursor ? { cursor } : {}));
    if (!Array.isArray(page.data)) throw new Error(mismatch);
    found = page.data.some((m) => object(m).model === launch.model);
    if (found) break;
    if (page.nextCursor == null) break;
    if (typeof page.nextCursor !== "string" || !page.nextCursor || seen.has(page.nextCursor))
      throw new Error(mismatch);
    cursor = page.nextCursor;
    seen.add(cursor);
  } while (cursor);
  if (!found) throw new Error(mismatch);
  const result = object(
    await request("thread/start", {
      model: launch.model,
      modelProvider: "openai",
      allowProviderModelFallback: false,
      cwd: launch.cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      runtimeWorkspaceRoots: [],
      ephemeral: true,
      baseInstructions: systemPrompt,
      config: { model_catalog_json: launch.catalog },
    }),
  );
  if (!Array.isArray(result.instructionSources) || result.instructionSources.length !== 0)
    throw new Error(inherited);
  const sandbox = object(result.sandbox);
  const id = object(result.thread).id;
  if (
    typeof id !== "string" ||
    !id ||
    result.model !== launch.model ||
    result.modelProvider !== "openai" ||
    result.approvalPolicy !== "never" ||
    sandbox.type !== "readOnly" ||
    sandbox.networkAccess !== false ||
    !Array.isArray(result.runtimeWorkspaceRoots) ||
    result.runtimeWorkspaceRoots.length !== 0
  )
    throw new Error(mismatch);
  await verifyAccount();
  return id;
}
type Launch = { cmd: ResolvedSpawnCommand; env: NodeJS.ProcessEnv; email: string; model: string };
export async function runCodexSummary(launch: Launch, input: SummaryRequest, signal: AbortSignal) {
  const root = NodePath.resolve(NodeOS.tmpdir()),
    cwd = await NodeFSP.mkdtemp(NodePath.join(root, "t3-telegram-codex-"));
  const catalog = NodePath.join(cwd, "text-model.json");
  try {
    await NodeFSP.writeFile(catalog, JSON.stringify(codexTextCatalog(launch.model)), {
      flag: "wx",
    });
    return await Effect.runPromise(
      Effect.gen(function* () {
        const { cmd } = launch;
        if (cmd.shell) return yield* new CodexSummaryFailure({ message: codexUnavailable });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(cmd.command, cmd.args, {
            cwd,
            env: launch.env,
            extendEnv: false,
            shell: false,
          }),
        );
        const ctx = yield* Layer.build(CodexClient.layerChildProcess(child));
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(ctx),
        );
        const runRequest = Effect.runPromiseWith(yield* Effect.context<never>());
        const threadId = yield* Effect.tryPromise({
          try: async (inner) => {
            const request: Request = async (method, params) => {
              const response = await runRequest(client.raw.request(method, params), {
                signal: inner,
              });
              if (method === "initialize")
                await runRequest(client.raw.notify("initialized", {}), { signal: inner });
              return response;
            };
            return prepareCodexThread(request, { ...launch, cwd, catalog });
          },
          catch: (e) =>
            new CodexSummaryFailure({
              message:
                e instanceof Error && [inherited, mismatch].includes(e.message)
                  ? e.message
                  : codexUnavailable,
            }),
        });
        let answer = "";
        const done = Promise.withResolvers<string>();
        // A notification can arrive before the turn/start response.
        yield* Stream.runForEach(client.raw.notifications, (n) =>
          Effect.sync(() => {
            if (!n.params || typeof n.params !== "object") return;
            const p = object(n.params);
            if (
              n.method === "account/updated" ||
              (p.threadId === threadId && n.method === "model/rerouted")
            ) {
              done.resolve("");
              return;
            }
            if (p.threadId !== threadId) return;
            if (n.method === "item/started" || n.method === "item/completed") {
              const item = object(p.item);
              if (!["agentMessage", "userMessage", "reasoning"].includes(String(item.type))) {
                done.resolve("");
                return;
              }
              if (
                n.method === "item/completed" &&
                item.type === "agentMessage" &&
                item.phase !== "commentary" &&
                typeof item.text === "string"
              )
                answer = item.text;
            }
            if (n.method === "turn/completed")
              done.resolve(object(p.turn).status === "completed" ? answer : "");
          }),
        ).pipe(Effect.forkScoped);
        yield* client.raw.request("turn/start", {
          threadId,
          model: launch.model,
          environments: [],
          input: [{ type: "text", text: input.prompt }],
        });
        const result = yield* Effect.promise(() => done.promise);
        if (!result) return yield* new CodexSummaryFailure({ message: invalidResponse });
        return result;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) },
    );
  } finally {
    if (NodePath.dirname(NodePath.resolve(cwd)) === root)
      await NodeFSP.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  }
}
async function hasHomeInstructions(home: string) {
  const files = await Promise.all(
    ["AGENTS.md", "AGENTS.override.md"].map(async (name) => {
      try {
        return (await NodeFSP.stat(NodePath.join(home, name))).size > 0;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code !== "ENOENT";
      }
    }),
  );
  return files.some(Boolean);
}
const hostEnv =
  /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/iu;
export function createTelegramCodexCli({ registry, settings }: TelegramCliServices): TelegramCli {
  const reasons = new Map<string, string>();
  async function accounts() {
    const [instances, cfg] = await Promise.all([
      Effect.runPromise(registry.listInstances),
      Effect.runPromise(settings.getSettings),
    ]);
    const rows = await Promise.all(
      instances
        .filter((i) => i.enabled && i.driverKind === "codex")
        .map(async (i) => {
          const unavailable = (reason: string): never[] => {
            reasons.set(i.instanceId, reason);
            return [];
          };
          const e = cfg.providerInstances[i.instanceId];
          const c =
            e?.driver === "codex" && e.enabled !== false
              ? decodeConfig(e.config)
              : !e && i.instanceId === "codex"
                ? cfg.providers.codex
                : null;
          if (!c?.enabled || c.launchArgs.trim())
            return unavailable("이 Codex 인스턴스의 실행 인수를 격리할 수 없습니다.");
          const env = mergeProviderInstanceEnvironment(e?.environment);
          if (
            env.T3CODE_CODEX_LAUNCH_ARGS?.trim() ||
            e?.environment?.some(
              (v) =>
                v.value.trim() && !hostEnv.test(v.name) && v.name.toUpperCase() !== "CODEX_HOME",
            )
          )
            return unavailable(
              "이 Codex 인스턴스에 별도 인증 또는 실행 환경 변수가 지정되어 있습니다.",
            );
          const snap = await Effect.runPromise(i.snapshot.getSnapshot);
          if (
            !snap.enabled ||
            !snap.installed ||
            snap.availability === "unavailable" ||
            snap.auth.status !== "authenticated" ||
            snap.auth.type !== "chatgpt" ||
            !snap.auth.email
          )
            return unavailable(
              "이 Codex 인스턴스의 ChatGPT 로그인과 계정 이메일을 확인할 수 없습니다.",
            );
          if (snap.version !== version)
            return unavailable(
              "설치된 Codex 버전의 무도구 호출을 확인하지 못했습니다. 검증 버전은 " +
                version +
                "입니다.",
            );
          const home = NodePath.resolve(
            expandHomePath(
              c.shadowHomePath ||
                c.homePath ||
                env.CODEX_HOME ||
                NodePath.join(NodeOS.homedir(), ".codex"),
            ),
          );
          if (await hasHomeInstructions(home))
            return unavailable(
              "Codex 계정 홈의 AGENTS.md 또는 AGENTS.override.md가 요약에 포함될 수 있습니다.",
            );
          reasons.delete(i.instanceId);
          const safeEnv = {
            ...Object.fromEntries(Object.entries(env).filter(([k]) => hostEnv.test(k))),
            CODEX_HOME: home,
          };
          const email = snap.auth.email;
          return snap.models
            .filter((m) => m.slug.trim())
            .map((m) => ({
              choice: {
                instanceId: i.instanceId,
                accountLabel: i.displayName || email,
                modelId: m.slug,
              },
              launch: { binary: c.binaryPath, env: safeEnv, email, model: m.slug },
            }));
        }),
    );
    return rows.flat();
  }
  return {
    async listModels() {
      return (await accounts()).map((x) => x.choice);
    },
    async unsupported(choices) {
      const instances = await Effect.runPromise(registry.listInstances);
      return instances
        .filter(
          (i) =>
            i.enabled &&
            i.driverKind === "codex" &&
            !choices.some((c) => c.instanceId === i.instanceId),
        )
        .map((i) => ({
          instanceId: i.instanceId,
          driver: i.driverKind,
          accountLabel: i.displayName || i.instanceId,
          reason: reasons.get(i.instanceId) || codexUnavailable,
        }));
    },
    async generate(selection, input, signal) {
      const row = (await accounts()).find(
        (x) =>
          x.choice.instanceId === selection.instanceId && x.choice.modelId === selection.modelId,
      );
      if (!selection.allowExternalTransfer || !row) throw new Error(mismatch);
      const cmd = await Effect.runPromise(
        resolveSpawnCommand(row.launch.binary, codexSummaryArgs, { env: row.launch.env }),
      );
      return runCodexSummary({ ...row.launch, cmd }, input, signal);
    },
  };
}
