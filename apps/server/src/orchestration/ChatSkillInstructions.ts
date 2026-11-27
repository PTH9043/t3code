import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * The skills a `$name` mention may refer to, whichever AI the conversation
 * uses. A skill installed for one AI is usable with every other: the other
 * AIs' personal skills come first, then the active AI's own, then the
 * project's, each later group winning on a name clash.
 */
export function mergeSharedChatSkills(input: {
  readonly providers: ReadonlyArray<{
    readonly instanceId: unknown;
    readonly skills: ReadonlyArray<ServerProviderSkill>;
  }>;
  readonly activeInstanceId: unknown;
  readonly projectSkills: ReadonlyArray<ServerProviderSkill>;
}): ReadonlyArray<ServerProviderSkill> {
  const scopeOf = (skill: ServerProviderSkill) => skill.scope?.trim().toLowerCase() ?? "";
  const byName = new Map<string, ServerProviderSkill>();
  for (const provider of input.providers) {
    if (provider.instanceId === input.activeInstanceId) continue;
    for (const skill of provider.skills) {
      if (scopeOf(skill) === "user" && !byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  const active = input.providers.find((provider) => provider.instanceId === input.activeInstanceId);
  for (const skill of active?.skills ?? []) {
    if (["user", "system", "admin"].includes(scopeOf(skill))) byName.set(skill.name, skill);
  }
  for (const skill of input.projectSkills) byName.set(skill.name, skill);
  return [...byName.values()];
}

/** One skill's instructions beyond this are cut; the rest stays readable in its SKILL.md. */
const MAX_SKILL_INSTRUCTION_CHARS = 60_000;

/**
 * Turns `$skill` mentions into text for providers that have no skill runtime
 * of their own. Codex and Claude load a mentioned skill natively; every other
 * provider receives the skill's SKILL.md body inside the turn input, so the
 * same project skills work whichever AI the conversation uses.
 *
 * Returns nothing when no mentioned skill has readable instructions.
 */
export const readChatSkillInstructions = Effect.fn("readChatSkillInstructions")(function* (
  skills: ReadonlyArray<{ readonly name: string; readonly path: string }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const blocks: string[] = [];
  for (const skill of skills) {
    const text = yield* fs.readFileString(skill.path).pipe(Effect.orElseSucceed(() => ""));
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
    if (!body) continue;
    const instructions =
      body.length > MAX_SKILL_INSTRUCTION_CHARS
        ? `${body.slice(0, MAX_SKILL_INSTRUCTION_CHARS)}\n(이하 생략. 전체 내용은 SKILL.md에 있습니다.)`
        : body;
    blocks.push(
      `<t3_skill name="${skill.name}" directory="${path.dirname(skill.path)}">\n${instructions}\n</t3_skill>`,
    );
  }
  if (blocks.length === 0) return undefined;
  return [
    "<t3_skills>",
    "사용자가 $이름으로 아래 스킬을 지정했습니다. 이번 요청에 각 스킬의 지침을 적용하세요. 지침이 가리키는 상대 경로의 파일은 해당 스킬의 directory 아래에 있습니다.",
    "",
    blocks.join("\n\n"),
    "</t3_skills>",
  ].join("\n");
});
