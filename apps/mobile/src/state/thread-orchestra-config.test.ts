import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceMeetingParticipantId,
} from "@t3tools/contracts";
import {
  createMobileOrchestraStart,
  DEFAULT_MOBILE_ORCHESTRA_CONFIG,
  MobileOrchestraConfigSchema,
} from "./thread-orchestra-config";

const current = { instanceId: ProviderInstanceId.make("codex"), model: "model-a" };
const supervisor = {
  id: WorkspaceMeetingParticipantId.make("supervisor"),
  displayName: "감독",
  roleDescription: "방향과 검증",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "model-b" },
};
const worker = {
  id: WorkspaceMeetingParticipantId.make("worker"),
  displayName: "작업자",
  roleDescription: "구현",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model-c" },
};
const base = {
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
  currentModel: current,
  runtimeMode: "full-access" as const,
  interactionMode: "plan" as const,
  task: "  작업 목표  ",
  requestId: "request-1",
  availableModels: [supervisor.modelSelection, worker.modelSelection],
  config: {
    ...DEFAULT_MOBILE_ORCHESTRA_CONFIG,
    enabled: true,
    participants: [supervisor],
    chairParticipantId: supervisor.id,
  },
};

describe("mobile conversation orchestra configuration", () => {
  it("starts with only a supervisor and keeps the conversation's selected policies", () => {
    const result = createMobileOrchestraStart(base);
    expect(result.error).toBeNull();
    expect(result.start).toMatchObject({
      projectId: base.projectId,
      threadId: base.threadId,
      task: "작업 목표",
      requestId: "request-1",
      runtimeMode: "full-access",
      interactionMode: "plan",
      meeting: { participants: [supervisor], chairParticipantId: supervisor.id, maxRounds: 0 },
      orchestra: { executionMode: "once" },
    });
  });

  it("keeps each role and explicit persistent, discussion and review choices", () => {
    const result = createMobileOrchestraStart({
      ...base,
      config: {
        ...base.config,
        participants: [supervisor, worker],
        executionMode: "persistent",
        style: "meeting",
        askFirst: true,
        reviewPlan: true,
      },
    });
    expect(result.start).toMatchObject({
      requestMode: "ask-first",
      meeting: { askFirst: true, participants: [supervisor, worker], maxRounds: 2 },
      orchestra: { executionMode: "persistent", reviewPlan: true },
    });
  });

  it("persists and starts more than eight user-selected seats with their roles", () => {
    const participants = Array.from({ length: 12 }, (_, index) => ({
      ...supervisor,
      id: WorkspaceMeetingParticipantId.make(`seat-${index}`),
      roleDescription: `사용자 역할 ${index}`,
    }));
    const config = Schema.decodeUnknownSync(MobileOrchestraConfigSchema)({
      ...base.config,
      participants,
      chairParticipantId: participants[0]!.id,
    });
    const result = createMobileOrchestraStart({ ...base, config });
    expect(result.start?.meeting?.participants).toHaveLength(12);
    expect(result.start?.meeting?.participants[11]?.roleDescription).toBe("사용자 역할 11");
  });

  it("does not replace an unavailable or invalid supervisor with another model", () => {
    expect(createMobileOrchestraStart({ ...base, availableModels: [] }).start).toBeNull();
    expect(
      createMobileOrchestraStart({ ...base, currentModel: supervisor.modelSelection }).start,
    ).not.toBeNull();
    expect(
      createMobileOrchestraStart({ ...base, config: { ...base.config, chairParticipantId: null } })
        .start,
    ).toBeNull();
  });
});
