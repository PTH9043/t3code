import type {
  OrchestrationThreadActivity,
  OrchestrationLatestTurn,
  OrchestrationCheckpointSummary,
} from "@t3tools/contracts";
import { separateThreadToolActivities } from "@t3tools/client-runtime/state/thread-tool-activity";
import { deriveWorkLogEntries, type WorkLogEntry } from "../../session-logic";

export function deriveThreadTimelineWork(
  activities: readonly OrchestrationThreadActivity[],
  latest?: OrchestrationLatestTurn | null,
  checkpoints?: readonly OrchestrationCheckpointSummary[],
  activeTurnId?: OrchestrationThreadActivity["turnId"],
): WorkLogEntry[] {
  const { tools, otherActivities } = separateThreadToolActivities(
    activities,
    latest,
    checkpoints,
    activeTurnId,
  );
  const work = deriveWorkLogEntries(
    otherActivities.filter((event) => event.kind !== "orchestra.block"),
  );
  return [...work, ...tools].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
