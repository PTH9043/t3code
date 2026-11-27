import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CouncilRoleArchetype, SubordinateCapabilityTag } from "./council.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ThreadTeamRole = Schema.Literals([
  "worker",
  "advisor",
  "scout",
  "planner",
  "tester",
  "writer",
  "diagnostician",
  "analyst",
  "translator",
]);
export type ThreadTeamRole = typeof ThreadTeamRole.Type;

export const threadTeamRoleLabels: Record<ThreadTeamRole, string> = {
  worker: "작업",
  advisor: "검토",
  scout: "조사",
  planner: "설계",
  tester: "검증",
  writer: "문서화",
  diagnostician: "오류 진단",
  analyst: "데이터 분석",
  translator: "번역·현지화",
};

export const threadTeamRoleMayWrite = (role: ThreadTeamRole): boolean =>
  role === "worker" || role === "writer";

export const ThreadTeamMember = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  role: ThreadTeamRole,
  instructions: Schema.optionalKey(TrimmedNonEmptyString),
  /** Optional active toggle for dynamic council auto-seating (defaults to true when omitted). */
  enabled: Schema.optionalKey(Schema.Boolean),
  /** Optional explicit capability tags overriding automatic role/metadata inference. */
  capabilities: Schema.optionalKey(Schema.Array(SubordinateCapabilityTag)),
  /** Optional explicit council role archetype pin for this subordinate slot. */
  councilRoleOverride: Schema.optionalKey(CouncilRoleArchetype),
});
export type ThreadTeamMember = typeof ThreadTeamMember.Type;

const scopeFields = {
  threadId: ThreadId,
  answeringInstanceId: ProviderInstanceId,
  forModel: TrimmedNonEmptyString,
};

export const ThreadModelTeamScope = Schema.Struct(scopeFields);
export type ThreadModelTeamScope = typeof ThreadModelTeamScope.Type;

export const ThreadModelTeam = Schema.Struct({
  ...scopeFields,
  members: Schema.Array(ThreadTeamMember),
});
export type ThreadModelTeam = typeof ThreadModelTeam.Type;

/** An empty list explicitly disables the room's delegated team. Null restores account assignments. */
export const ThreadModelTeamUpdate = Schema.Struct({
  ...scopeFields,
  members: Schema.NullOr(Schema.Array(ThreadTeamMember)),
});
export type ThreadModelTeamUpdate = typeof ThreadModelTeamUpdate.Type;

export const ThreadSubordinateTeamUpdate = Schema.Struct({
  threadId: ThreadId,
  members: Schema.NullOr(Schema.Array(ThreadTeamMember)),
});
export type ThreadSubordinateTeamUpdate = typeof ThreadSubordinateTeamUpdate.Type;

/** The team of models every conversation delegates to; edited in the global model settings. */
export interface SubordinateTeamSettings {
  readonly globalSubordinateTeam?: readonly ThreadTeamMember[];
  readonly threadSubordinateTeams?: Readonly<Record<string, readonly ThreadTeamMember[] | null>>;
}

export function resolveSubordinateTeam(
  settings: SubordinateTeamSettings,
  _threadId?: string | null,
): { readonly source: "room" | "global"; readonly members: readonly ThreadTeamMember[] } {
  // Unified global-only subordinate team: per-thread overrides are retired.
  return { source: "global" as const, members: settings.globalSubordinateTeam ?? [] };
}

export function findThreadModelTeam<T extends ThreadModelTeamScope>(
  teams: readonly T[] | undefined,
  scope: ThreadModelTeamScope,
): T | undefined {
  const model = scope.forModel.trim().toLowerCase();
  return teams?.find(
    (team) =>
      team.threadId === scope.threadId &&
      team.answeringInstanceId === scope.answeringInstanceId &&
      team.forModel.toLowerCase() === model,
  );
}
