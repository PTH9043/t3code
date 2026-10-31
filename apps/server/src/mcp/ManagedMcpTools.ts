import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  McpToolsError,
  type ManagedMcpServerConfig,
  type McpToolCatalog,
  type McpToolId,
} from "@t3tools/contracts";
import type * as AcpSchema from "effect-acp/schema";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveClaudeSdkExecutablePath } from "../provider/Drivers/ClaudeExecutable.ts";

export type ManagedMcpServer =
  | {
      readonly name: string;
      readonly transport: "http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
    };

const TOOL_SPECS = [
  {
    id: "openaiDocs",
    name: "OpenAI Docs",
    description: "OpenAI·Codex 공식 문서 검색과 읽기",
    source: "https://developers.openai.com/learn/docs-mcp",
    providers: ["codex", "claudeAgent", "grok"],
    version: null,
  },
  {
    id: "context7",
    name: "Context7",
    description: "라이브러리별 최신 문서와 코드 예제 검색",
    source: "https://github.com/upstash/context7",
    providers: ["codex", "claudeAgent", "grok"],
    version: "4.1.1",
    package: "@upstash/context7-mcp",
  },
  {
    id: "filesystem",
    name: "Project Files",
    description: "현재 작업 폴더 안의 파일 읽기·검색·편집",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    providers: ["codex", "claudeAgent", "grok"],
    version: "2026.8.31",
    package: "@modelcontextprotocol/server-filesystem",
  },
  {
    id: "sequentialThinking",
    name: "Sequential Thinking",
    description: "단계별 문제 분석과 계획 검토",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    providers: ["codex", "claudeAgent", "grok"],
    version: "2026.8.31",
    package: "@modelcontextprotocol/server-sequential-thinking",
  },
  {
    id: "claudeTools",
    name: "Claude Code Tools",
    description: "Codex에서 Claude Code의 파일·검색·셸 도구 사용",
    source: "https://code.claude.com/docs/en/mcp#use-claude-code-as-an-mcp-server",
    providers: ["codex"],
    version: null,
  },
] as const;

const checkedTools = new Map<
  string,
  {
    status: "ready" | "error";
    checkedAt: string;
    tools: string[];
    version: string | null;
    error: string | null;
  }
>();
const encodeCacheDefinition = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function makeManagedMcpDefinitions(input: {
  toolHome: string;
  cwd: string;
  claudeExecutable: string;
  join: (...parts: string[]) => string;
}): ReadonlyMap<McpToolId, ManagedMcpServer> {
  const entry = (pkg: string) =>
    input.join(input.toolHome, "node_modules", pkg, "dist", "index.js");
  const claudeIsScript = /\.[cm]?js$/i.test(input.claudeExecutable);
  // The desktop backend's execPath is Electron; its JavaScript tools must run as Node.
  const nodeEnvironment = { ELECTRON_RUN_AS_NODE: "1" };
  return new Map<McpToolId, ManagedMcpServer>([
    [
      "openaiDocs",
      { name: "t3-openai-docs", transport: "http", url: "https://developers.openai.com/mcp" },
    ],
    [
      "context7",
      {
        name: "t3-context7",
        transport: "stdio",
        command: process.execPath,
        args: [entry("@upstash/context7-mcp")],
        env: nodeEnvironment,
      },
    ],
    [
      "filesystem",
      {
        name: "t3-filesystem",
        transport: "stdio",
        command: process.execPath,
        args: [entry("@modelcontextprotocol/server-filesystem"), input.cwd],
        env: nodeEnvironment,
      },
    ],
    [
      "sequentialThinking",
      {
        name: "t3-thinking",
        transport: "stdio",
        command: process.execPath,
        args: [entry("@modelcontextprotocol/server-sequential-thinking")],
        env: { ...nodeEnvironment, DISABLE_THOUGHT_LOGGING: "true" },
      },
    ],
    [
      "claudeTools",
      {
        name: "t3-claude-tools",
        transport: "stdio",
        command: claudeIsScript ? process.execPath : input.claudeExecutable,
        args: [...(claudeIsScript ? [input.claudeExecutable] : []), "mcp", "serve"],
        ...(claudeIsScript ? { env: nodeEnvironment } : {}),
      },
    ],
  ]);
}

export function expandMcpEnvironment(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const resolved = environment[name] ?? fallback;
      if (resolved === undefined) throw new Error(`환경 변수 ${name}이 설정되지 않았습니다.`);
      return resolved;
    },
  );
}

function customDefinition(config: ManagedMcpServerConfig): ManagedMcpServer {
  const expand = (value: string) => expandMcpEnvironment(value, process.env);
  const fields = (values: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(value)]));
  return config.transport === "http"
    ? {
        name: `t3-custom-${config.name}`,
        transport: "http",
        url: expand(config.url),
        headers: fields(config.headers),
      }
    : {
        name: `t3-custom-${config.name}`,
        transport: "stdio",
        command: expand(config.command),
        args: config.args.map(expand),
        env: fields(config.env),
      };
}

