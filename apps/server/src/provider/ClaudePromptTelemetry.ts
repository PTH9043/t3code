// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { RotatingFileSink } from "@t3tools/shared/logging";

/**
 * Wave 1-A1 + 2026-11-28 실측 보강: 새 Claude 세션 첫 프롬프트 구성 요소별 크기 ·
 * init 도구/스킬/플러그인/MCP 분류 · 첫 응답 실제 API usage 계측기 (본문 절대 미저장).
 *
 * 기록 이벤트:
 * 1. `first_prompt_breakdown`:
 *    - T3 개발자 지시 (base, conductor, subordinateRoster), projectAgentsMdInjected, globalSystemInstructions
 *    - Claude Code 자동 로드 메모리 (`~/.claude/CLAUDE.md`, `CLAUDE.md`, `CLAUDE.local.md`,
 *      `.claude/CLAUDE.md`, 프로젝트 루트 `AGENTS.md`, AutoMemory `MEMORY.md`, `rules/**\/*.md`, 재귀 `@import`)
 *    - 채팅 스킬, 워크스페이스 문맥/MOC/기억, 대화 이어받기 요약(handoff)
 * 2. `session_init_meta`:
 *    - 도구/스킬/슬래시명령/에이전트/플러그인/MCP 수 + 출처별 분포(`toolsBySource`, `skillsBySource`,
 *      `pluginNames`, `mcpServersByCategory`) + 세션 격리 옵션 상태(`sessionIsolation`)
 * 3. `first_turn_actual_usage`:
 *    - 첫 메인 API 응답의 원본 `usage`(`inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`,
 *      `totalContextTokens`)와 T3 계측 합계 대비 `unaccountedCliOverheadTokens`
 *
 * 주의: 프롬프트 원문이나 파일 본문은 절대 기록하지 않고 오직 글자 수·추정 토큰 수·개수·식별자만 남긴다.
 */

export const CLAUDE_PROMPT_METRICS_FILE = "claude-prompt-metrics.ndjson";
const METRICS_MAX_BYTES = 5 * 1024 * 1024;
const METRICS_MAX_FILES = 3;
const MAX_RULE_FILES_PER_DIR = 50;

export interface SizeEstimate {
  readonly chars: number;
  readonly estTokens: number;
}

function isHangulCode(code: number): boolean {
  return (
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3130 && code <= 0x318f)
  );
}

/**
 * Anthropic Claude BPE 토크나이저 실측 보정 추정기.
 *
 * 실측 기준 (`D:\__OIBOT` `AGENTS.md` 64,382자 제거 시 공유 캐시 실측 감소 81,777 -> 26,611 = 55,166 tok):
 * - ASCII: ~0.27 tok/char
 * - 한글(Hangul 음절·자모): ~2.00 tok/char (UTF-8 3바이트 기반 BPE 분할)
 * - 기타 비ASCII(CJK·기호 등): ~1.10 tok/char
 * (본문을 저장하지 않고 실행 중 메모리에서 즉시 수치만 계산한다.)
 */
export function estimateMixedTokens(text: string | undefined): SizeEstimate {
  if (!text || text.length === 0) return { chars: 0, estTokens: 0 };
  let hangul = 0;
  let otherNonAscii = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      if (isHangulCode(code)) hangul += 1;
      else otherNonAscii += 1;
    }
  }
  const ascii = text.length - hangul - otherNonAscii;
  const estTokens = Math.ceil(ascii * 0.27 + hangul * 2.0 + otherNonAscii * 1.1);
  return { chars: text.length, estTokens };
}

export function resolveClaudeConfigDir(
  env?: Readonly<Record<string, string | undefined>>,
  fallbackHomeDir?: string,
): string {
  const configured = env?.CLAUDE_CONFIG_DIR?.trim();
  if (configured && configured.length > 0) {
    return NodePath.resolve(configured);
  }
  const home = fallbackHomeDir ?? NodeOs.homedir();
  return NodePath.join(home, ".claude");
}

/**
 * Claude Code가 AutoMemory 디렉터리(`~/.claude/projects/<encoded>/memory/MEMORY.md`)를
 * 찾을 때 사용하는 경로 인코딩과 동일하게 영숫자 외 모든 문자를 `-`로 치환한다.
 */
