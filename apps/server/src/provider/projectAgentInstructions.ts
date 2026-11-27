/**
 * AGENTS.md for providers that do not load it themselves.
 *
 * Codex, OpenCode and Cursor read a project's AGENTS.md natively. Claude Code
 * only reads CLAUDE.md, and on Windows the usual `CLAUDE.md -> AGENTS.md`
 * symlink checks out as a one-line text file naming its target, so Claude
 * sessions silently ran without the project's standing instructions.
 *
 * @module projectAgentInstructions
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";

const AGENTS_FILE = "AGENTS.md";
/** Files Claude Code loads as project memory from the session's working directory. */
const CLAUDE_MEMORY_FILES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  NodePath.join(".claude", "CLAUDE.md"),
] as const;
const AGENTS_IMPORT = /(^|\s)@(\.\/)?AGENTS\.md\b/;
const MAX_INSTRUCTION_CHARS = 64_000;

function readText(path: string): string | undefined {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    // Missing or unreadable files simply contribute nothing.
    return undefined;
  }
}

/**
 * The project's AGENTS.md as a system-prompt block for a Claude session, or
 * undefined when there is none or Claude Code already loads it: through a
 * working symlink (CLAUDE.md has the same content) or an `@AGENTS.md` import
 * in any of its memory files.
 */
export function readAgentsMdForClaude(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const agents = readText(NodePath.join(cwd, AGENTS_FILE))?.trim();
  if (!agents) return undefined;
  for (const file of CLAUDE_MEMORY_FILES) {
    const memory = readText(NodePath.join(cwd, file));
    if (memory !== undefined && (memory.trim() === agents || AGENTS_IMPORT.test(memory))) {
      return undefined;
    }
  }
  const body =
    agents.length > MAX_INSTRUCTION_CHARS
      ? `${agents.slice(0, MAX_INSTRUCTION_CHARS)}\n\n[AGENTS.md is longer than shown here. Read the rest of the file before relying on it.]`
      : agents;
  return `## Project instructions (AGENTS.md)

This project keeps its standing instructions in AGENTS.md at the project root.
They apply to this session exactly as CLAUDE.md project memory would, and the
person's latest message still takes precedence over them.

<project_agents_md>
${body}
</project_agents_md>`;
}
