import type * as EffectAcpSchema from "effect-acp/schema";
import {
  createAndRecordClassifierTelemetry,
  type ClassifierTelemetry,
} from "@t3tools/shared/classifierTelemetry";
import { isProviderContentRefusal, isSafeguardBlock } from "../providerContentRefusal.ts";

/**
 * Antigravity (`agy.exe`) enforces a per-session tool declaration ceiling.
 * In production forensics (2026-11-24), 37 MCP tools (`t3-code` 26 + 11 plugin
 * tools) worked cleanly, whereas 59 MCP tools (`t3-code` placed last behind 4
 * managed servers including 14-tool `t3-filesystem`) silently evicted core
 * `t3-code` tools (`preview_open`, `workspace_memory`), producing
 * `tool <name> is not enabled for server t3-code`.
 *
 * Keep `t3-code` strictly first and budget external managed servers so core
 * product tools are never crowded out.
 */
export const T3_CODE_CORE_ESTIMATED_TOOLS = 26;
export const ANTIGRAVITY_SAFE_MCP_TOOL_BUDGET = 40;

const KNOWN_SERVER_TOOL_ESTIMATES: Readonly<Record<string, number>> = {
  "t3-code": T3_CODE_CORE_ESTIMATED_TOOLS,
  "t3-openai-docs": 5,
  "t3-context7": 2,
  "t3-filesystem": 14,
  "t3-thinking": 1,
  "t3-claude-tools": 10,
};

export interface BudgetedAntigravityMcpResult {
  readonly mcpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly estimatedTotalTools: number;
  readonly budget: number;
  readonly excludedServers: ReadonlyArray<{
    readonly name: string;
    readonly estimatedTools: number;
    readonly reason: "t3_code_only_recovery" | "tool_budget_exceeded";
  }>;
}

export function estimateMcpServerToolCount(
  serverName: string,
  overrides?: Readonly<Record<string, number>>,
): number {
  const override = overrides?.[serverName];
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.round(override);
  }
  return KNOWN_SERVER_TOOL_ESTIMATES[serverName] ?? 6;
}

/**
 * Places `t3-code` first (never evicted) and includes external managed servers
 * only while staying within Antigravity's safe per-session MCP tool budget.
 */
export function buildBudgetedAntigravityMcpServers(input: {
  readonly t3CodeServer?: EffectAcpSchema.McpServer | undefined;
  readonly managedServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly maxTools?: number;
  readonly t3CodeOnly?: boolean;
  readonly estimatedToolsByServerName?: Readonly<Record<string, number>>;
}): BudgetedAntigravityMcpResult {
  const budget = Math.max(
    T3_CODE_CORE_ESTIMATED_TOOLS,
    input.maxTools ?? ANTIGRAVITY_SAFE_MCP_TOOL_BUDGET,
  );
  const mcpServers: EffectAcpSchema.McpServer[] = [];
  const excludedServers: Array<{
    readonly name: string;
    readonly estimatedTools: number;
    readonly reason: "t3_code_only_recovery" | "tool_budget_exceeded";
  }> = [];

  let usedTools = 0;
  if (input.t3CodeServer) {
    mcpServers.push(input.t3CodeServer);
    usedTools += estimateMcpServerToolCount(
      input.t3CodeServer.name,
      input.estimatedToolsByServerName,
    );
  }

  for (const server of input.managedServers) {
    const estimated = estimateMcpServerToolCount(server.name, input.estimatedToolsByServerName);
    if (input.t3CodeOnly) {
      excludedServers.push({
        name: server.name,
        estimatedTools: estimated,
        reason: "t3_code_only_recovery",
      });
      continue;
    }
    if (usedTools + estimated > budget) {
      excludedServers.push({
        name: server.name,
        estimatedTools: estimated,
        reason: "tool_budget_exceeded",
      });
      continue;
    }
    mcpServers.push(server);
    usedTools += estimated;
  }

  return {
    mcpServers,
    estimatedTotalTools: usedTools,
    budget,
    excludedServers,
  };
}

export interface DroppedT3CodeToolDetection {
  readonly toolName: string;
  readonly kind: "not_enabled" | "unknown_tool";
  readonly rawMessage: string;
  readonly telemetry: ClassifierTelemetry<"t3_tool_dropped">;
}

const NOT_ENABLED_FOR_T3_CODE_PATTERN =
  /tool\s+([a-z0-9_.-]+)\s+is\s+not\s+enabled\s+for\s+server\s+t3-code\b/iu;

