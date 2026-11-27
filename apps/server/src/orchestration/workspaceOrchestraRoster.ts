import {
  WorkspaceMeetingParticipantId,
  type ServerProvider,
  type WorkspaceMeeting,
  type WorkspaceMeetingParticipant,
} from "@t3tools/contracts";
import { knowledgeContentDigest } from "./workspaceConversationRag.ts";

/** Earlier runs used a digest of provider and model for automatically added seats. */
function isAutomaticallyAddedSeat(seat: WorkspaceMeetingParticipant): boolean {
  const selection = seat.modelSelection;
  const oldId = `auto-${knowledgeContentDigest(`${selection.instanceId}\n${selection.model}`, 32)}`;
  const currentId = `auto-${knowledgeContentDigest(JSON.stringify(selection), 32)}`;
  return seat.id === oldId || seat.id === currentId;
}

/** Retain old records, but only plan with automatic seats whose exact model and options are selected. */
export function meetingWithAuthorizedSeats(meeting: WorkspaceMeeting): WorkspaceMeeting {
  const selected = new Set(
    meeting.participants
      .filter((seat) => seat.id === meeting.chairParticipantId || !isAutomaticallyAddedSeat(seat))
      .map((seat) => JSON.stringify(seat.modelSelection)),
  );
  return {
    ...meeting,
    participants: meeting.participants.filter(
      (seat) =>
        seat.id === meeting.chairParticipantId ||
        !isAutomaticallyAddedSeat(seat) ||
        selected.has(JSON.stringify(seat.modelSelection)),
    ),
  };
}

/** Additional seats may reuse only a model and options already chosen by the user. */
export function orchestraWorkerCandidates(
  providers: ReadonlyArray<ServerProvider>,
  meeting: WorkspaceMeeting,
): WorkspaceMeetingParticipant[] {
  if (meeting.allowAdditionalWorkers !== true) return [];
  const available = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status !== "error" &&
      provider.status !== "disabled" &&
      provider.availability !== "unavailable" &&
      provider.auth.status === "authenticated",
  );
  const candidates = new Map<string, WorkspaceMeetingParticipant>();
  for (const seat of meeting.participants) {
    if (isAutomaticallyAddedSeat(seat) && seat.id !== meeting.chairParticipantId) continue;
    if (
      !available.some(
        (provider) =>
          provider.instanceId === seat.modelSelection.instanceId &&
          provider.models.some((model) => model.slug === seat.modelSelection.model),
      )
    )
      continue;
    const selection = seat.modelSelection;
    const id = WorkspaceMeetingParticipantId.make(
      `auto-${knowledgeContentDigest(JSON.stringify(selection), 32)}`,
    );
    if (meeting.participants.some((existing) => existing.id === id)) continue;
    if (!candidates.has(id)) {
      candidates.set(id, {
        ...seat,
        id,
        displayName: `${seat.displayName} · 추가`.slice(0, 200),
        modelSelection: selection,
      });
    }
  }
  return [...candidates.values()];
}

/** Preserve the user's conductor and seats; only selected candidates become workers. */
export function seatAssignedWorkers(
  meeting: WorkspaceMeeting,
  candidates: ReadonlyArray<WorkspaceMeetingParticipant>,
  assignments: ReadonlyArray<{ readonly participantId: WorkspaceMeetingParticipantId | null }>,
): WorkspaceMeeting {
  const selected = new Set(assignments.map((node) => node.participantId));
  const additions = candidates.filter(
    (candidate) =>
      selected.has(candidate.id) && !meeting.participants.some((seat) => seat.id === candidate.id),
  );
  return additions.length === 0
    ? meeting
    : { ...meeting, participants: [...meeting.participants, ...additions] };
}