export function encodeClaudeProjectDirName(cwd: string): string {
  return NodePath.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * 사용자 Claude 설정(`settings.json`, `settings.local.json`)에서 현재 활성화(`!== false`)된
 * `enabledPlugins` 키 목록을 읽기 전용으로 수집한다. 원본 파일은 절대 수정하지 않는다.
 */
export function readClaudeUserEnabledPluginIds(claudeConfigDir: string | undefined): string[] {
  if (!claudeConfigDir) return [];
  const merged = new Map<string, boolean>();
  for (const filename of ["settings.json", "settings.local.json"]) {
    const filePath = NodePath.join(claudeConfigDir, filename);
    if (!NodeFs.existsSync(filePath)) continue;
    try {
      const raw = NodeFs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as { readonly enabledPlugins?: unknown };
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !parsed.enabledPlugins ||
        typeof parsed.enabledPlugins !== "object" ||
        Array.isArray(parsed.enabledPlugins)
      ) {
        continue;
      }
      for (const [key, value] of Object.entries(parsed.enabledPlugins as Record<string, unknown>)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) continue;
        if (value === false) {
          merged.set(trimmedKey, false);
        } else if (value !== null && value !== undefined) {
          merged.set(trimmedKey, true);
        }
      }
    } catch {
      // Malformed or unreadable user settings should never block session startup.
    }
  }
  return Array.from(merged.entries())
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .toSorted();
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

function collectMarkdownFilesRecursive(dirPath: string, limit: number): string[] {
  if (!NodeFs.existsSync(dirPath)) return [];
  const results: string[] = [];
  const walk = (current: string) => {
    if (results.length >= limit) return;
    let entries: NodeFs.Dirent[];
    try {
      entries = NodeFs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit) return;
      const full = NodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(full);
      }
    }
  };
  walk(dirPath);
  return results;
}

/**
 * Claude Code가 세션 시작 시 자동으로 읽는 메모리 파일들(`CLAUDE.md`, `CLAUDE.local.md`,
 * `.claude/CLAUDE.md`, 프로젝트 루트 `AGENTS.md`, AutoMemory `MEMORY.md`, `rules/**\/*.md`)과
 * `@import` 대상의 크기만 재귀 집계한다. 본문은 절대 반환하지 않는다.
 */
