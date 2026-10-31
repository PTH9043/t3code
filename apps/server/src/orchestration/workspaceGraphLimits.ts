export const MAX_GRAPH_REVISIONS = 8;
/** Existing contract ceiling for a node, including user-requested retries. */
export const MAX_NODE_ATTEMPTS = 10;
export const INITIAL_PLAN_REVISION = 1;

export const graphRevisionBudget = (
  meeting: { readonly maxRevisions?: number | undefined } | null,
): number => Math.min(meeting?.maxRevisions ?? MAX_GRAPH_REVISIONS, MAX_GRAPH_REVISIONS);

export const graphRevisionCap = (
  meeting: { readonly maxRevisions?: number | undefined } | null,
): number => graphRevisionBudget(meeting) + INITIAL_PLAN_REVISION;
