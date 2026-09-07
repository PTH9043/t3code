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

export interface RunAttentionItem {
  readonly runId: string;
  readonly task: string;
  /** The question the run is parked on right now, if any. */
  readonly liveQuestion: string | null;
  /** Questions other nodes raised while the slot was taken. */
  readonly queuedQuestions: number;
  /** Nodes parked on the person, including the one asking `liveQuestion`. */
  readonly awaitingUser: number;
}

interface AttentionRunInput {
  readonly id: string;
  readonly status: string;
  readonly task: string;
  readonly meeting: { readonly pendingQuestion: { readonly question: string } | null } | null;
  readonly graph: { readonly nodes: ReadonlyArray<WorkspaceTaskNode> } | null;
}

/**
 * The runs waiting on the person, newest first. A parallel run can hold one
 * live question and several parked behind it, so a person scanning the
 * control centre needs the count as much as the question itself — otherwise
 * answering once looks like the run is unblocked when it is not.
 *
 * Cancelled and finished runs are excluded: their questions are history.
 */
export const runsAwaitingPerson = (
  runs: Iterable<AttentionRunInput>,
): ReadonlyArray<RunAttentionItem> => {
  const items: Array<RunAttentionItem> = [];
  for (const run of runs) {
    if (run.status !== "queued" && run.status !== "running") continue;
    const nodes = run.graph?.nodes ?? [];
    const awaitingUser = nodes.filter((node) => node.status === "awaiting-user").length;
    const queuedQuestions = nodes.filter((node) => node.parkedQuestion !== null).length;
    const liveQuestion = run.meeting?.pendingQuestion?.question ?? null;
    if (liveQuestion === null && awaitingUser === 0) continue;
    items.push({
      runId: run.id,
      task: run.task,
      liveQuestion,
      queuedQuestions,
      awaitingUser,
    });
  }
  return items;
};
