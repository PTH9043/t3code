// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { readAgentsMdForClaude } from "./projectAgentInstructions.ts";

const created: Array<string> = [];
const project = (files: Record<string, string>): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agents-md-"));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, name), content);
  }
  return dir;
};

afterEach(() => {
  for (const dir of created.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("readAgentsMdForClaude", () => {
  it("returns nothing without a working directory or an AGENTS.md", () => {
    expect(readAgentsMdForClaude(undefined)).toBeUndefined();
    expect(readAgentsMdForClaude(project({ "CLAUDE.md": "notes" }))).toBeUndefined();
    expect(readAgentsMdForClaude(project({ "AGENTS.md": "  \n" }))).toBeUndefined();
  });

  it("supplies AGENTS.md when Claude Code would not load it", () => {
    // A Windows checkout turns the CLAUDE.md -> AGENTS.md symlink into a
    // one-line file naming its target, which Claude Code reads as plain text.
    const block = readAgentsMdForClaude(
      project({ "AGENTS.md": "Never run PowerShell.\n", "CLAUDE.md": "AGENTS.md" }),
    );
    expect(block).toContain("<project_agents_md>\nNever run PowerShell.\n</project_agents_md>");
  });

  it("does not repeat instructions Claude Code already loads", () => {
    const rules = "Never run PowerShell.\n";
    expect(
      readAgentsMdForClaude(project({ "AGENTS.md": rules, "CLAUDE.md": rules })),
    ).toBeUndefined();
    expect(
      readAgentsMdForClaude(project({ "AGENTS.md": rules, "CLAUDE.local.md": "@AGENTS.md\n" })),
    ).toBeUndefined();
    expect(
      readAgentsMdForClaude(
        project({ "AGENTS.md": rules, ".claude/CLAUDE.md": "See @./AGENTS.md first." }),
      ),
    ).toBeUndefined();
  });

  it("caps an oversized AGENTS.md and says so", () => {
    const block = readAgentsMdForClaude(project({ "AGENTS.md": "x".repeat(70_000) }));
    expect(block).toContain("AGENTS.md is longer than shown here");
    expect(block?.length).toBeLessThan(65_000);
  });
});
