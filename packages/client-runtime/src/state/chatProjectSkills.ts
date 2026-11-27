import type { ServerProviderSkill } from "@t3tools/contracts";

function belongsToWorkingDirectory(skillPath: string, cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const clean = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const root = clean(cwd);
  const file = clean(skillPath);
  const insensitive = /^[a-z]:\//iu.test(root) || root.startsWith("//");
  const parent = insensitive ? root.toLowerCase() : root;
  const candidate = insensitive ? file.toLowerCase() : file;
  return candidate.startsWith(`${parent}/`) && !candidate.split("/").includes("..");
}

/**
 * Project-scoped provider snapshots describe the server cwd, not every chat.
 *
 * `otherProviderSkills` are the skills of the AIs this conversation is not
 * using. Their personal ("user") skills are offered here too, so a skill
 * installed for one AI can be picked with any of them; the selected AI's own
 * skills and the project's win on a name clash.
 */
export function mergeChatProjectSkills(
  providerSkills: ReadonlyArray<ServerProviderSkill>,
  projectSkills: ReadonlyArray<ServerProviderSkill>,
  cwd: string | null | undefined,
  otherProviderSkills: ReadonlyArray<ServerProviderSkill> = [],
): ReadonlyArray<ServerProviderSkill> {
  const merged = new Map<string, ServerProviderSkill>();
  for (const skill of otherProviderSkills) {
    if (skill.scope?.trim().toLowerCase() === "user" && !merged.has(skill.name))
      merged.set(skill.name, skill);
  }
  for (const skill of providerSkills) {
    const scope = skill.scope?.trim().toLowerCase();
    if (
      scope &&
      ["project", "workspace", "local", "repo"].includes(scope) &&
      !belongsToWorkingDirectory(skill.path, cwd)
    )
      continue;
    merged.set(skill.name, skill);
  }
  for (const skill of projectSkills) merged.set(skill.name, skill);
  return [...merged.values()];
}
