// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { RotatingFileSink } from "@t3tools/shared/logging";

/**
 * Wave 1-A1: 새 Claude 세션 첫 프롬프트 구성 요소별 크기 계측기 (본문 절대 미저장).
 *
 * 기록 항목:
 * - T3 개발자 지시 (base, conductor, subordinateRoster)
 * - 프로젝트 지시 (`projectAgentInstructions` — AGENTS.md 주입분)
 * - 글로벌 시스템 지시 (`globalSystemInstructions`)
 * - 채팅 스킬 (`<t3_skills>`, 플러그인 수)
 * - 워크스페이스 프롬프트 · 기억 주입 (`# 프로젝트 문맥`, `<t3_routing_moc>`, `<t3_memory>`, `<t3_document_rag>`)
 * - 대화 이어받기 요약 (`<t3_conversation_handoff>`, `<t3_adaptive_handoff>`, `<t3_precomputed_compaction>`)
 * - Claude Code 자동 로드 파일 (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `~/.claude/CLAUDE.md` 및 재귀 `@import`)
 * - 세션 `init` 메타 (도구 수, 스킬 수, 슬래시 명령 수, 에이전트 수, MCP 서버 목록)
 *
 * 주의: 프롬프트 원문이나 파일 본문은 절대 기록하지 않고 오직 글자 수·추정 토큰 수·개수만 남긴다.
 */

export const CLAUDE_PROMPT_METRICS_FILE = "claude-prompt-metrics.ndjson";
const METRICS_MAX_BYTES = 5 * 1024 * 1024;
const METRICS_MAX_FILES = 3;

export interface SizeEstimate {
  readonly chars: number;
  readonly estTokens: number;
}

/**
 * 한국어/CJK(~0.65 tok/char)와 ASCII(~0.27 tok/char) 혼합 비율을 반영한 보수적 토큰 추정기.
 * (본문을 저장하지 않고 실행 중 메모리에서 즉시 수치만 계산한다.)
 */
export function estimateMixedTokens(text: string | undefined): SizeEstimate {
  if (!text || text.length === 0) return { chars: 0, estTokens: 0 };
  let nonAscii = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) nonAscii += 1;
  }
  const ascii = text.length - nonAscii;
  const estTokens = Math.ceil(ascii * 0.27 + nonAscii * 0.65);
  return { chars: text.length, estTokens };
}

export interface AutoLoadedMemorySummary {
  readonly filesScanned: ReadonlyArray<{
    readonly relPath: string;
    readonly chars: number;
    readonly estTokens: number;
  }>;
  readonly totalChars: number;
  readonly totalEstTokens: number;
  readonly importDepthReached: number;
}

const AT_IMPORT_PATTERN = /(?:^|\s)@([A-Za-z0-9_./\\-]+\.md)\b/gu;

/**
 * Claude Code가 세션 시작 시 자동으로 읽는 메모리 파일들과 `@import` 대상의 크기만 재귀 집계한다.
 * 본문은 절대 반환하지 않는다.
 */
