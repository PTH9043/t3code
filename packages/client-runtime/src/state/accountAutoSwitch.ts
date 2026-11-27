import type { ModelSelection, OrchestrationThreadActivity } from "@t3tools/contracts";
import { Equal } from "effect";

/** Apply an automatic account change only to the unchanged draft that produced it. */
export function reconcileAutomaticAccountSwitch(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
  threadSelection: ModelSelection | null | undefined,
  draftSelection: ModelSelection | null | undefined,
): ModelSelection | undefined {
  if (activity.kind !== "provider.account.auto-switched" || !threadSelection || !draftSelection)
    return undefined;
  if (!activity.payload || typeof activity.payload !== "object") return undefined;
  const payload = activity.payload as { previousInstanceId?: unknown; nextInstanceId?: unknown };
  if (
    payload.previousInstanceId !== draftSelection.instanceId ||
    payload.nextInstanceId !== threadSelection.instanceId ||
    draftSelection.model !== threadSelection.model ||
    !Equal.equals(draftSelection.options ?? [], threadSelection.options ?? [])
  )
    return undefined;
  return threadSelection;
}