const readDefinitions = Effect.fn("ManagedMcpTools.readDefinitions")(function* (cwd?: string) {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const fs = yield* FileSystem.FileSystem;
  const claudeExecutable = yield* resolveClaudeSdkExecutablePath(
    settings.providers.claudeAgent.binaryPath,
    process.env,
  );
  const toolHome = path.join(config.baseDir, "tools", "mcp");
  const builtinDefinitions = makeManagedMcpDefinitions({
    toolHome,
    cwd: path.resolve(cwd ?? config.cwd),
    claudeExecutable,
    join: path.join,
  });
  const definitions = new Map<string, ManagedMcpServer>(builtinDefinitions);
  const installed = new Map<string, boolean>();
  const configurationErrors = new Map<string, string>();
  const workingDirectory = path.resolve(cwd ?? config.cwd);
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "");
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const matchesRoot = (root: string) => {
    const parent = normalize(root),
      child = normalize(workingDirectory);
    return child === parent || child.startsWith(`${parent}${path.sep}`);
  };
  const projectProfile = Object.values(settings.mcpProjectProfiles)
    .filter((profile) => matchesRoot(profile.workspaceRoot))
    .sort((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];
  const metadata: Array<
    Pick<
      McpToolCatalog["entries"][number],
      | "id"
      | "builtinId"
      | "name"
      | "description"
      | "source"
      | "providers"
      | "version"
      | "scope"
      | "enabled"
    >
  > = [];
  for (const spec of TOOL_SPECS) {
    const definition = definitions.get(spec.id)!;
    metadata.push({
      ...spec,
      builtinId: spec.id,
      providers: [...spec.providers],
      scope: projectProfile ? "project" : "environment",
      enabled: projectProfile
        ? projectProfile.enabledBuiltins.includes(spec.id)
        : settings.mcpTools[spec.id],
    });
    installed.set(
      spec.id,
      definition.transport === "http" ||
        (yield* fs.exists(spec.id === "claudeTools" ? claudeExecutable : definition.args[0]!)),
    );
  }
  for (const server of Object.values(settings.customMcpServers)) {
    if (server.workspaceRoot && !matchesRoot(server.workspaceRoot)) continue;
    const id = `custom:${server.name}`;
    yield* Effect.try({
      try: () => customDefinition(server),
      catch: (cause) =>
        new McpToolsError({
          message: cause instanceof Error ? cause.message : "MCP 설정을 해석하지 못했습니다.",
        }),
    }).pipe(
      Effect.tap((definition) => Effect.sync(() => definitions.set(id, definition))),
      Effect.catch((error) => Effect.sync(() => configurationErrors.set(id, error.message))),
    );
    installed.set(id, true);
    metadata.push({
      id,
      builtinId: null,
      name: server.label,
      description: "사용자 등록 MCP 서버",
      source: server.transport === "http" ? server.url : "https://modelcontextprotocol.io",
      providers: [...server.providers],
      version: null,
      scope: server.workspaceRoot ? "project" : "environment",
      enabled: server.enabled,
    });
  }
  return { definitions, installed, metadata, configurationErrors, cwd: workingDirectory, toolHome };
});

/** New sessions inherit the environment's tools; existing turns keep their original session. */
export const makeManagedMcpResolver = Effect.fn("ManagedMcpTools.makeResolver")(function* () {
  const config = yield* Effect.serviceOption(ServerConfig);
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  if (
    Option.isNone(config) ||
    Option.isNone(settings) ||
    Option.isNone(fs) ||
    Option.isNone(path)
  ) {
    return (_provider: string, _cwd?: string) => Effect.succeed([] as ManagedMcpServer[]);
  }
  return (provider: string, cwd?: string) =>
    readDefinitions(cwd).pipe(
      Effect.provideService(ServerConfig, config.value),
      Effect.provideService(ServerSettingsService, settings.value),
      Effect.provideService(FileSystem.FileSystem, fs.value),
      Effect.provideService(Path.Path, path.value),
      Effect.map(({ definitions, installed, metadata, configurationErrors }) =>
        metadata
          .filter(
            (spec) =>
              spec.enabled &&
              !configurationErrors.has(spec.id) &&
              installed.get(spec.id) &&
              spec.providers.some((kind) => kind === provider),
          )
          .map((spec) => definitions.get(spec.id)!),
      ),
      Effect.catch(() => Effect.succeed([] as ManagedMcpServer[])),
    );
});

export function codexManagedMcpArgs(servers: ReadonlyArray<ManagedMcpServer>): string[] {
  return servers.flatMap((server) => {
    const prefix = `mcp_servers.${server.name}`;
    const config =
      server.transport === "http"
        ? { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) }
        : {
            command: server.command,
            args: server.args,
            ...(server.env ? { env: server.env } : {}),
          };
    return Object.entries(config).flatMap(([key, value]) => {
      if (
        (key === "env" || key === "http_headers") &&
        typeof value === "object" &&
        value !== null
      ) {
        return Object.entries(value).flatMap(([envKey, envValue]) => [
          "-c",
          `${prefix}.${key}.${key === "http_headers" ? JSON.stringify(envKey) : envKey}=${JSON.stringify(envValue)}`,
        ]);
      }
      return ["-c", `${prefix}.${key}=${JSON.stringify(value)}`];
    });
  });
}

