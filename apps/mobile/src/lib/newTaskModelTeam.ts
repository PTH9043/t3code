import { ThreadModelTeam, type ModelSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// A project draft has no room yet. The first-send builder binds every row to
// the same thread ID as the command, including during offline replay.
export const NewTaskModelTeam = Schema.Struct({
  answeringInstanceId: ThreadModelTeam.fields.answeringInstanceId,
  forModel: ThreadModelTeam.fields.forModel,
  members: ThreadModelTeam.fields.members,
});
export type NewTaskModelTeam = typeof NewTaskModelTeam.Type;

export function findNewTaskModelTeam(
  teams: readonly NewTaskModelTeam[] | undefined,
  selection: ModelSelection,
) {
  return teams?.find(
    (row) =>
      row.answeringInstanceId === selection.instanceId &&
      row.forModel.trim().toLowerCase() === selection.model.trim().toLowerCase(),
  );
}

export function withNewTaskModelTeam(
  teams: readonly NewTaskModelTeam[] | undefined,
  selection: ModelSelection,
  members: NewTaskModelTeam["members"] | null,
): readonly NewTaskModelTeam[] {
  const previous = findNewTaskModelTeam(teams, selection);
  const others = (teams ?? []).filter((row) => row !== previous);
  return members === null
    ? others
    : [
        ...others,
        { answeringInstanceId: selection.instanceId, forModel: selection.model, members },
      ];
}
