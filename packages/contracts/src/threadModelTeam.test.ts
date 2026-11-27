import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";
import { ThreadTeamRole, threadTeamRoleLabels, threadTeamRoleMayWrite } from "./threadModelTeam.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const member = (role: string) => ({ instanceId: "codex", model: "gpt-" + role, role });

describe("sub-model team roles", () => {
  it("decodes teams stored with the original roles and settings stored before global styles existed", () => {
    const stored = decodeSettings({
      globalSubordinateTeam: [
        member("worker"),
        { ...member("advisor"), instructions: "수치 확인" },
        member("scout"),
      ],
      threadSubordinateTeams: { room: [member("advisor")], other: null },
      subordinateModels: [{ answeringInstanceId: "claudeAgent", ...member("scout") }],
    });
    expect(stored.globalSubordinateTeam.map((row) => row.role)).toEqual([
      "worker",
      "advisor",
      "scout",
    ]);
    expect(stored.globalSubordinateTeam[1]?.instructions).toBe("수치 확인");
    expect(stored.threadSubordinateTeams).toEqual({ room: [member("advisor")], other: null });
    expect(stored.subordinateModels[0]?.role).toBe("scout");
    expect(decodeSettings({})).toMatchObject({
      globalResponseStyle: null,
      globalSubordinateTeam: [],
      threadSubordinateTeams: {},
      threadResponseStyles: {},
    });
  });

  it("accepts the design, verification and documentation roles and rejects unknown ones", () => {
    const added = ["planner", "tester", "writer"];
    expect(
      decodePatch({ globalSubordinateTeam: added.map(member) }).globalSubordinateTeam?.map(
        (row) => row.role,
      ),
    ).toEqual(added);
    expect(added.map((role) => threadTeamRoleLabels[role as ThreadTeamRole])).toEqual([
      "설계",
      "검증",
      "문서화",
    ]);
    expect(Object.keys(threadTeamRoleLabels).toSorted()).toEqual(
      [...ThreadTeamRole.literals].toSorted(),
    );
    expect(ThreadTeamRole.literals.filter(threadTeamRoleMayWrite)).toEqual(["worker", "writer"]);
    expect(() => decodePatch({ globalSubordinateTeam: [member("manager")] })).toThrow();
  });
});
