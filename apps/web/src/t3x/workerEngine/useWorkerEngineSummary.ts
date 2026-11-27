import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";

import { getWorkerStatus } from "./workerEngineClient";
import { computeWorkerEngineCounts, type WorkerEngineSummaryCounts } from "./workerEngineUi.logic";

const EMPTY_COUNTS: WorkerEngineSummaryCounts = computeWorkerEngineCounts(null);

export function useWorkerEngineSummary(options: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly pollIntervalMs?: number;
}): WorkerEngineSummaryCounts {
  const { enabled, environmentId, threadId, pollIntervalMs = 15_000 } = options;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [counts, setCounts] = useState<WorkerEngineSummaryCounts>(EMPTY_COUNTS);

  const requestContext = useMemo(
    () => ({ environmentId, primaryEnvironmentId }),
    [environmentId, primaryEnvironmentId],
  );

  useEffect(() => {
    if (!enabled || !threadId) {
      setCounts(EMPTY_COUNTS);
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const refresh = async () => {
      if (cancelled || inFlight) return;
      if (typeof document !== "undefined" && document.hidden) return;
      inFlight = true;
      try {
        const status = await getWorkerStatus({ threadId }, requestContext);
        if (!cancelled) {
          setCounts(computeWorkerEngineCounts(status));
        }
      } catch {
        // Keep last known counts silently so transient offline states never spam toasts.
      } finally {
        inFlight = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, pollIntervalMs, requestContext, threadId]);

  return counts;
}