const UNKNOWN_T3_CODE_TOOL_PATTERN = /unknown\s+tool:\s*["'`]?mcp_t3-code_([a-z0-9_.-]+)["'`]?/iu;

function collectDiagnosticStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDiagnosticStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["rawOutput", "error", "text", "message", "detail", "content"]) {
      if (key in record) collectDiagnosticStrings(record[key], out, depth + 1);
    }
  }
}

/**
 * Detects Antigravity harness errors where a `t3-code` MCP tool was silently
 * dropped/disabled in the active ACP session.
 */
export function detectDroppedT3CodeMcpTool(input: {
  readonly status?: string | undefined;
  readonly rawOutput?: unknown;
  readonly content?: unknown;
  readonly detail?: unknown;
  readonly data?: unknown;
}): DroppedT3CodeToolDetection | undefined {
  const texts: string[] = [];
  collectDiagnosticStrings(input.rawOutput, texts);
  collectDiagnosticStrings(input.content, texts);
  collectDiagnosticStrings(input.detail, texts);
  collectDiagnosticStrings(input.data, texts);

  for (const text of texts) {
    const notEnabledMatch = NOT_ENABLED_FOR_T3_CODE_PATTERN.exec(text);
    if (notEnabledMatch?.[1]) {
      const toolName = notEnabledMatch[1].trim();
      return {
        toolName,
        kind: "not_enabled",
        rawMessage: text.slice(0, 500),
        telemetry: createAndRecordClassifierTelemetry({
          classifier: "gemini_t3_mcp_drop_detector",
          decision: "t3_tool_dropped",
          confidence: 0.99,
          fallbackUsed: false,
          ruleId: "t3_mcp.not_enabled_for_server",
          signalSource: "structured",
        }),
      };
    }
    const unknownMatch = UNKNOWN_T3_CODE_TOOL_PATTERN.exec(text);
    if (unknownMatch?.[1]) {
      const toolName = unknownMatch[1].trim();
      return {
        toolName,
        kind: "unknown_tool",
        rawMessage: text.slice(0, 500),
        telemetry: createAndRecordClassifierTelemetry({
          classifier: "gemini_t3_mcp_drop_detector",
          decision: "t3_tool_dropped",
          confidence: 0.98,
          fallbackUsed: false,
          ruleId: "t3_mcp.unknown_eager_tool",
          signalSource: "structured",
        }),
      };
    }
  }
  return undefined;
}

const FALSE_SECURITY_REFUSAL_HINT_PATTERN =
  /(?:권한\s*경계|하네스\s*(?:접근\s*통제|보안|설정)|보안\s*[·・/]?\s*권한\s*경계|도구\s*권한\s*설정|도구\s*&\s*지식|비활성화되어\s*있|직접\s*켜|새\s*(?:대화|세션)(?:으로|로)?\s*(?:넘겨|이어|전환)|cannot\s+modify\s+harness|not\s+enabled\s+for\s+server\s+t3-code|preview_open|workspace_memory)/iu;

/**
 * True only when the turn already suffered a structured `t3-code` MCP tool drop
 * AND the assistant's closing text misinterprets that technical drop as a
 * security/permission boundary or hands manual UI toggles / new-chat work back
 * to the user. Genuine provider safety refusals remain untouched.
 */
export function isFalseSecurityRefusalAfterT3ToolDrop(input: {
  readonly assistantText: string;
  readonly droppedT3Tools: ReadonlyArray<string>;
}): boolean {
  if (input.droppedT3Tools.length === 0) return false;
  const text = input.assistantText.trim();
  if (!text) return false;
  if (isSafeguardBlock(text) || isProviderContentRefusal(text)) {
    return false;
  }
  return FALSE_SECURITY_REFUSAL_HINT_PATTERN.test(text);
}

export function buildT3McpRecoveryPrompt(droppedTools: ReadonlyArray<string>): string {
  const uniqueTools = Array.from(new Set(droppedTools)).filter(Boolean);
  const listed = uniqueTools.map((name) => `\`${name}\` (\`mcp_t3-code_${name}\`)`).join(", ");
  return [
    `[T3 호스트 자동 복구 완료] 직전에 발생한 \`t3-code\` MCP 도구(${listed || "핵심 도구"}) 미노출 오류는 보안 권한 차단이 아니라 Antigravity 세션 도구 선언 상한 초과로 인한 기술적 누락이었습니다.`,
    `T3 호스트가 외부 보조 MCP를 일시 제외하고 \`t3-code\` 최우선 단독 구성으로 현재 대화 세션을 자동 재연결해 복구했습니다.`,
    `사용자에게 수동 설정이나 새 대화 전환을 요구하지 말고, 지금 바로 복구된 \`t3-code\` 도구를 호출해 원래 사용자 요청을 끝까지 완료한 뒤 최종 결과를 보고하세요.`,
  ].join("\n");
}
