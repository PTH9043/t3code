import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parseWorkflowSkill } from "./WorkflowSkills.ts";

/** Reads skill metadata from this conversation's working directory and project root. */
export const discoverChatProjectSkills = Effect.fn("discoverChatProjectSkills")(function* (
  cwd: string,
  projectRoot?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let truncated = false;
  const readRoot = Effect.fn("discoverChatProjectSkills.readRoot")(function* (
    workingDirectory: string,
    relativeRoot: string,
  ) {
    const root = path.join(workingDirectory, relativeRoot, "skills");
    const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as string[]));
    if (entries.length > 256) truncated = true;
    const found: ServerProviderSkill[] = [];
    for (const entry of entries.toSorted().slice(0, 256)) {
      if (entry.startsWith(".")) continue;
      const skillPath = path.join(root, entry, "SKILL.md");
      const skill = yield* Effect.gen(function* () {
        const info = yield* fs.stat(skillPath);
        if (info.type !== "File" || Number(info.size) > 512 * 1024) return null;
        const [realRoot, realSkill] = yield* Effect.all([
          fs.realPath(root),
          fs.realPath(skillPath),
        ]);
        const relative = path.relative(realRoot, realSkill);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          return null;
        const text = yield* fs.readFileString(skillPath);
        const metadata = yield* Effect.try(() => parseWorkflowSkill(text, entry));
        if (!metadata.name || !["both", "manual"].includes(metadata.invocation)) return null;
        return {
          name: metadata.name,
          path: skillPath,
          scope: "project",
          enabled: true,
          ...(metadata.description.trim() ? { description: metadata.description.trim() } : {}),
        } satisfies ServerProviderSkill;
      }).pipe(Effect.orElseSucceed(() => null));
      if (skill) found.push(skill);
    }
    return found;
  });
  const localCodex = yield* readRoot(cwd, ".agents");
  const localClaude = yield* readRoot(cwd, ".claude");
  const localGemini = yield* readRoot(cwd, ".gemini");
  const projectCodex =
    projectRoot && path.resolve(projectRoot) !== path.resolve(cwd)
      ? yield* readRoot(projectRoot, ".agents")
      : [];
  const codexByName = new Map(projectCodex.map((skill) => [skill.name, skill]));
  for (const skill of localCodex) codexByName.set(skill.name, skill);
  const projectClaude =
    projectRoot && path.resolve(projectRoot) !== path.resolve(cwd)
      ? yield* readRoot(projectRoot, ".claude")
      : [];
  const claudeByName = new Map(projectClaude.map((skill) => [skill.name, skill]));
  for (const skill of localClaude) claudeByName.set(skill.name, skill);
  const projectGemini =
    projectRoot && path.resolve(projectRoot) !== path.resolve(cwd)
      ? yield* readRoot(projectRoot, ".gemini")
      : [];
  const geminiByName = new Map<string, ServerProviderSkill>();
  for (const skill of [
    ...claudeByName.values(),
    ...codexByName.values(),
    ...projectGemini,
    ...localGemini,
  ]) {
    geminiByName.set(skill.name, skill);
  }
  const grokByName = new Map<string, ServerProviderSkill>();
  for (const skill of [
    ...codexByName.values(),
    ...claudeByName.values(),
    ...geminiByName.values(),
  ]) {
    grokByName.set(skill.name, skill);
  }
  return {
    codex: [...codexByName.values()],
    claudeAgent: [...claudeByName.values()],
    gemini: [...geminiByName.values()],
    grok: [...grokByName.values()],
    truncated,
  };
});

/** Select explicitly mentioned skills, excluding examples inside Markdown code. */
export function selectMentionedChatSkills(
  input: string,
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<{ name: string; path: string }> {
  const prose = input
    .replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)|`[^`\r\n]*`/g, " ")
    .replace(/^(?: {4}|\t).*$/gm, " ");
  const mentions = new Set<string>();
  const pattern = /(?:^|[\s([{])\$([A-Za-z0-9][A-Za-z0-9:_-]*)(?![A-Za-z0-9:_-])/g;
  for (const match of prose.matchAll(pattern)) if (match[1]) mentions.add(match[1]);
  const byName = new Map(
    skills.filter((skill) => skill.enabled).map((skill) => [skill.name, skill]),
  );
  return [...mentions].flatMap((name) => {
    const skill = byName.get(name);
    return skill ? [{ name: skill.name, path: skill.path }] : [];
  });
}
