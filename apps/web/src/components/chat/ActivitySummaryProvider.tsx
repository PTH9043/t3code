import { createContext, useMemo, type ReactNode } from "react";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  WS_METHODS,
  type EnvironmentId,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@t3tools/contracts";
import { makeThreadActivitySummaryReader } from "@t3tools/client-runtime/state/thread-tool-activity";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentSessionState } from "~/state/session";
import type { TurnDiffSummary } from "../../types";

const summarize = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: WS_METHODS.serverSummarizeToolActivity,
  label: "chat:summarize-tool-activity",
});
type RequestSummary = ReturnType<typeof makeThreadActivitySummaryReader>;
export const ActivitySummaryContext = createContext<RequestSummary | null>(null);
export const ActivityRecordContext = createContext<ReadonlyMap<
  string,
  OrchestrationThreadActivity
> | null>(null);
export const ActivityDiffContext = createContext<{
  ready: ReadonlyMap<string, TurnDiffSummary>;
  open: (turnId: TurnDiffSummary["turnId"], file?: string) => void;
} | null>(null);

export function ActivitySummaryProvider({
  environmentId,
  threadId,
  activities,
  checkpoints,
  onOpenTurnDiff,
  children,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  checkpoints: readonly TurnDiffSummary[];
  activities: readonly OrchestrationThreadActivity[];
  onOpenTurnDiff: (turnId: TurnDiffSummary["turnId"], file?: string) => void;
  children: ReactNode;
}) {
  const run = useAtomCommand(summarize, { reportFailure: false });
  const session = useEnvironmentSessionState(environmentId).data;
  const allowed =
    session?.authenticated === true && session.scopes?.includes(AuthOrchestrationOperateScope);
  const requestSummary = useMemo<RequestSummary | null>(() => {
    if (!threadId || !allowed) return null;
    return makeThreadActivitySummaryReader(threadId, async (input) => {
      const result = await run({ environmentId, input });
      return result._tag === "Success" ? result.value : null;
    });
  }, [run, environmentId, threadId, allowed]);
  const diff = useMemo(
    () => ({
      ready: new Map(
        checkpoints
          .filter((c) => c.status === "ready" && c.files.length > 0)
          .map((c) => [c.turnId, c]),
      ),
      open: onOpenTurnDiff,
    }),
    [checkpoints, onOpenTurnDiff],
  );
  const mayRead =
    session?.authenticated === true && session.scopes?.includes(AuthOrchestrationReadScope);
  const records = useMemo(
    () => (mayRead && threadId ? new Map(activities.map((a) => [a.id, a])) : null),
    [mayRead, threadId, activities],
  );
  return (
    <ActivitySummaryContext.Provider value={requestSummary}>
      <ActivityDiffContext.Provider value={diff}>
        <ActivityRecordContext.Provider value={records}>{children}</ActivityRecordContext.Provider>
      </ActivityDiffContext.Provider>
    </ActivitySummaryContext.Provider>
  );
}