export function measureClaudeAutoLoadedMemory(
  cwd: string | undefined,
  options?: {
    readonly homeDir?: string;
    readonly claudeConfigDir?: string;
    readonly maxDepth?: number;
  },
): AutoLoadedMemorySummary {
  const maxDepth = options?.maxDepth ?? 3;
  const configDir = options?.claudeConfigDir
    ? NodePath.resolve(options.claudeConfigDir)
    : options?.homeDir
      ? NodePath.join(options.homeDir, ".claude")
      : NodePath.join(NodeOs.homedir(), ".claude");
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

  if (configDir) {
    scanFile(NodePath.join(configDir, "CLAUDE.md"), "~/.claude/CLAUDE.md", 0);
    for (const ruleFile of collectMarkdownFilesRecursive(
      NodePath.join(configDir, "rules"),
      MAX_RULE_FILES_PER_DIR,
    )) {
      const rel = NodePath.relative(configDir, ruleFile).replaceAll("\\", "/");
      scanFile(ruleFile, `~/.claude/${rel}`, 0);
    }
  }
  if (cwd) {
    // CLAUDE.md family first so explicit `@AGENTS.md` imports still preserve import depth 1,
    // and then native project-root AGENTS.md (loaded by Claude Code 0.3.251+ even without CLAUDE.md).
    scanFile(NodePath.join(cwd, "CLAUDE.md"), "CLAUDE.md", 0);
    scanFile(NodePath.join(cwd, "CLAUDE.local.md"), "CLAUDE.local.md", 0);
    scanFile(NodePath.join(cwd, ".claude", "CLAUDE.md"), ".claude/CLAUDE.md", 0);
    scanFile(NodePath.join(cwd, "AGENTS.md"), "AGENTS.md", 0);
    for (const ruleFile of collectMarkdownFilesRecursive(
      NodePath.join(cwd, ".claude", "rules"),
      MAX_RULE_FILES_PER_DIR,
    )) {
      const rel = NodePath.relative(cwd, ruleFile).replaceAll("\\", "/");
      scanFile(ruleFile, rel, 0);
    }
    if (configDir) {
      const encodedProject = encodeClaudeProjectDirName(cwd);
      const autoMemFile = NodePath.join(
        configDir,
        "projects",
        encodedProject,
        "memory",
        "MEMORY.md",
      );
      scanFile(autoMemFile, "AutoMem:MEMORY.md", 0);
    }
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
  readonly event: "first_prompt_breakdown";
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

export interface ClaudeSessionIsolationMeta {
  readonly claudeAiConnectorsDisabled: boolean;
  readonly userPluginsDisabled: boolean;
  readonly disabledPluginIds: ReadonlyArray<string>;
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
  readonly toolsBySource: Readonly<Record<string, number>>;
  readonly skillsCount: number;
  readonly skillsBySource: Readonly<Record<string, number>>;
  readonly slashCommandsCount: number;
  readonly agentsCount: number;
  readonly pluginsCount: number;
  readonly pluginNames: ReadonlyArray<string>;
  readonly mcpServersCount: number;
  readonly mcpServerNames: ReadonlyArray<string>;
  readonly mcpServersByCategory: {
    readonly t3Managed: number;
    readonly claudeAiConnectors: number;
    readonly plugins: number;
    readonly other: number;
  };
  readonly sessionIsolation?: ClaudeSessionIsolationMeta | undefined;
}

export interface ClaudeFirstTurnActualUsage {
  readonly ts: string;
  readonly event: "first_turn_actual_usage";
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly isResume: boolean;
  readonly isExecution: boolean;
  readonly usage: {
    readonly inputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly cacheReadInputTokens: number;
    readonly outputTokens: number;
    readonly totalContextTokens: number;
    readonly cacheCreation1hTokens?: number | undefined;
    readonly cacheCreation5mTokens?: number | undefined;
  };
  readonly t3Estimated: {
    readonly systemAppendTokens: number;
    readonly autoLoadedMemoryTokens: number;
    readonly firstTurnPromptTokens: number;
    readonly accountedSumTokens: number;
    readonly unaccountedCliOverheadTokens: number;
  };
  readonly initCounts?:
    | {
        readonly toolsCount: number;
        readonly skillsCount: number;
        readonly slashCommandsCount: number;
        readonly agentsCount: number;
        readonly pluginsCount: number;
        readonly mcpServersCount: number;
      }
    | undefined;
}

export type ClaudePromptMetricRecord =
  | ClaudeFirstPromptBreakdown
  | ClaudeSessionInitMeta
  | ClaudeFirstTurnActualUsage;

function classifyToolSource(toolName: string): string {
  if (!toolName.startsWith("mcp__")) return "builtin";
  const parts = toolName.split("__");
  return parts.length > 1 && parts[1] ? `mcp__${parts[1]}` : "mcp__unknown";
}

function classifySkillSource(skillName: string): string {
  const colonIdx = skillName.indexOf(":");
  if (colonIdx <= 0) return "plain";
  return skillName.slice(0, colonIdx);
}

function extractNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      names.push(item.trim());
    } else if (
      item &&
      typeof item === "object" &&
      "name" in item &&
      typeof item.name === "string"
    ) {
      const trimmed = item.name.trim();
      if (trimmed.length > 0) names.push(trimmed);
    }
  }
  return names;
}

export function buildClaudeSessionInitMeta(input: {
  readonly ts: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly isExecution: boolean;
  readonly initMsg: Readonly<Record<string, unknown>>;
  readonly sessionIsolation?: ClaudeSessionIsolationMeta | undefined;
}): ClaudeSessionInitMeta {
  const toolNames = extractNameList(input.initMsg.tools);
  const skillNames = extractNameList(input.initMsg.skills);
  const slashCommands = Array.isArray(input.initMsg.slash_commands)
    ? input.initMsg.slash_commands
    : [];
  const agents = Array.isArray(input.initMsg.agents) ? input.initMsg.agents : [];
  const pluginNames = extractNameList(input.initMsg.plugins);
  const mcpNames = extractNameList(input.initMsg.mcp_servers);

  const toolsBySource: Record<string, number> = {};
  for (const name of toolNames) {
    const src = classifyToolSource(name);
    toolsBySource[src] = (toolsBySource[src] ?? 0) + 1;
  }

  const skillsBySource: Record<string, number> = {};
  for (const name of skillNames) {
    const src = classifySkillSource(name);
    skillsBySource[src] = (skillsBySource[src] ?? 0) + 1;
  }

  let t3Managed = 0;
  let claudeAiConnectors = 0;
  let plugins = 0;
  let other = 0;
  for (const name of mcpNames) {
    if (name.startsWith("t3-")) t3Managed += 1;
    else if (name.toLowerCase().startsWith("claude.ai")) claudeAiConnectors += 1;
    else if (name.startsWith("plugin:")) plugins += 1;
    else other += 1;
  }

  return {
    ts: input.ts,
    event: "session_init_meta",
    threadId: input.threadId,
    sessionId: input.sessionId,
    cwd: input.cwd,
    model: input.model,
    isExecution: input.isExecution,
    toolsCount: Array.isArray(input.initMsg.tools) ? input.initMsg.tools.length : toolNames.length,
    toolsBySource,
    skillsCount: Array.isArray(input.initMsg.skills)
      ? input.initMsg.skills.length
      : skillNames.length,
    skillsBySource,
    slashCommandsCount: slashCommands.length,
    agentsCount: agents.length,
    pluginsCount: Array.isArray(input.initMsg.plugins)
      ? input.initMsg.plugins.length
      : pluginNames.length,
    pluginNames,
    mcpServersCount: mcpNames.length,
    mcpServerNames: mcpNames,
    mcpServersByCategory: {
      t3Managed,
      claudeAiConnectors,
      plugins,
      other,
    },
    ...(input.sessionIsolation ? { sessionIsolation: input.sessionIsolation } : {}),
  };
}

function nonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

export function buildClaudeFirstTurnActualUsage(input: {
  readonly ts: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly isResume: boolean;
  readonly isExecution: boolean;
  readonly rawUsage: unknown;
  readonly systemAppendTokens: number;
  readonly autoLoadedMemoryTokens: number;
  readonly firstTurnPromptTokens: number;
  readonly initCounts?: ClaudeFirstTurnActualUsage["initCounts"] | undefined;
}): ClaudeFirstTurnActualUsage | undefined {
  if (!input.rawUsage || typeof input.rawUsage !== "object" || Array.isArray(input.rawUsage)) {
    return undefined;
  }
  const usage = input.rawUsage as Record<string, unknown>;
  const inputTokens = nonNegInt(usage.input_tokens);
  const cacheCreationInputTokens = nonNegInt(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = nonNegInt(usage.cache_read_input_tokens);
  const outputTokens = nonNegInt(usage.output_tokens);
  const totalContextTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  if (totalContextTokens <= 0) return undefined;

  const cacheCreation =
    usage.cache_creation &&
    typeof usage.cache_creation === "object" &&
    !Array.isArray(usage.cache_creation)
      ? (usage.cache_creation as Record<string, unknown>)
      : undefined;
  const cacheCreation1hTokens =
    cacheCreation && typeof cacheCreation.ephemeral_1h_input_tokens === "number"
      ? nonNegInt(cacheCreation.ephemeral_1h_input_tokens)
      : undefined;
  const cacheCreation5mTokens =
    cacheCreation && typeof cacheCreation.ephemeral_5m_input_tokens === "number"
      ? nonNegInt(cacheCreation.ephemeral_5m_input_tokens)
      : undefined;

  const accountedSumTokens =
    input.systemAppendTokens + input.autoLoadedMemoryTokens + input.firstTurnPromptTokens;
  const unaccountedCliOverheadTokens = Math.max(0, totalContextTokens - accountedSumTokens);

  return {
    ts: input.ts,
    event: "first_turn_actual_usage",
    threadId: input.threadId,
    sessionId: input.sessionId,
    cwd: input.cwd,
    model: input.model,
    isResume: input.isResume,
    isExecution: input.isExecution,
    usage: {
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      outputTokens,
      totalContextTokens,
      ...(cacheCreation1hTokens !== undefined ? { cacheCreation1hTokens } : {}),
      ...(cacheCreation5mTokens !== undefined ? { cacheCreation5mTokens } : {}),
    },
    t3Estimated: {
      systemAppendTokens: input.systemAppendTokens,
      autoLoadedMemoryTokens: input.autoLoadedMemoryTokens,
      firstTurnPromptTokens: input.firstTurnPromptTokens,
      accountedSumTokens,
      unaccountedCliOverheadTokens,
    },
    ...(input.initCounts ? { initCounts: input.initCounts } : {}),
  };
}

export function computeClaudeFirstPromptBreakdown(input: {
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string | undefined;
  readonly claudeConfigDir?: string | undefined;
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
      claudeAutoLoadedMemory: measureClaudeAutoLoadedMemory(
        input.cwd,
        input.claudeConfigDir ? { claudeConfigDir: input.claudeConfigDir } : undefined,
      ),
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
  record: ClaudePromptMetricRecord,
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