export function measureClaudeAutoLoadedMemory(
  cwd: string | undefined,
  options?: { readonly homeDir?: string; readonly maxDepth?: number },
): AutoLoadedMemorySummary {
  const maxDepth = options?.maxDepth ?? 3;
  const homeDir = options?.homeDir ?? NodeOs.homedir();
  const visited = new Set<string>();
  const filesScanned: Array<{
    readonly relPath: string;
    readonly chars: number;
    readonly estTokens: number;
  }> = [];
  let maxDepthReached = 0;

  const scanFile = (absPath: string, displayLabel: string, depth: number) => {
    const resolved = NodePath.resolve(absPath);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (visited.has(key) || depth > maxDepth) return;
    if (!NodeFs.existsSync(resolved)) return;
    let stat: NodeFs.Stats;
    try {
      stat = NodeFs.statSync(resolved);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return;
    visited.add(key);
    if (depth > maxDepthReached) maxDepthReached = depth;

    let text: string;
    try {
      text = NodeFs.readFileSync(resolved, "utf8");
    } catch {
      return;
    }
    const est = estimateMixedTokens(text);
    filesScanned.push({ relPath: displayLabel, chars: est.chars, estTokens: est.estTokens });

    const dir = NodePath.dirname(resolved);
    for (const match of text.matchAll(AT_IMPORT_PATTERN)) {
      const target = match[1];
      if (!target) continue;
      const nextAbs = NodePath.resolve(dir, target);
      const nextLabel =
        cwd && nextAbs.toLowerCase().startsWith(NodePath.resolve(cwd).toLowerCase())
          ? NodePath.relative(cwd, nextAbs).replaceAll("\\", "/")
          : `@import:${NodePath.basename(nextAbs)}`;
      scanFile(nextAbs, nextLabel, depth + 1);
    }
  };

  if (homeDir) {
    scanFile(NodePath.join(homeDir, ".claude", "CLAUDE.md"), "~/.claude/CLAUDE.md", 0);
  }
  if (cwd) {
    scanFile(NodePath.join(cwd, "CLAUDE.md"), "CLAUDE.md", 0);
    scanFile(NodePath.join(cwd, "CLAUDE.local.md"), "CLAUDE.local.md", 0);
    scanFile(NodePath.join(cwd, ".claude", "CLAUDE.md"), ".claude/CLAUDE.md", 0);
  }

  let totalChars = 0;
  let totalEstTokens = 0;
  for (const f of filesScanned) {
    totalChars += f.chars;
    totalEstTokens += f.estTokens;
  }
  return { filesScanned, totalChars, totalEstTokens, importDepthReached: maxDepthReached };
}

function measureTaggedBlock(promptText: string, tagName: string): SizeEstimate {
  const openRe = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gu");
  let totalChars = 0;
  let totalEstTokens = 0;
  for (const match of promptText.matchAll(openRe)) {
    const est = estimateMixedTokens(match[0]);
    totalChars += est.chars;
    totalEstTokens += est.estTokens;
  }
  return { chars: totalChars, estTokens: totalEstTokens };
}

function measureWorkspaceContextHeaderBlock(promptText: string): SizeEstimate {
  const startIdx = promptText.indexOf("# 프로젝트 문맥\n");
  if (startIdx < 0) return { chars: 0, estTokens: 0 };
  const endMarker = "\n## 현재 사용자 작업\n";
  const endIdx = promptText.indexOf(endMarker, startIdx);
  if (endIdx < 0) return { chars: 0, estTokens: 0 };
  return estimateMixedTokens(promptText.slice(startIdx, endIdx + endMarker.length));
}

export interface ClaudeFirstPromptBreakdown {
  readonly ts: string;
  readonly event: "first_prompt_breakdown" | "session_init_meta";
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly isResume: boolean;
  readonly isExecution: boolean;
  readonly components: {
    readonly developerInstructionsBase: SizeEstimate;
    readonly conductorInstructions: SizeEstimate;
    readonly subordinateRoster: SizeEstimate;
    readonly projectAgentsMdInjected: SizeEstimate;
    readonly globalSystemInstructions: SizeEstimate;
    readonly systemAppendTotal: SizeEstimate;
    readonly claudeAutoLoadedMemory: AutoLoadedMemorySummary;
    readonly chatSkillsBlock: SizeEstimate;
    readonly workspacePromptBlock: SizeEstimate;
    readonly routingMocBlock: SizeEstimate;
    readonly workspaceMemoryBlock: SizeEstimate;
    readonly handoffBlock: SizeEstimate;
    readonly firstTurnPromptTotal: SizeEstimate;
  };
  readonly counts: {
    readonly pluginCount: number;
    readonly mcpServerCount: number;
    readonly mcpServerNames: ReadonlyArray<string>;
    readonly programmaticAgentCount: number;
  };
}

export interface ClaudeSessionInitMeta {
  readonly ts: string;
  readonly event: "session_init_meta";
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly isExecution: boolean;
  readonly toolsCount: number;
  readonly skillsCount: number;
  readonly slashCommandsCount: number;
  readonly agentsCount: number;
  readonly mcpServersCount: number;
  readonly mcpServerNames: ReadonlyArray<string>;
}

export function computeClaudeFirstPromptBreakdown(input: {
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string | undefined;
  readonly model: string;
  readonly isResume: boolean;
  readonly isExecution: boolean;
  readonly systemAppendFull: string;
  readonly projectAgentsMdInjected: string | undefined;
  readonly subordinateRoster: string | undefined;
  readonly globalSystemInstructions: string | undefined;
  readonly conductorEnabled: boolean;
  readonly firstTurnPromptText: string;
  readonly pluginCount: number;
  readonly mcpServerNames: ReadonlyArray<string>;
  readonly programmaticAgentCount: number;
}): ClaudeFirstPromptBreakdown {
  const sysTotal = estimateMixedTokens(input.systemAppendFull);
  const projEst = estimateMixedTokens(input.projectAgentsMdInjected);
  const subEst = estimateMixedTokens(input.subordinateRoster);
  const globEst = estimateMixedTokens(input.globalSystemInstructions);
  const condMatch = /## Conductor mode[\s\S]*?(?=\n\n(?:## |<)|$)/u.exec(input.systemAppendFull);
  const condEst =
    input.conductorEnabled && condMatch
      ? estimateMixedTokens(condMatch[0])
      : { chars: 0, estTokens: 0 };
  const baseChars = Math.max(
    0,
    sysTotal.chars - projEst.chars - subEst.chars - globEst.chars - condEst.chars,
  );
  const baseTokens = Math.max(
    0,
    sysTotal.estTokens -
      projEst.estTokens -
      subEst.estTokens -
      globEst.estTokens -
      condEst.estTokens,
  );

  const promptText = input.firstTurnPromptText;
  const chatSkillsBlock = measureTaggedBlock(promptText, "t3_skills");
  const workspacePromptBlock = measureWorkspaceContextHeaderBlock(promptText);
  const routingMocBlock = measureTaggedBlock(promptText, "t3_routing_moc");
  const mem1 = measureTaggedBlock(promptText, "t3_memory");
  const mem2 = measureTaggedBlock(promptText, "t3_user_directives");
  const workspaceMemoryBlock: SizeEstimate = {
    chars: mem1.chars + mem2.chars,
    estTokens: mem1.estTokens + mem2.estTokens,
  };
  const h1 = measureTaggedBlock(promptText, "t3_conversation_handoff");
  const h2 = measureTaggedBlock(promptText, "t3_adaptive_handoff");
  const h3 = measureTaggedBlock(promptText, "t3_precomputed_compaction");
  const handoffBlock: SizeEstimate = {
    chars: h1.chars + h2.chars + h3.chars,
    estTokens: h1.estTokens + h2.estTokens + h3.estTokens,
  };

  return {
    ts: new Date().toISOString(),
    event: "first_prompt_breakdown",
    threadId: input.threadId,
    sessionId: input.sessionId,
    cwd: input.cwd ?? "",
    model: input.model,
    isResume: input.isResume,
    isExecution: input.isExecution,
    components: {
      developerInstructionsBase: { chars: baseChars, estTokens: baseTokens },
      conductorInstructions: condEst,
      subordinateRoster: subEst,
      projectAgentsMdInjected: projEst,
      globalSystemInstructions: globEst,
      systemAppendTotal: sysTotal,
      claudeAutoLoadedMemory: measureClaudeAutoLoadedMemory(input.cwd),
      chatSkillsBlock,
      workspacePromptBlock,
      routingMocBlock,
      workspaceMemoryBlock,
      handoffBlock,
      firstTurnPromptTotal: estimateMixedTokens(promptText),
    },
    counts: {
      pluginCount: input.pluginCount,
      mcpServerCount: input.mcpServerNames.length,
      mcpServerNames: [...input.mcpServerNames],
      programmaticAgentCount: input.programmaticAgentCount,
    },
  };
}

export function flattenBreakdownToSpanAttributes(
  b: ClaudeFirstPromptBreakdown,
): Record<string, string | number | boolean> {
  return {
    "claude.prompt.thread_id": b.threadId,
    "claude.prompt.cwd": b.cwd,
    "claude.prompt.model": b.model,
    "claude.prompt.is_resume": b.isResume,
    "claude.prompt.is_execution": b.isExecution,
    "claude.prompt.dev_base_chars": b.components.developerInstructionsBase.chars,
    "claude.prompt.dev_base_tokens": b.components.developerInstructionsBase.estTokens,
    "claude.prompt.conductor_chars": b.components.conductorInstructions.chars,
    "claude.prompt.subordinate_chars": b.components.subordinateRoster.chars,
    "claude.prompt.agents_md_injected_chars": b.components.projectAgentsMdInjected.chars,
    "claude.prompt.agents_md_injected_tokens": b.components.projectAgentsMdInjected.estTokens,
    "claude.prompt.global_sys_chars": b.components.globalSystemInstructions.chars,
    "claude.prompt.global_sys_tokens": b.components.globalSystemInstructions.estTokens,
    "claude.prompt.system_append_chars": b.components.systemAppendTotal.chars,
    "claude.prompt.system_append_tokens": b.components.systemAppendTotal.estTokens,
    "claude.prompt.auto_memory_chars": b.components.claudeAutoLoadedMemory.totalChars,
    "claude.prompt.auto_memory_tokens": b.components.claudeAutoLoadedMemory.totalEstTokens,
    "claude.prompt.chat_skills_chars": b.components.chatSkillsBlock.chars,
    "claude.prompt.workspace_prompt_chars": b.components.workspacePromptBlock.chars,
    "claude.prompt.routing_moc_chars": b.components.routingMocBlock.chars,
    "claude.prompt.memory_block_chars": b.components.workspaceMemoryBlock.chars,
    "claude.prompt.handoff_chars": b.components.handoffBlock.chars,
    "claude.prompt.handoff_tokens": b.components.handoffBlock.estTokens,
    "claude.prompt.first_turn_chars": b.components.firstTurnPromptTotal.chars,
    "claude.prompt.first_turn_tokens": b.components.firstTurnPromptTotal.estTokens,
    "claude.prompt.plugin_count": b.counts.pluginCount,
    "claude.prompt.mcp_server_count": b.counts.mcpServerCount,
  };
}

const sinkCache = new Map<string, RotatingFileSink>();

export function writeClaudePromptMetricRecord(
  logsDir: string | undefined,
  record: ClaudeFirstPromptBreakdown | ClaudeSessionInitMeta,
): boolean {
  if (!logsDir) return false;
  try {
    const filePath = NodePath.join(logsDir, CLAUDE_PROMPT_METRICS_FILE);
    let sink = sinkCache.get(filePath);
    if (!sink) {
      sink = new RotatingFileSink({
        filePath,
        maxBytes: METRICS_MAX_BYTES,
        maxFiles: METRICS_MAX_FILES,
        throwOnError: false,
      });
      sinkCache.set(filePath, sink);
    }
    sink.write(`${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}
