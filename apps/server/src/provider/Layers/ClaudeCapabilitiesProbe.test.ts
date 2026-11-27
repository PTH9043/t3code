import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  checkClaudeProviderStatus,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  isLegacyClaudeModel,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("keeps only the Claude 5 family out of legacy models", () => {
  assert.deepStrictEqual(
    [
      "claude-fable-5",
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
    ].map((model) => [model, isLegacyClaudeModel(model)]),
    [
      ["claude-fable-5", false],
      ["claude-opus-5-5", false],
      ["claude-opus-5", false],
      ["claude-sonnet-5-5", false],
      ["claude-sonnet-5", false],
      ["claude-opus-4-8", true],
    ],
  );
});

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
    },
    cwd: "/workspace/project",
  });

  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      const workspaceCwd = path.resolve(".");

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          "const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;",
          "let mcpConfig;",
          "if (rawMcpConfig) {",
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          "  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }",
          "}",
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({",
          "  args,",
          "  cwd: process.cwd(),",
          "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
          "  mcpConfig,",
          "}));",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
          "  process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          "    response: {",
          '      subtype: "success",',
          "      request_id: message.request_id,",
          "      response: {",
          '        commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "        agents: [],",
          '        output_style: "default",',
          '        available_output_styles: ["default"],',
          "        models: [],",
          '        account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "      },",
          "    },",
          '  }) + "\\n");',
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );

      assert.deepEqual(capabilities, {
        email: "dev@example.com",
        subscriptionType: "pro",
        tokenSource: "oauth",
        apiKeySource: undefined,
        apiProvider: undefined,
        models: [],
        slashCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "[path]" },
          },
        ],
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), false);
      assert.equal(invocation.mcpConfig, undefined);

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reads 5-hour and weekly subscription limits from get_usage on the same probe process",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-usage-" });
        const executablePath = path.join(tempDir, "fake-claude-usage.mjs");
        const workspaceCwd = path.resolve(".");

        yield* fs.writeFileString(
          executablePath,
          [
            "#!/usr/bin/env node",
            'import { createInterface } from "node:readline";',
            "const lines = createInterface({ input: process.stdin });",
            'lines.on("line", (line) => {',
            "  const message = JSON.parse(line);",
            '  if (message.type !== "control_request") return;',
            '  if (message.request?.subtype === "initialize") {',
            "    process.stdout.write(JSON.stringify({",
            '      type: "control_response",',
            "      response: {",
            '        subtype: "success",',
            "        request_id: message.request_id,",
            "        response: {",
            "          commands: [],",
            "          agents: [],",
            '          output_style: "default",',
            '          available_output_styles: ["default"],',
            "          models: [],",
            '          account: { email: "sub@example.com", subscriptionType: "max", tokenSource: "oauth", apiProvider: "firstParty" },',
            "        },",
            "      },",
            '    }) + "\\n");',
            "    return;",
            "  }",
            '  if (message.request?.subtype === "get_usage") {',
            "    process.stdout.write(JSON.stringify({",
            '      type: "control_response",',
            "      response: {",
            '        subtype: "success",',
            "        request_id: message.request_id,",
            "        response: {",
            "          rate_limits_available: true,",
            "          rate_limits: {",
            '            five_hour: { utilization: 28, resets_at: "2026-11-20T15:00:00.000Z" },',
            '            seven_day: { utilization: 64.5, resets_at: "2026-11-25T00:00:00.000Z" },',
            "          },",
            "        },",
            "      },",
            '    }) + "\\n");',
            "  }",
            "});",
            "setInterval(() => {}, 1_000);",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(executablePath, 0o755);

        const capabilities = yield* probeClaudeCapabilities(
          decodeClaudeSettings({ binaryPath: executablePath }),
          process.env,
          workspaceCwd,
        );

        assert.equal(capabilities?.email, "sub@example.com");
        assert.deepEqual(capabilities?.usage?.rateLimits, {
          primary: {
            label: "5시간",
            usedPercent: 28,
            resetsAt: Date.UTC(2026, 10, 20, 15, 0, 0) / 1_000,
            windowDurationMinutes: 300,
          },
          secondary: {
            label: "7일",
            usedPercent: 64.5,
            resetsAt: Date.UTC(2026, 10, 25, 0, 0, 0) / 1_000,
            windowDurationMinutes: 10_080,
          },
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "leaves provider status ready and capabilities intact when get_usage returns an error",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-usage-err-" });
        const executablePath = path.join(tempDir, "fake-claude-usage-err.mjs");
        const workspaceCwd = path.resolve(".");

        yield* fs.writeFileString(
          executablePath,
          [
            "#!/usr/bin/env node",
            'if (process.argv.includes("--version")) {',
            '  process.stdout.write("2.1.81 (Claude Code)\\n");',
            "  process.exit(0);",
            "}",
            'import { createInterface } from "node:readline";',
            "const lines = createInterface({ input: process.stdin });",
            'lines.on("line", (line) => {',
            "  const message = JSON.parse(line);",
            '  if (message.type !== "control_request") return;',
            '  if (message.request?.subtype === "initialize") {',
            "    process.stdout.write(JSON.stringify({",
            '      type: "control_response",',
            "      response: {",
            '        subtype: "success",',
            "        request_id: message.request_id,",
            "        response: {",
            "          commands: [],",
            "          agents: [],",
            '          output_style: "default",',
            '          available_output_styles: ["default"],',
            "          models: [],",
            '          account: { email: "err@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
            "        },",
            "      },",
            '    }) + "\\n");',
            "    return;",
            "  }",
            '  if (message.request?.subtype === "get_usage") {',
            "    process.stdout.write(JSON.stringify({",
            '      type: "control_response",',
            "      response: {",
            '        subtype: "error",',
            "        request_id: message.request_id,",
            '        error: "unsupported control request",',
            "      },",
            '    }) + "\\n");',
            "  }",
            "});",
            "setInterval(() => {}, 1_000);",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(executablePath, 0o755);

        const settings = decodeClaudeSettings({ binaryPath: executablePath });
        const capabilities = yield* probeClaudeCapabilities(settings, process.env, workspaceCwd);
        assert.equal(capabilities?.email, "err@example.com");
        assert.equal(capabilities?.usage, undefined);

        const versionShimPath =
          process.platform === "win32"
            ? path.join(tempDir, "fake-claude-version.cmd")
            : executablePath;
        if (process.platform === "win32") {
          yield* fs.writeFileString(versionShimPath, "@echo 2.1.81 (Claude Code)\r\n");
        }
        const status = yield* checkClaudeProviderStatus(
          decodeClaudeSettings({ binaryPath: versionShimPath }),
          () => Effect.succeed(capabilities),
          process.env,
          workspaceCwd,
        );
        assert.equal(status.status, "ready");
        assert.equal(status.usage, undefined);
      }).pipe(Effect.scoped),
  );
});
