import type { WorkspaceMeetingParticipant, WorkspaceTaskNode } from "@t3tools/contracts";

/**
 * Seat id → the name the person gave that seat. On a meeting or orchestra run
 * the roster is what they recognise, so it beats the generic agent label; a
 * role-bound run has no roster and falls back to that label.
 */
export type SeatLookup = ReadonlyMap<string, string>;

export const seatLookupFrom = (
  participants: ReadonlyArray<WorkspaceMeetingParticipant> | undefined,
): SeatLookup => new Map((participants ?? []).map((seat) => [String(seat.id), seat.displayName]));

export interface TaskGraphCounts {
  readonly total: number;
  readonly active: number;
  readonly completed: number;
  readonly failedOrBlocked: number;
  readonly waiting: number;
  /**
   * Nodes parked on the person. Counted apart from `waiting` because a
   * parallel run parks several at once and this is the number they must act
   * on — folded into "waiting" it reads as the run making progress.
   */
  readonly awaitingUser: number;
}

export const summarizeTaskGraphNodes = (nodes: Iterable<WorkspaceTaskNode>): TaskGraphCounts => {
  let total = 0;
  let active = 0;
  let completed = 0;
  let failedOrBlocked = 0;
  let waiting = 0;
  let awaitingUser = 0;
  for (const node of nodes) {
    total += 1;
    if (node.status === "running" || node.status === "awaiting-validation") active += 1;
    else if (node.status === "completed") completed += 1;
    else if (node.status === "failed" || node.status === "blocked") failedOrBlocked += 1;
    else if (node.status === "awaiting-user") awaitingUser += 1;
    else waiting += 1;
  }
  return { total, active, completed, failedOrBlocked, waiting, awaitingUser };
};

/**
 * Questions a run has queued behind its single live question, newest last.
 * The live one is answered in the meeting panel; these are only visible so a
 * person can see what is coming instead of meeting them one at a time.
 */
export const parkedQuestionNodes = (
  nodes: Iterable<WorkspaceTaskNode>,
): ReadonlyArray<WorkspaceTaskNode> =>
  Array.from(nodes).filter((node) => node.parkedQuestion !== null);
