import { describe, expect, it } from "vite-plus/test";
import { workflowDefaults } from "@t3tools/shared/workflow";
import {
  ProviderInstanceId,
  WorkspaceMeetingParticipantId,
  WorkspaceWorkflowError,
  type WorkflowVersion,
  type WorkspaceMeetingSetup,
} from "@t3tools/contracts";
import {
  chatWorkflowChoices,
  chatWorkflowValues,
  exactWorkflowModelSelection,
  resolveWorkflowRoleModels,
  selectIndependentMeetingCoordinator,
  workflowStartFailureMessage,
} from "./chatWorkflow";

const definition = workflowDefaults()[0]!;
const saved: WorkflowVersion = {
  ...definition,
  revision: 2,
  digest: "a".repeat(64),
  archived: false,
  createdAt: "2026-10-27T00:00:00.000Z",
};

describe("workflow start failures", () => {
  it("shows the server reason while keeping the uncertain request retry guidance", () => {
    const text = workflowStartFailureMessage(
      new WorkspaceWorkflowError({ message: "지정한 참가자 목록만 사용할 수 있습니다." }),
    );
    expect(text).toContain("지정한 참가자 목록만 사용할 수 있습니다.");
    expect(text).toContain("같은 요청으로 다시 확인");
    expect(text).not.toContain("실행되지 않았습니다");
  });

  it("keeps transport details and handles missing details without inventing a cause", () => {
    expect(workflowStartFailureMessage(new Error("연결이 끊겼습니다"))).toContain(
      "연결이 끊겼습니다",
    );
    expect(workflowStartFailureMessage({ message: "서버 오류" })).toContain("서버 오류");
    expect(workflowStartFailureMessage(null)).not.toContain("오류:");
  });
});

describe("chat workflow choices", () => {
  it("keeps the exact selected model and options or refuses an automatic replacement", () => {
    const selected = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1-terra",
      options: [{ id: "reasoningEffort", value: "medium" }],
    };
    expect(exactWorkflowModelSelection(selected, { ...selected, options: [] }, true)).toEqual(
      selected,
    );
    expect(
      exactWorkflowModelSelection(selected, { ...selected, model: "gpt-6-astra" }, true),
    ).toBeNull();
    expect(exactWorkflowModelSelection(selected, selected, false)).toBeNull();
    expect(exactWorkflowModelSelection(undefined, selected, true)).toBeNull();
  });
  it("uses saved versions once and keeps basic templates available without saving them", () => {
    const choices = chatWorkflowChoices({
      definitions: [saved],
      defaults: workflowDefaults(),
      runs: [],
    });
    expect(choices).toHaveLength(6);
    expect(choices[0]?.version).toBe(saved);
    expect(choices.filter((choice) => choice.definition.id === definition.id)).toHaveLength(1);
    expect(choices.find((choice) => choice.definition.id === "bugfix")?.version).toBeNull();
  });
  it("does not revive an archived workflow through its basic template", () => {
    const choices = chatWorkflowChoices({
      definitions: [{ ...saved, archived: true }],
      defaults: workflowDefaults(),
      runs: [],
    });
    expect(choices.some((choice) => choice.definition.id === saved.id)).toBe(false);
    expect(chatWorkflowChoices(null)).toEqual([]);
  });
  it("prefills the goal without clearing an edited goal or inventing extra inputs", () => {
    expect(chatWorkflowValues(definition, {}, "Chat draft")).toEqual({ goal: "Chat draft" });
    expect(
      chatWorkflowValues(
        definition,
        { goal: "Edited goal", unrelated: "keep outside" },
        "New chat draft",
      ),
    ).toEqual({ goal: "Edited goal" });
    expect(chatWorkflowValues(definition, { goal: "" }, "Chat draft")).toEqual({ goal: "" });
  });
  it("uses one selected model for all roles or keeps each explicit role selection", () => {
    const lead = { instanceId: ProviderInstanceId.make("claude"), model: "lead" };
    const build = { instanceId: ProviderInstanceId.make("codex"), model: "build" };
    const research = { instanceId: ProviderInstanceId.make("grok"), model: "research" };
    const roles = { coordinator: lead, implementer: build, researcher: research };
    expect(resolveWorkflowRoleModels("single", build, roles)).toEqual({
      coordinator: build,
      implementer: build,
      researcher: build,
    });
    expect(resolveWorkflowRoleModels("roles", build, roles)).toEqual(roles);
    expect(resolveWorkflowRoleModels("roles", build, { coordinator: lead })).toBeUndefined();
    expect(resolveWorkflowRoleModels("single", null, roles)).toBeUndefined();
    expect(resolveWorkflowRoleModels("project", build, roles)).toBeUndefined();
  });
  it("uses the exact selected chat model, including its options, for each role", () => {
    const selected = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "selected-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    expect(resolveWorkflowRoleModels("current", null, {}, selected)).toEqual({
      coordinator: selected,
      implementer: selected,
      researcher: selected,
    });
    expect(resolveWorkflowRoleModels("current", null, {}, null)).toBeUndefined();
  });
});

describe("independent meeting coordinator", () => {
  const coordinator = {
    id: WorkspaceMeetingParticipantId.make("supervisor"),
    displayName: "Supervisor",
    modelSelection: { instanceId: ProviderInstanceId.make("provider"), model: "supervisor-model" },
  };
  const meeting: WorkspaceMeetingSetup = {
    mode: "fixed-rounds",
    participants: [coordinator],
    chairParticipantId: coordinator.id,
    maxRounds: 0,
    userInLoop: false,
  };

  it("preserves the explicitly selected supervisor and roster", () => {
    const result = selectIndependentMeetingCoordinator(meeting, {
      instanceId: ProviderInstanceId.make("chat"),
      model: "chat-model",
    });
    expect(result).toEqual({ meeting, error: null });
  });

  it("requires an assigned supervisor and permits the same model as the chat", () => {
    expect(
      selectIndependentMeetingCoordinator({ ...meeting, chairParticipantId: null }, null),
    ).toMatchObject({ meeting: null, error: expect.any(String) });
    expect(
      selectIndependentMeetingCoordinator(meeting, {
        instanceId: ProviderInstanceId.make("other-account"),
        model: "supervisor-model",
      }),
    ).toEqual({ meeting, error: null });
  });
});
