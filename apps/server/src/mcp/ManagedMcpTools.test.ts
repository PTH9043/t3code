import * as NodeURL from "node:url";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { NodeServices } from "@effect/platform-node";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import {
  codexManagedMcpConfig,
  claudeManagedMcpServers,
  makeManagedMcpDefinitions,
  makeManagedMcpResolver,
  probeManagedMcpServer,
  grokManagedMcpServers,
  getManagedMcpToolCatalog,
  expandMcpEnvironment,
} from "./ManagedMcpTools.ts";

it("maps HTTP authentication and stdio environments to all three native transports", () => {
  const servers = [
    {
      name: "docs",
      transport: "http" as const,
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret" },
    },
    {
      name: "files",
      transport: "stdio" as const,
      command: "node",
      args: ["server.js"],
      env: { MODE: "test" },
    },
  ];
  expect(grokManagedMcpServers(servers)).toEqual([
    {
      name: "docs",
      type: "http",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    },
    { name: "files", command: "node", args: ["server.js"], env: [{ name: "MODE", value: "test" }] },
  ]);
  const claude = claudeManagedMcpServers(servers);
  expect(claude.servers.docs).toMatchObject({
    headers: { Authorization: "${T3_MANAGED_MCP_0_0}" },
  });
  expect(claude.servers.files).toMatchObject({ env: { MODE: "${T3_MANAGED_MCP_1_0}" } });
  expect(JSON.stringify(claude.servers)).not.toContain("Bearer secret");
  expect(claude.environment).toEqual({
    T3_MANAGED_MCP_0_0: "Bearer secret",
    T3_MANAGED_MCP_1_0: "test",
  });
  const codex = codexManagedMcpConfig(servers);
  expect(codex.args).toContain(
    'mcp_servers.docs.env_http_headers."Authorization"="T3_MCP_HTTP_HEADER_0_0"',
  );
  expect(codex.args.join(" ")).not.toContain("Bearer secret");
  expect(codex.environment.T3_MCP_HTTP_HEADER_0_0).toBe("Bearer secret");
  expect(expandMcpEnvironment("Bearer ${TOKEN} ${MISSING:-fallback}", { TOKEN: "value" })).toBe(
    "Bearer value fallback",
  );
  expect(() => expandMcpEnvironment("${T3_MISSING_TEST_VARIABLE}", {})).toThrow(
    "T3_MISSING_TEST_VARIABLE",
  );
});

it("preserves empty HTTP headers while keeping nonempty headers out of the command line", () => {
  const config = codexManagedMcpConfig([
    {
      name: "apps",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { "X-Empty": "", Authorization: "Bearer fixture" },
    },
  ]);
  expect(config.args).toContain('mcp_servers.apps.http_headers."X-Empty"=""');
  expect(config.environment.T3_MCP_HTTP_HEADER_0_0).toBe("Bearer fixture");
  expect(config.args.join(" ")).not.toContain("Bearer fixture");
});

it.effect(
  "uses the nearest project profile and diagnoses unresolved custom secrets without failing the catalog",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-project-" });
      const project = path.join(home, "project");
      const nested = path.join(project, "nested");
      const layer = Layer.mergeAll(
        Config.layerTest(home, home),
        Settings.layerTest({
          mcpTools: { openaiDocs: true },
          mcpProjectProfiles: {
            [project]: { workspaceRoot: project, enabledBuiltins: [] },
            [nested]: { workspaceRoot: nested, enabledBuiltins: ["openaiDocs"] },
          },
          customMcpServers: {
            local: {
              name: "local",
              label: "Local",
              enabled: true,
              providers: ["grok"],
              workspaceRoot: project,
              transport: "http",
              url: "https://example.com/mcp",
              headers: {},
            },
            invalid: {
              name: "invalid",
              label: "Invalid",
              enabled: true,
              providers: ["codex"],
              workspaceRoot: null,
              transport: "http",
              url: "https://example.com/mcp",
              headers: { Authorization: "${T3_UNSET_MCP_FIXTURE_318}" },
            },
          },
        }),
      );
      const resolver = yield* makeManagedMcpResolver().pipe(Effect.provide(layer));
      expect((yield* resolver("grok", project)).map((item) => item.name)).toEqual([
        "t3-custom-local",
      ]);
      expect(
        (yield* resolver("grok", path.join(nested, "child"))).map((item) => item.name),
      ).toEqual(["t3-openai-docs", "t3-custom-local"]);
      expect((yield* resolver("grok", `${project}-sibling`)).map((item) => item.name)).toEqual([
        "t3-openai-docs",
      ]);
      const catalog = yield* getManagedMcpToolCatalog(false, project).pipe(Effect.provide(layer));
      expect(
        catalog.entries.find((entry) => entry.id === "invalid" || entry.id === "custom:invalid"),
      ).toMatchObject({
        status: "error",
        error: "환경 변수 T3_UNSET_MCP_FIXTURE_318이 설정되지 않았습니다.",
      });
      expect(catalog.entries.find((entry) => entry.id === "openaiDocs")).toMatchObject({
        scope: "project",
        enabled: false,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("discovers every page of a real stdio MCP handshake and closes its child", async () => {
  const result = await probeManagedMcpServer(
    {
      name: "fixture",
      transport: "stdio",
      command: process.execPath,
      args: [NodeURL.fileURLToPath(new URL("./fixtures/managed-mcp-server.mjs", import.meta.url))],
    },
    process.cwd(),
  );
  expect(result).toEqual({ tools: ["first_tool", "second_tool"], version: "1.0.0" });
});

it("does not follow an HTTP MCP redirect with authentication headers", async () => {
  let redirectedRequests = 0;
  const destination = NodeHttp.createServer((_request, response) => {
    redirectedRequests++;
    response.end();
  });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const destinationAddress = destination.address();
  if (!destinationAddress || typeof destinationAddress === "string") throw new Error("No port");
  const source = NodeHttp.createServer((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${destinationAddress.port}/mcp` });
    response.end();
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  try {
    const sourceAddress = source.address();
    if (!sourceAddress || typeof sourceAddress === "string") throw new Error("No port");
    await expect(
      probeManagedMcpServer(
        {
          name: "redirect-fixture",
          transport: "http",
          url: `http://127.0.0.1:${sourceAddress.port}/mcp`,
          headers: { Authorization: "Bearer synthetic-secret" },
        },
        process.cwd(),
      ),
    ).rejects.toThrow();
    expect(redirectedRequests).toBe(0);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => source.close(() => resolve())),
      new Promise<void>((resolve) => destination.close(() => resolve())),
    ]);
  }
});

