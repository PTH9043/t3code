import { describe, expect, it } from "vite-plus/test";
import {
  ANTIGRAVITY_SAFE_MCP_TOOL_BUDGET,
  T3_CODE_CORE_ESTIMATED_TOOLS,
  buildBudgetedAntigravityMcpServers,
  buildT3McpRecoveryPrompt,
  detectDroppedT3CodeMcpTool,
  isFalseSecurityRefusalAfterT3ToolDrop,
} from "./GeminiMcpToolRecovery.ts";

describe("GeminiMcpToolRecovery", () => {
  it("always places t3-code first and trims overflow managed servers within budget", () => {
    const t3Code = {
      type: "http" as const,
      name: "t3-code",
      url: "http://127.0.0.1:13773/mcp",
      headers: [],
    };
    const managed = [
      { type: "http" as const, name: "t3-openai-docs", url: "https://example.com/1", headers: [] },
      { name: "t3-context7", command: "node", args: ["c7.js"], env: [] },
      { name: "t3-filesystem", command: "node", args: ["fs.js"], env: [] },
      { name: "t3-thinking", command: "node", args: ["th.js"], env: [] },
    ];

    const budgeted = buildBudgetedAntigravityMcpServers({
      t3CodeServer: t3Code,
      managedServers: managed,
    });
    expect(budgeted.mcpServers[0]?.name).toBe("t3-code");
    expect(budgeted.mcpServers.map((s) => s.name)).toEqual([
      "t3-code",
      "t3-openai-docs",
      "t3-context7",
      "t3-thinking",
    ]);
    expect(budgeted.estimatedTotalTools).toBe(T3_CODE_CORE_ESTIMATED_TOOLS + 5 + 2 + 1);
    expect(budgeted.estimatedTotalTools).toBeLessThanOrEqual(ANTIGRAVITY_SAFE_MCP_TOOL_BUDGET);
    expect(budgeted.excludedServers).toEqual([
      { name: "t3-filesystem", estimatedTools: 14, reason: "tool_budget_exceeded" },
    ]);
  });

  it("drops all managed servers in t3CodeOnly recovery mode while preserving t3-code", () => {
    const t3Code = {
      type: "http" as const,
      name: "t3-code",
      url: "http://127.0.0.1:13773/mcp",
      headers: [],
    };
    const managed = [
      { type: "http" as const, name: "t3-openai-docs", url: "https://example.com/1", headers: [] },
    ];
    const recovery = buildBudgetedAntigravityMcpServers({
      t3CodeServer: t3Code,
      managedServers: managed,
      t3CodeOnly: true,
    });
    expect(recovery.mcpServers.map((s) => s.name)).toEqual(["t3-code"]);
    expect(recovery.excludedServers).toEqual([
      { name: "t3-openai-docs", estimatedTools: 5, reason: "t3_code_only_recovery" },
    ]);
  });

  it("detects both lazy 'not enabled' and eager 'unknown tool' drops for t3-code", () => {
    const lazy = detectDroppedT3CodeMcpTool({
      status: "failed",
      rawOutput:
        "declaring permissions: model output error: invalid tool call error (invalid_args) tool preview_open is not enabled for server t3-code",
    });
    expect(lazy).toMatchObject({
      toolName: "preview_open",
      kind: "not_enabled",
    });

    const eager = detectDroppedT3CodeMcpTool({
      status: "failed",
      data: {
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: 'Error invalid tool call: unknown tool: "mcp_t3-code_workspace_memory" — check spelling',
            },
          },
        ],
      },
    });
    expect(eager).toMatchObject({
      toolName: "workspace_memory",
      kind: "unknown_tool",
    });

    expect(
      detectDroppedT3CodeMcpTool({
        status: "failed",
        rawOutput: "ENOENT: no such file or directory",
      }),
    ).toBeUndefined();
  });

  it("flags false security refusals after a t3-code tool drop while preserving real provider safeguards", () => {
    expect(
      isFalseSecurityRefusalAfterT3ToolDrop({
        droppedT3Tools: ["preview_open"],
        assistantText:
          "에이전트가 실행 하네스나 T3의 MCP 도구 권한 설정 파일을 직접 수정해 preview_open을 켜는 것은 보안·권한 경계상 불가해요. T3 UI 도구 & 지식에서 직접 켜고 새 대화로 넘겨 주세요.",
      }),
    ).toBe(true);

    // Genuine provider safeguard block must NEVER be mistaken for a recoverable MCP drop.
    expect(
      isFalseSecurityRefusalAfterT3ToolDrop({
        droppedT3Tools: ["preview_open"],
        assistantText: "API Error: Opus 5.5's safeguards flagged this session.",
      }),
    ).toBe(false);

    // No structured drop observed -> never trigger.
    expect(
      isFalseSecurityRefusalAfterT3ToolDrop({
        droppedT3Tools: [],
        assistantText: "권한 경계상 수행할 수 없습니다.",
      }),
    ).toBe(false);

    const prompt = buildT3McpRecoveryPrompt(["preview_open", "preview_open"]);
    expect(prompt).toContain("mcp_t3-code_preview_open");
    expect(prompt).toContain("t3-code");
  });
});