export function claudeManagedMcpServers(servers: ReadonlyArray<ManagedMcpServer>) {
  return Object.fromEntries(
    servers.map((server) => [
      server.name,
      server.transport === "http"
        ? {
            type: "http" as const,
            url: server.url,
            ...(server.headers ? { headers: { ...server.headers } } : {}),
          }
        : {
            type: "stdio" as const,
            command: server.command,
            args: [...server.args],
            ...(server.env ? { env: { ...server.env } } : {}),
          },
    ]),
  );
}

export function grokManagedMcpServers(
  servers: ReadonlyArray<ManagedMcpServer>,
): AcpSchema.McpServer[] {
  return servers.map((server) =>
    server.transport === "http"
      ? {
          type: "http" as const,
          name: server.name,
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
        }
      : {
          name: server.name,
          command: server.command,
          args: [...server.args],
          env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
        },
  );
}

/** Initialize and list tools without invoking an agent or a tool that changes files. */
export async function probeManagedMcpServer(server: ManagedMcpServer, cwd: string) {
  const client = new Client({ name: "t3-tool-check", version: "1.0.0" });
  const transport =
    server.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: {
            signal: AbortSignal.timeout(20_000),
            ...(server.headers ? { headers: { ...server.headers } } : {}),
          },
        })
      : new StdioClientTransport({
          command: server.command,
          args: [...server.args],
          cwd,
          stderr: "pipe",
          ...(server.env
            ? { env: { ...process.env, ...server.env } as Record<string, string> }
            : {}),
        });
  let diagnostics = "";
  if (transport instanceof StdioClientTransport)
    transport.stderr?.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-2000);
    });
  try {
    // SDK 1.32's HTTP class declares sessionId as undefined while its Transport type marks it optional.
    await client.connect(transport as Transport, { timeout: 20_000 });
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 20_000 });
      names.push(...result.tools.map((tool) => tool.name));
      cursor = result.nextCursor;
      if (!cursor)
        return { tools: names.slice(0, 200), version: client.getServerVersion()?.version ?? null };
    }
    throw new Error("Tool discovery exceeded eight pages.");
  } catch (cause) {
    let message = cause instanceof Error ? cause.message : "MCP 연결에 실패했습니다.";
    if (diagnostics.trim()) message += ` · ${diagnostics.trim()}`;
    for (const value of Object.values(
      server.transport === "stdio" ? (server.env ?? {}) : (server.headers ?? {}),
    ))
      if (value.length > 5) message = message.replaceAll(value, "[redacted]");
    throw new Error(message.slice(0, 1000), { cause });
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

export const getManagedMcpToolCatalog = Effect.fn("ManagedMcpTools.catalog")(function* (
  check: boolean,
  workspaceRoot?: string,
) {
  const { definitions, installed, metadata, configurationErrors, cwd, toolHome } =
    yield* readDefinitions(workspaceRoot).pipe(
      Effect.mapError(() => new McpToolsError({ message: "MCP 도구 설정을 읽지 못했습니다." })),
    );
  const entries = yield* Effect.forEach(
    metadata,
    (spec) =>
      Effect.gen(function* () {
        const present = installed.get(spec.id) ?? false;
        const base = {
          ...spec,
          installed: present,
          version: spec.version,
          checkedAt: null,
          tools: [] as string[],
          error: null,
        };
        const configurationError = configurationErrors.get(spec.id);
        if (configurationError)
          return { ...base, status: "error" as const, error: configurationError };
        const cacheKey = `${toolHome}:${spec.id}:${encodeCacheDefinition(definitions.get(spec.id))}`;
        if (!present) {
          checkedTools.delete(cacheKey);
          return { ...base, status: "missing" as const };
        }
        if (!check) {
          const checked = checkedTools.get(cacheKey);
          return checked ? { ...base, ...checked } : { ...base, status: "unchecked" as const };
        }
        const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        return yield* Effect.tryPromise({
          try: () => probeManagedMcpServer(definitions.get(spec.id)!, cwd),
          catch: (cause) =>
            new McpToolsError({
              message:
                cause instanceof Error ? cause.message.slice(0, 300) : "MCP 연결에 실패했습니다.",
            }),
        }).pipe(
          Effect.map((result) => ({
            ...base,
            status: "ready" as const,
            version: spec.version ?? result.version,
            checkedAt,
            tools: result.tools,
          })),
          Effect.catch((error) =>
            Effect.succeed({
              ...base,
              status: "error" as const,
              checkedAt,
              error: error.message.slice(0, 300),
            }),
          ),
          Effect.tap((entry) =>
            Effect.sync(() => {
              checkedTools.set(cacheKey, {
                status: entry.status,
                checkedAt,
                tools: entry.tools,
                version: entry.version,
                error: entry.error,
              });
            }),
          ),
        );
      }),
    { concurrency: 2 },
  );
  return { entries } satisfies McpToolCatalog;
});
