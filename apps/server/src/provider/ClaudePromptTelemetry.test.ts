// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  buildClaudeFirstTurnActualUsage,
  buildClaudeSessionInitMeta,
  CLAUDE_PROMPT_METRICS_FILE,
  computeClaudeFirstPromptBreakdown,
  encodeClaudeProjectDirName,
  estimateMixedTokens,
  flattenBreakdownToSpanAttributes,
  measureClaudeAutoLoadedMemory,
  readClaudeUserEnabledPluginIds,
  writeClaudePromptMetricRecord,
} from "./ClaudePromptTelemetry.ts";

describe("ClaudePromptTelemetry (Wave 1-A1)", () => {
  it("estimates mixed Korean + ASCII token counts conservatively", () => {
    const empty = estimateMixedTokens("");
    expect(empty).toEqual({ chars: 0, estTokens: 0 });

    const ascii = estimateMixedTokens("hello world ".repeat(10));
    expect(ascii.chars).toBe(120);
    expect(ascii.estTokens).toBeGreaterThanOrEqual(30);
    expect(ascii.estTokens).toBeLessThanOrEqual(40);

    const korean = estimateMixedTokens("한국어 문맥 최적화 계측 테스트");
    expect(korean.chars).toBe(17);
    expect(korean.estTokens).toBeGreaterThanOrEqual(9);
  });

  it("recursively measures CLAUDE.md + @import targets without returning body text", () => {
    const tmpDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-claude-tel-"));
    try {
      const secretBody = "TOP_SECRET_NEVER_LOG_THIS_BODY_STRING";
      NodeFs.writeFileSync(
        NodePath.join(tmpDir, "CLAUDE.local.md"),
        `@AGENTS.md\n${secretBody}\n`,
        "utf8",
      );
      NodeFs.writeFileSync(
        NodePath.join(tmpDir, "AGENTS.md"),
        `# Project Instructions\n${"지침 내용 ".repeat(100)}`,
        "utf8",
      );

      const summary = measureClaudeAutoLoadedMemory(tmpDir, {
        homeDir: NodePath.join(tmpDir, "nonexistent-home"),
      });
      expect(summary.filesScanned.map((f) => f.relPath)).toEqual(["CLAUDE.local.md", "AGENTS.md"]);
      expect(summary.importDepthReached).toBe(1);
      expect(summary.totalChars).toBeGreaterThan(600);
      expect(JSON.stringify(summary)).not.toContain(secretBody);
    } finally {
      NodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("computes component breakdown, flattens span attributes, and writes NDJSON without prompt bodies", () => {
    const tmpDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-claude-metrics-"));
    try {
      const secretPrompt = "PRIVATE_USER_SECRET_TEXT_998877";
      const projAgents = `<project_agents_md>\n${"규칙 ".repeat(500)}\n</project_agents_md>`;
      const breakdown = computeClaudeFirstPromptBreakdown({
        threadId: "thread-a1",
        sessionId: "sess-a1",
        cwd: tmpDir,
        model: "claude-opus-5-5",
        isResume: false,
        isExecution: false,
        systemAppendFull: `## Base\nHello\n\n## Conductor mode\nDelegate work\n\n${projAgents}`,
        projectAgentsMdInjected: projAgents,
        subordinateRoster: undefined,
        globalSystemInstructions: undefined,
        conductorEnabled: true,
        firstTurnPromptText: `<t3_routing_moc>요약</t3_routing_moc>\n<t3_conversation_handoff>이전 대화</t3_conversation_handoff>\n${secretPrompt}`,
        pluginCount: 2,
        mcpServerNames: ["t3-code", "runpod"],
        programmaticAgentCount: 1,
      });

      expect(breakdown.components.projectAgentsMdInjected.chars).toBe(projAgents.length);
      expect(breakdown.components.routingMocBlock.chars).toBeGreaterThan(0);
      expect(breakdown.components.handoffBlock.chars).toBeGreaterThan(0);
      expect(breakdown.counts.mcpServerCount).toBe(2);

      const attrs = flattenBreakdownToSpanAttributes(breakdown);
      expect(attrs["claude.prompt.agents_md_injected_chars"]).toBe(projAgents.length);
      expect(attrs["claude.prompt.mcp_server_count"]).toBe(2);

      const wrote = writeClaudePromptMetricRecord(tmpDir, breakdown);
      expect(wrote).toBe(true);
      const rawFile = NodeFs.readFileSync(
        NodePath.join(tmpDir, CLAUDE_PROMPT_METRICS_FILE),
        "utf8",
      );
      expect(rawFile).not.toContain(secretPrompt);
      expect(rawFile).toContain("first_prompt_breakdown");
    } finally {
      NodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("scans standalone project AGENTS.md, AutoMem MEMORY.md, and .claude/rules without CLAUDE.md", () => {
    const tmpDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-claude-oibot-"));
    try {
      const configDir = NodePath.join(tmpDir, "claude-config");
      const projectDir = NodePath.join(tmpDir, "OIBOT");
      NodeFs.mkdirSync(NodePath.join(projectDir, ".claude", "rules"), { recursive: true });
      const encoded = encodeClaudeProjectDirName(projectDir);
      const autoMemDir = NodePath.join(configDir, "projects", encoded, "memory");
      NodeFs.mkdirSync(autoMemDir, { recursive: true });

      NodeFs.writeFileSync(
        NodePath.join(projectDir, "AGENTS.md"),
        `# 프로젝트 원칙\n${"한국어 지침 문장입니다. ".repeat(200)}`,
        "utf8",
      );
      NodeFs.writeFileSync(
        NodePath.join(projectDir, ".claude", "rules", "style.md"),
        "# Style rule\nKeep it concise.",
        "utf8",
      );
      NodeFs.writeFileSync(
        NodePath.join(autoMemDir, "MEMORY.md"),
        "# Auto memory\n기억된 프로젝트 사실",
        "utf8",
      );

      const summary = measureClaudeAutoLoadedMemory(projectDir, { claudeConfigDir: configDir });
      expect(summary.filesScanned.map((f) => f.relPath)).toEqual([
        "AGENTS.md",
        ".claude/rules/style.md",
        "AutoMem:MEMORY.md",
      ]);
      // Calibrated Hangul tokenizer (~2.0 tok/char) should not undercount Korean AGENTS.md by 2.5x.
      const agentsEntry = summary.filesScanned.find((f) => f.relPath === "AGENTS.md")!;
      expect(agentsEntry.estTokens).toBeGreaterThan(agentsEntry.chars * 1.1);
    } finally {
      NodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("classifies session_init_meta sources and computes first_turn_actual_usage unaccounted overhead", () => {
    const initMeta = buildClaudeSessionInitMeta({
      ts: "2026-11-28T10:00:00.000Z",
      threadId: "t1",
      sessionId: "s1",
      cwd: "D:\\__OIBOT",
      model: "claude-opus-5-5[1m]",
      isExecution: false,
      initMsg: {
        tools: [
          "Bash",
          "Read",
          "mcp__t3-code__workspace_memory",
          "mcp__t3-filesystem__read_file",
          "mcp__claude_ai_Claude_Docs__read",
          "mcp__plugin_context-mode_context-mode__ctx_execute",
        ],
        skills: ["plain-skill", "runpod:runpod-mcp", "runpod:runpod-vllm", "anthropic-skills:pdf"],
        slash_commands: ["help", "compact"],
        agents: ["worker"],
        plugins: [{ name: "t3-chat-skills" }, { name: "runpod" }],
        mcp_servers: [
          { name: "t3-code" },
          { name: "t3-filesystem" },
          { name: "claude.ai Claude Docs" },
          { name: "plugin:runpod:runpod" },
        ],
      },
      sessionIsolation: {
        claudeAiConnectorsDisabled: true,
        userPluginsDisabled: false,
        disabledPluginIds: ["runpod@runpod"],
      },
    });
    expect(initMeta.toolsBySource).toEqual({
      builtin: 2,
      "mcp__t3-code": 1,
      "mcp__t3-filesystem": 1,
      mcp__claude_ai_Claude_Docs: 1,
      "mcp__plugin_context-mode_context-mode": 1,
    });
    expect(initMeta.skillsBySource).toEqual({ plain: 1, runpod: 2, "anthropic-skills": 1 });
    expect(initMeta.pluginNames).toEqual(["t3-chat-skills", "runpod"]);
    expect(initMeta.mcpServersByCategory).toEqual({
      t3Managed: 2,
      claudeAiConnectors: 1,
      plugins: 1,
      other: 0,
    });
    expect(initMeta.sessionIsolation).toEqual({
      claudeAiConnectorsDisabled: true,
      userPluginsDisabled: false,
      disabledPluginIds: ["runpod@runpod"],
    });

    const actual = buildClaudeFirstTurnActualUsage({
      ts: "2026-11-28T10:00:02.000Z",
      threadId: "t1",
      sessionId: "s1",
      cwd: "D:\\__OIBOT",
      model: "claude-opus-5-5",
      isResume: false,
      isExecution: false,
      rawUsage: {
        input_tokens: 2,
        cache_creation_input_tokens: 195_000,
        cache_read_input_tokens: 26_611,
        output_tokens: 500,
        cache_creation: { ephemeral_1h_input_tokens: 195_000, ephemeral_5m_input_tokens: 0 },
      },
      systemAppendTokens: 6_000,
      autoLoadedMemoryTokens: 155_000,
      firstTurnPromptTokens: 15_000,
      initCounts: {
        toolsCount: initMeta.toolsCount,
        skillsCount: initMeta.skillsCount,
        slashCommandsCount: initMeta.slashCommandsCount,
        agentsCount: initMeta.agentsCount,
        pluginsCount: initMeta.pluginsCount,
        mcpServersCount: initMeta.mcpServersCount,
      },
    });
    expect(actual?.usage.totalContextTokens).toBe(221_613);
    expect(actual?.usage.cacheCreation1hTokens).toBe(195_000);
    expect(actual?.t3Estimated.accountedSumTokens).toBe(176_000);
    expect(actual?.t3Estimated.unaccountedCliOverheadTokens).toBe(45_613);
  });

  it("reads enabledPlugins keys from Claude config dir without mutating files", () => {
    const tmpDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-claude-plugins-"));
    try {
      NodeFs.writeFileSync(
        NodePath.join(tmpDir, "settings.json"),
        JSON.stringify({
          enabledPlugins: {
            "context-mode@context-mode": true,
            "runpod@runpod": true,
            "already-off@mkt": false,
          },
        }),
        "utf8",
      );
      NodeFs.writeFileSync(
        NodePath.join(tmpDir, "settings.local.json"),
        JSON.stringify({
          enabledPlugins: {
            "runpod@runpod": false,
            "local-only@mkt": true,
          },
        }),
        "utf8",
      );
      expect(readClaudeUserEnabledPluginIds(tmpDir)).toEqual([
        "context-mode@context-mode",
        "local-only@mkt",
      ]);
    } finally {
      NodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
