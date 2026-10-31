import type {
  ThreadId,
  WorkspaceMeetingParticipant,
  WorkspaceTaskNode,
  WorkspaceTaskNodeStatus,
} from "@t3tools/contracts";

import { seatLookupFrom } from "../control-center/taskGraphPresentation";

/** Only the parts of a run this list reads, so fixtures stay small. */
interface OrchestraRunInput {
  readonly status: string;
  readonly orchestra: unknown;
  readonly meeting: {
    readonly threadId: ThreadId | null;
    readonly participants?: ReadonlyArray<WorkspaceMeetingParticipant>;
  } | null;
  readonly graph: { readonly nodes: ReadonlyArray<WorkspaceTaskNode> } | null;
}

export interface OrchestraNodeConversation {
  readonly threadId: ThreadId;
  readonly nodeId: string;
  readonly title: string;
  readonly status: WorkspaceTaskNodeStatus;
  /** The seat name the person picked, when the run has a roster. */
  readonly seatLabel: string | null;
  /** Live runs list before settled ones, so in-flight work reads first. */
  readonly runIsLive: boolean;
}

const LIVE_RUN_STATUSES = new Set(["queued", "running", "cancel-requested"]);

/**
 * Ranks the statuses a person is most likely to be looking for. A parked node
 * is why they opened this list at all, and a running one is where the work is;
 * everything settled keeps the graph's own order underneath.
 */
const STATUS_RANK: Readonly<Record<WorkspaceTaskNodeStatus, number>> = {
  "awaiting-user": 0,
  running: 1,
  "awaiting-validation": 2,
  queued: 3,
  blocked: 4,
  failed: 5,
  completed: 6,
  cancelled: 7,
  skipped: 8,
};

/**
 * The node conversations that belong to one orchestra conversation.
 *
 * An orchestra run executes each node in its own conversation, because
 * parallel nodes need a provider session each. Those conversations are kept
 * out of the conversation list, so this is how a person reaches them: from the
 * conversation that convened the run. Settled runs are included — the record of
 * what a node actually did outlives the run.
 */
export function orchestraNodeConversations(
  runs: Iterable<OrchestraRunInput>,
  ownerThreadId: ThreadId,
): readonly OrchestraNodeConversation[] {
  const items: Array<OrchestraNodeConversation & { readonly order: number }> = [];
  const seen = new Set<string>();
  for (const run of runs) {
    if (run.orchestra === null || run.meeting?.threadId !== ownerThreadId) continue;
    const seats = seatLookupFrom(run.meeting?.participants);
    const runIsLive = LIVE_RUN_STATUSES.has(run.status);
    for (const node of run.graph?.nodes ?? []) {
      // The run's own conversation is this one; only the node conversations it
      // spawned belong in the list.
      if (node.threadId === null || node.threadId === ownerThreadId) continue;
      if (seen.has(node.threadId)) continue;
      seen.add(node.threadId);
      items.push({
        threadId: node.threadId,
        nodeId: String(node.id),
        title: node.title,
        status: node.status,
        seatLabel:
          node.participantId === null ? null : (seats.get(String(node.participantId)) ?? null),
        runIsLive,
        order: node.order,
      });
    }
  }
  return items
    .toSorted(
      (left, right) =>
        Number(right.runIsLive) - Number(left.runIsLive) ||
        STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
        left.order - right.order ||
        left.nodeId.localeCompare(right.nodeId),
    )
    .map(({ order: _order, ...item }) => item);
}
