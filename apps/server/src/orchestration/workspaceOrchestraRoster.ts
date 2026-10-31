import {
  WorkspaceMeetingParticipantId,
  type ServerProvider,
  type WorkspaceMeeting,
  type WorkspaceMeetingParticipant,
} from "@t3tools/contracts";
import { knowledgeContentDigest } from "./workspaceConversationRag.ts";

/** Candidates are advertised by connected providers; the conductor cannot invent accounts or models. */
export function orchestraWorkerCandidates(
  providers: ReadonlyArray<ServerProvider>,
  meeting: WorkspaceMeeting,
): WorkspaceMeetingParticipant[] {
  if (meeting.allowAdditionalWorkers === false) return [];
  const existing = new Set(
    meeting.participants.map(
      (seat) => `${seat.modelSelection.instanceId}\n${seat.modelSelection.model}`,
    ),
  );
  return providers
    .filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.status !== "error" &&
        provider.status !== "disabled" &&
        provider.availability !== "unavailable" &&
        provider.auth.status === "authenticated",
    )
    .flatMap((provider) =>
      provider.models.map((model) => ({
        id: WorkspaceMeetingParticipantId.make(
          `auto-${knowledgeContentDigest(`${provider.instanceId}\n${model.slug}`, 32)}`,
        ),
        displayName:
          `${provider.displayName ?? provider.instanceId} · ${model.shortName ?? model.name}`.slice(
            0,
            200,
          ),
        modelSelection: { instanceId: provider.instanceId, model: model.slug },
      })),
    )
    .filter(
      (seat) => !existing.has(`${seat.modelSelection.instanceId}\n${seat.modelSelection.model}`),
    )
    .slice(0, 64);
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
  if (meeting.participants.length + additions.length > 8)
    throw new Error("작업 AI는 지휘 AI를 포함해 최대 8명입니다. 필요한 담당자만 선택하세요.");
  return additions.length === 0
    ? meeting
    : { ...meeting, participants: [...meeting.participants, ...additions] };
}