it("serializes Windows paths as Codex config values and preserves Claude transport types", () => {
  const definitions = makeManagedMcpDefinitions({
    toolHome: "D:\\tools",
    cwd: "D:\\project folder",
    claudeExecutable: "C:\\Claude\\cli.js",
    join: (...parts) => parts.join("/"),
  });
  const files = definitions.get("filesystem")!;
  const { args } = codexManagedMcpConfig([files]);
  const serialized = args.find((value) => value.startsWith("mcp_servers.t3-filesystem.args="))!;
  expect(JSON.parse(serialized.split("=").slice(1).join("="))[1]).toBe("D:\\project folder");
  expect(args).toContain('mcp_servers.t3-filesystem.env.ELECTRON_RUN_AS_NODE="1"');
  expect(claudeManagedMcpServers([files])).toMatchObject({
    servers: { "t3-filesystem": { env: { ELECTRON_RUN_AS_NODE: "${T3_MANAGED_MCP_0_0}" } } },
    environment: { T3_MANAGED_MCP_0_0: "1" },
  });
  for (const id of ["context7", "filesystem", "sequentialThinking", "claudeTools"] as const) {
    expect(definitions.get(id)).toMatchObject({ env: { ELECTRON_RUN_AS_NODE: "1" } });
  }
  expect(claudeManagedMcpServers([definitions.get("openaiDocs")!])).toEqual({
    servers: { "t3-openai-docs": { type: "http", url: "https://developers.openai.com/mcp" } },
    environment: {},
  });
  expect(definitions.get("claudeTools")).toMatchObject({
    command: process.execPath,
    args: ["C:\\Claude\\cli.js", "mcp", "serve"],
  });
});

it.effect(
  "loads current settings per session, scopes files to its cwd, and avoids duplicating Claude's own tools",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-tools-" });
      const executable = path.join(home, "claude.exe");
      yield* fs.writeFileString(executable, "fixture");
      const fileEntry = path.join(
        home,
        "tools",
        "mcp",
        "node_modules",
        "@modelcontextprotocol/server-filesystem",
        "dist",
        "index.js",
      );
      yield* fs.makeDirectory(path.dirname(fileEntry), { recursive: true });
      yield* fs.writeFileString(fileEntry, "fixture");
      const { resolver, settingsService } = yield* Effect.gen(function* () {
        const settingsService = yield* Settings.ServerSettingsService;
        const resolver = yield* makeManagedMcpResolver();
        return { resolver, settingsService };
      }).pipe(
        Effect.provide([
          Config.layerTest(home, home),
          Settings.layerTest({
            mcpTools: { filesystem: true, openaiDocs: true, context7: true, claudeTools: true },
            providers: { claudeAgent: { binaryPath: executable } },
          }),
        ]),
      );
      const project = path.join(home, "project-a");
      const codex = yield* resolver("codex", project);
      expect(codex.map((server) => server.name)).toEqual([
        "t3-openai-docs",
        "t3-filesystem",
        "t3-claude-tools",
      ]);
      expect(codex.find((server) => server.name === "t3-filesystem")).toMatchObject({
        args: [fileEntry, project],
      });
      const claude = yield* resolver("claudeAgent", path.join(home, "project-b"));
      expect(claude.map((server) => server.name)).toEqual(["t3-openai-docs", "t3-filesystem"]);
      expect((yield* resolver("grok", project)).map((server) => server.name)).toEqual([
        "t3-openai-docs",
        "t3-filesystem",
      ]);
      // Antigravity (`gemini`) skips native-redundant `t3-filesystem` under default environment scope
      // to protect `t3-code` tool budget, while still receiving non-redundant servers like `t3-openai-docs`.
      expect((yield* resolver("gemini", project)).map((server) => server.name)).toEqual([
        "t3-openai-docs",
      ]);
      // Explicit project profile acts as the reverse state (opt-in override) for `gemini`.
      yield* settingsService.updateSettings({
        mcpProjectProfilesToUpsert: {
          [project]: { workspaceRoot: project, enabledBuiltins: ["openaiDocs", "filesystem"] },
        },
      });
      expect((yield* resolver("gemini", project)).map((server) => server.name)).toEqual([
        "t3-openai-docs",
        "t3-filesystem",
      ]);
      yield* settingsService.updateSettings({ mcpProjectProfileRootsToRemove: [project] });
      expect(yield* resolver("cursor", project)).toEqual([]);
      yield* settingsService.updateSettings({ mcpTools: { filesystem: false } });
      expect((yield* resolver("claudeAgent", project)).map((server) => server.name)).toEqual([
        "t3-openai-docs",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves provider fixtures without runtime services unchanged", () =>
  Effect.gen(function* () {
    const resolver = yield* makeManagedMcpResolver();
    expect(yield* resolver("codex", process.cwd())).toEqual([]);
  }),
);
