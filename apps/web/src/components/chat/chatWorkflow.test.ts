import { describe, expect, it } from "vite-plus/test";
import { workflowDefaults } from "@t3tools/shared/workflow";
import {
  ProviderInstanceId,
  WorkspaceMeetingParticipantId,
  type WorkflowVersion,
  type WorkspaceMeetingSetup,
} from "@t3tools/contracts";
import {
  chatWorkflowChoices,
  chatWorkflowValues,
  resolveWorkflowRoleModels,
  selectMeetingCoordinator,
} from "./chatWorkflow";

const definition = workflowDefaults()[0]!;
const saved: WorkflowVersion = {
  ...definition,
  revision: 2,
  digest: "a".repeat(64),
  archived: false,
  createdAt: "2026-10-27T00:00:00.000Z",
};

describe("chat workflow choices", () => {
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

describe("selected meeting coordinator", () => {
  const seat = (name: string) => ({
    id: WorkspaceMeetingParticipantId.make(name),
    displayName: name,
    modelSelection: { instanceId: ProviderInstanceId.make(name), model: `${name}-model` },
  });
  const original: WorkspaceMeetingSetup = {
    mode: "fixed-rounds",
    participants: [seat("fable"), seat("worker")],
    chairParticipantId: WorkspaceMeetingParticipantId.make("fable"),
    maxRounds: 0,
    userInLoop: false,
  };
  const chosen = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "chosen-model",
    options: [{ id: "effort", value: "high" }],
  };

  it("uses the chosen model as chair without automatically running the old Fable model", () => {
    const result = selectMeetingCoordinator(original, chosen);
    expect(result.error).toBeNull();
    expect(result.meeting?.chairParticipantId).toBe("selected-coordinator");
    expect(result.meeting?.participants.map((seat) => seat.modelSelection.model)).toEqual([
      "worker-model",
      "chosen-model",
    ]);
    expect(result.meeting?.participants[1]?.modelSelection).toEqual(chosen);
    expect(original.chairParticipantId).toBe("fable");
    expect(original.participants).toHaveLength(2);
  });

  it("reuses a matching seat and applies the selected options to that run", () => {
    const roster = { ...original, participants: [seat("another"), seat("worker")] };
    const selected = { ...roster.participants[1]!.modelSelection, options: chosen.options };
    const result = selectMeetingCoordinator(roster, selected);
    expect(result.meeting?.chairParticipantId).toBe("worker");
    expect(result.meeting?.participants).toHaveLength(2);
    expect(result.meeting?.participants[1]?.modelSelection).toEqual(selected);
    expect(roster.participants[1]?.modelSelection).not.toHaveProperty("options");
  });

  it("reports too few participants instead of running an unselected Fable seat", () => {
    const selected = original.participants[1]!.modelSelection;
    expect(selectMeetingCoordinator(original, selected)).toMatchObject({
      meeting: null,
      error: expect.any(String),
    });
    expect(original.participants).toHaveLength(2);
  });

  it("allows Fable when explicitly selected as the chair or another role", () => {
    const fable = original.participants[0]!.modelSelection;
    expect(selectMeetingCoordinator(original, fable).meeting?.chairParticipantId).toBe("fable");
    const result = selectMeetingCoordinator(original, chosen, [fable]);
    expect(result.meeting?.participants.map((seat) => seat.modelSelection.model)).toEqual([
      "fable-model",
      "worker-model",
      "chosen-model",
    ]);
  });

  it("reports a full roster instead of dropping a participant or the selected model", () => {
    const full = { ...original, participants: Array.from({ length: 8 }, (_, i) => seat(`s${i}`)) };
    expect(selectMeetingCoordinator(full, chosen)).toMatchObject({
      meeting: null,
      error: expect.any(String),
    });
    expect(selectMeetingCoordinator(full, undefined).meeting).toBe(full);
  });
});
