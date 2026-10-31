import { expect, it } from "vite-plus/test";
import { ServerProvider, WorkspaceMeeting } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { orchestraWorkerCandidates, seatAssignedWorkers } from "./workspaceOrchestraRoster.ts";
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

const meeting = Schema.decodeUnknownSync(WorkspaceMeeting)({
  mode: "fixed-rounds",
  phase: "planning",
  threadId: "owner",
  participants: [
    {
      id: "chair",
      displayName: "My conductor",
      modelSelection: { instanceId: "codex", model: "selected" },
    },
    {
      id: "initial",
      displayName: "My worker",
      modelSelection: { instanceId: "claude", model: "selected" },
    },
  ],
  chairParticipantId: "chair",
  maxRounds: 0,
  userInLoop: false,
  rounds: [],
  pendingQuestion: null,
  answers: [],
});
const provider = (instanceId: string, overrides: Record<string, unknown> = {}) =>
  decodeProvider({
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-11T00:00:00.000Z",
    models: [{ slug: "extra", name: "Extra", isCustom: false, capabilities: null }],
    ...overrides,
  });

it("offers only connected enabled accounts and excludes selected models", () => {
  const candidates = orchestraWorkerCandidates(
    [
      provider("ready"),
      provider("disabled", { enabled: false }),
      provider("missing", { installed: false }),
      provider("signed-out", { auth: { status: "unauthenticated" } }),
      provider("broken", { status: "error" }),
      provider("codex", {
        models: [{ slug: "selected", name: "Selected", isCustom: false, capabilities: null }],
      }),
    ],
    meeting,
  );
  expect(candidates.map((seat) => seat.modelSelection.instanceId)).toEqual(["ready"]);
});

it("does not offer unselected models when the user confines the conductor to the roster", () => {
  expect(
    orchestraWorkerCandidates([provider("ready")], { ...meeting, allowAdditionalWorkers: false }),
  ).toEqual([]);
  expect(
    orchestraWorkerCandidates([provider("ready")], { ...meeting, allowAdditionalWorkers: true }),
  ).toHaveLength(1);
});

it("adds the conductor's chosen worker while retaining the user-selected conductor and initial seats", () => {
  const candidates = orchestraWorkerCandidates([provider("ready"), provider("unused")], meeting);
  const assigned = seatAssignedWorkers(meeting, candidates, [{ participantId: candidates[0]!.id }]);
  expect(assigned.chairParticipantId).toBe("chair");
  expect(assigned.participants.slice(0, 2)).toEqual(meeting.participants);
  expect(assigned.participants.map((seat) => seat.id)).toEqual([
    "chair",
    "initial",
    candidates[0]!.id,
  ]);
  expect(
    seatAssignedWorkers(assigned, candidates, [{ participantId: candidates[0]!.id }]).participants,
  ).toHaveLength(3);
});
