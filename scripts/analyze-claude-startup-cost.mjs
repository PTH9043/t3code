#!/usr/bin/env node
/**
 * Read-only offline analyzer for Wave 1-A1:
 * Compares Claude Code first-turn startup context across project directories
 * (e.g., D:\__OIBOT vs D:\___AIModel\personal-rl-agent) from ~/.claude/projects JSONL files
 * and reports user-owned candidate files/skills/MCPs with estimated token savings (NEVER modifies any file).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function estMixedTokens(text) {
  if (!text) return 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) nonAscii += 1;
  }
  const ascii = text.length - nonAscii;
  return Math.ceil(ascii * 0.27 + nonAscii * 0.65);
}

function inspectSessionJsonl(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  const result = {
    file: path.basename(filePath),
    model: null,
    usage: null,
    firstUserChars: 0,
    instructionFiles: [],
    skillCount: 0,
    skillChars: 0,
    deferredToolsCount: 0,
    deferredToolsChars: 0,
    mcpInstructionsChars: 0,
    t3SystemAppendChars: 0,
    t3AgentsMdInjected: false,
  };

  for (let i = 0; i < Math.min(lines.length, 40); i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "user" && result.firstUserChars === 0) {
      const c = obj.message?.content;
      if (typeof c === "string") result.firstUserChars = c.length;
      else if (Array.isArray(c)) {
        result.firstUserChars = c.reduce(
          (acc, b) => acc + (typeof b?.text === "string" ? b.text.length : 0),
          0,
        );
      }
    } else if (obj.type === "assistant" && !result.usage && obj.message?.usage) {
      result.model = obj.message.model ?? null;
      const u = obj.message.usage;
      result.usage = {
        input: u.input_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        total:
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0),
      };
    } else if (obj.type === "attachment" && obj.attachment) {
      const att = obj.attachment;
      if (att.type === "instructions" && Array.isArray(att.files)) {
        result.instructionFiles = att.files.map((f) => ({
          path: f.path ?? f.filePath ?? "unknown",
          type: f.type ?? "unknown",
          chars: typeof f.content === "string" ? f.content.length : 0,
          estTokens: estMixedTokens(typeof f.content === "string" ? f.content : ""),
        }));
      } else if (att.type === "skill_listing") {
        result.skillCount = att.skillCount ?? (Array.isArray(att.names) ? att.names.length : 0);
        result.skillChars = typeof att.content === "string" ? att.content.length : 0;
      } else if (att.type === "deferred_tools_delta") {
        result.deferredToolsCount = Array.isArray(att.addedNames) ? att.addedNames.length : 0;
        result.deferredToolsChars = JSON.stringify(att.addedLines ?? []).length;
      } else if (att.type === "mcp_instructions_delta") {
        result.mcpInstructionsChars =
          typeof att.addedServerInstructions === "string" ? att.addedServerInstructions.length : 0;
      } else if (att.type === "prompt_snapshot" && Array.isArray(att.systemPrompt)) {
        for (const blk of att.systemPrompt) {
          const text =
            typeof blk === "string" ? blk : typeof blk?.text === "string" ? blk.text : "";
          if (text.includes("You are running inside T3 Code")) {
            result.t3SystemAppendChars = text.length;
            result.t3AgentsMdInjected = text.includes("<project_agents_md>");
          }
        }
      }
    }
  }
  return result.usage ? result : null;
}

function summarizeProjectDir(projectsRoot, dirName, maxSessions = 5) {
  const dirPath = path.join(projectsRoot, dirName);
  if (!fs.existsSync(dirPath)) return null;
  const files = fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(dirPath, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, maxSessions);

  const sessions = [];
  for (const f of files) {
    const parsed = inspectSessionJsonl(path.join(dirPath, f.name));
    if (parsed) sessions.push(parsed);
  }
  return { dirName, sessions };
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const projectsRoot = path.join(os.homedir(), ".claude", "projects");

if (!fs.existsSync(projectsRoot)) {
  console.error(`Projects dir not found: ${projectsRoot}`);
  process.exit(1);
}

const targetDirs = fs
  .readdirSync(projectsRoot)
  .filter((d) => /oibot|personal-rl|NewAutoUsage/i.test(d));

const report = targetDirs
  .map((d) => summarizeProjectDir(projectsRoot, d, 5))
  .filter((r) => r && r.sessions.length > 0);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log("=== Claude 새 세션 첫 호출 고정 비용 분해 (읽기 전용 실측) ===");
for (const proj of report) {
  console.log(`\n[프로젝트] ${proj.dirName} (최근 ${proj.sessions.length}세션)`);
  for (const s of proj.sessions) {
    const instTotalChars = s.instructionFiles.reduce((a, f) => a + f.chars, 0);
    const instTotalTok = s.instructionFiles.reduce((a, f) => a + f.estTokens, 0);
    const duplicateAgents =
      s.t3AgentsMdInjected && s.instructionFiles.some((f) => /AGENTS\.md$/i.test(f.path));
    console.log(
      `  - ${s.file.slice(0, 8)} | ${s.model} | 총 ${s.usage.total.toLocaleString()} tok (read=${s.usage.cacheRead.toLocaleString()}, create=${s.usage.cacheCreate.toLocaleString()})`,
    );
    console.log(
      `    instructions=${instTotalChars.toLocaleString()}자(~${instTotalTok.toLocaleString()} tok) | T3 systemAppend=${s.t3SystemAppendChars.toLocaleString()}자(AGENTS이중=${duplicateAgents}) | skills=${s.skillCount}개(${s.skillChars.toLocaleString()}자) | deferredTools=${s.deferredToolsCount}개 | user=${s.firstUserChars.toLocaleString()}자`,
    );
    for (const f of s.instructionFiles) {
      if (f.chars >= 2000) {
        console.log(
          `      * [${f.type}] ${f.path}: ${f.chars.toLocaleString()}자 (~${f.estTokens.toLocaleString()} tok)`,
        );
      }
    }
  }
}
