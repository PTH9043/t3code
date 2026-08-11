import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findSidebarProjectKeyForRef,
  resolveRequiredSidebarProjectKey,
} from "./sidebarProjectGrouping";

const firstRef = {
  environmentId: EnvironmentId.make("environment-1"),
  projectId: ProjectId.make("project-1"),
};
const secondRef = {
  environmentId: EnvironmentId.make("environment-1"),
  projectId: ProjectId.make("project-2"),
};
const groups = [
  { projectKey: "first", memberProjectRefs: [firstRef] },
  { projectKey: "second", memberProjectRefs: [secondRef] },
];

describe("required sidebar project scope", () => {
  it("keeps a valid project and replaces a missing selection with the first project", () => {
    expect(resolveRequiredSidebarProjectKey(groups, "second")).toBe("second");
    expect(resolveRequiredSidebarProjectKey(groups, null)).toBe("first");
    expect(resolveRequiredSidebarProjectKey(groups, "removed")).toBe("first");
    expect(resolveRequiredSidebarProjectKey([], null)).toBeNull();
  });

  it("finds the project scope that owns a routed conversation", () => {
    expect(findSidebarProjectKeyForRef(groups, secondRef)).toBe("second");
    expect(
      findSidebarProjectKeyForRef(groups, {
        environmentId: EnvironmentId.make("environment-2"),
        projectId: ProjectId.make("missing"),
      }),
    ).toBeNull();
  });
});
