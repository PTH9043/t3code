// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  CLAUDE_PROMPT_METRICS_FILE,
  computeClaudeFirstPromptBreakdown,
  estimateMixedTokens,
  flattenBreakdownToSpanAttributes,
  measureClaudeAutoLoadedMemory,
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
});
