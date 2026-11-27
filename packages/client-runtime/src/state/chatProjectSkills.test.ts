import { describe, expect, it } from "@effect/vitest";
import { mergeChatProjectSkills } from "./chatProjectSkills.ts";

const skill = (name: string, path: string, scope: string) => ({ name, path, scope, enabled: true });

describe("chat project skills", () => {
  it("removes another project's cached skills and prefers the current project by name", () => {
    const global = skill("shared", "C:\\Users\\me\\.codex\\skills\\shared\\SKILL.md", "user");
    const other = skill("other", "C:\\work\\other\\.agents\\skills\\other\\SKILL.md", "project");
    const override = skill(
      "shared",
      "c:\\work\\current\\.agents\\skills\\shared\\SKILL.md",
      "project",
    );
    expect(mergeChatProjectSkills([global, other], [override], "C:\\Work\\Current")).toEqual([
      override,
    ]);
    expect(mergeChatProjectSkills([global, other], [], null)).toEqual([global]);
  });

  it("offers another AI's personal skills below the selected AI's and the project's", () => {
    const own = skill("shared", "C:\\Users\\me\\.codex\\skills\\shared\\SKILL.md", "user");
    const theirs = skill("shared", "C:\\Users\\me\\.claude\\skills\\shared\\SKILL.md", "user");
    const resume = skill("resume", "C:\\Users\\me\\.claude\\skills\\resume\\SKILL.md", "user");
    const system = skill("builtin", "C:\\Users\\me\\.claude\\skills\\builtin\\SKILL.md", "system");
    const foreign = skill(
      "foreign",
      "C:\\work\\other\\.claude\\skills\\foreign\\SKILL.md",
      "project",
    );
    // Only personal skills cross over: another AI's built-in or project-cached
    // skills stay with that AI.
    expect(mergeChatProjectSkills([own], [], null, [theirs, resume, system, foreign])).toEqual([
      own,
      resume,
    ]);
  });

  it("does not treat sibling prefixes or traversal as the current workspace", () => {
    const sibling = skill("sibling", "/work/app-other/skills/a/SKILL.md", "workspace");
    const traversal = skill("traversal", "/work/app/../other/SKILL.md", "project");
    const local = skill("local", "/work/app/.claude/skills/a/SKILL.md", "project");
    expect(mergeChatProjectSkills([sibling, traversal, local], [], "/work/app")).toEqual([local]);
  });

  it("matches Windows network paths without case-sensitive false negatives", () => {
    const local = skill(
      "local",
      "\\\\SERVER\\Share\\Project\\.agents\\skills\\x\\SKILL.md",
      "project",
    );
    expect(mergeChatProjectSkills([local], [], "\\\\server\\share\\project")).toEqual([local]);
  });
});
