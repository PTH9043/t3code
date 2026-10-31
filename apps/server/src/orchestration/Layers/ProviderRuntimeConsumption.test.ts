import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

it("persists late consumption for its original turn without inventing context occupancy", () => {
  const consumption = [
    {
      sourceId: "grok-request",
      provider: "grok",
      model: "grok-4.6-build",
      mode: "execution-total" as const,
      isFinal: true,
      counts: { total: 42, input: 40, output: 2, cacheRead: 20, cacheWrite: 0, reasoning: 1 },
    },
  ];
  const activities = runtimeEventToActivities({
    type: "thread.token-usage.updated",
    eventId: EventId.make("late-consumption"),
    provider: ProviderDriverKind.make("grok"),
    threadId: ThreadId.make("thread"),
    turnId: TurnId.make("original-turn"),
    createdAt: "2026-09-12T00:00:00.000Z",
    payload: { consumption },
  });
  expect(activities).toHaveLength(1);
  expect(activities[0]?.turnId).toBe("original-turn");
  expect(activities[0]?.payload).toEqual({ consumption });
});
