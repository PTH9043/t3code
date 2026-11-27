import {
  EventId,
  TurnId,
  type ConversationHandoffDelivery,
  type ConversationHandoffReport,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { compactOldActivityPayloads, isCompactedActivityPayload } from "./threadReducer.ts";
import { handoffReportText, latestHandoffReport } from "./conversationHandoff.ts";

const report: ConversationHandoffReport = {
  version: 1,
  status: "compact",
  reason: "reduced",
  originalChars: 15000,
  sentChars: 6000,
  savedChars: 9000,
  sourceHash: "abc",
  sourceMessageCount: 30,
};
const activity = (
  id: number,
  payload: unknown,
  kind = "conversation.handoff.prepared",
): OrchestrationThreadActivity => ({
  id: EventId.make(`activity-${id}`),
  kind,
  tone: "info",
  summary: "Prepared",
  payload,
  turnId: null,
  createdAt: "2026-09-05T03:00:00.000Z",
});
describe("handoff evidence display", () => {
  it("keeps exact character comparison separate from token usage and rejects malformed payloads", () => {
    expect(handoffReportText(report)).toBe("인계 입력 15,000 → 6,000자 · 9,000자 감소");
    expect(
      latestHandoffReport([activity(1, report), activity(2, { status: "compact" })])?.report,
    ).toEqual(report);
    expect(latestHandoffReport([activity(1, { ...report, savedChars: -1 })])).toBeNull();
  });
  it("reads a delivered comparison at the delivery time and never infers a comparison from character length", () => {
    const delivery: ConversationHandoffDelivery = {
      backend: "projection",
      requestedMode: "compact",
      chars: 6500,
      compactReport: report,
    };
    const delivered = {
      ...activity(2, delivery, "conversation.handoff.delivered"),
      createdAt: "2026-09-05T04:00:00.000Z",
    };
    const prepared = activity(1, { ...report, sourceHash: "earlier" });
    const standard = activity(
      3,
      { backend: "projection", requestedMode: "standard", chars: 700 },
      "conversation.handoff.delivered",
    );
    const malformed = activity(
      4,
      { ...delivery, compactReport: { ...report, savedChars: -1 } },
      "conversation.handoff.delivered",
    );
    expect(latestHandoffReport([prepared, delivered])).toEqual({
      report,
      createdAt: delivered.createdAt,
    });
    expect(latestHandoffReport([standard, malformed])).toBeNull();
    expect(latestHandoffReport([delivered, standard])).toEqual({
      report,
      createdAt: delivered.createdAt,
    });
  });
  it("retains prepared, delivered and turn assignment receipts when old tool output is compacted", () => {
    const turnId = TurnId.make("accepted-turn");
    const delivered = {
      ...activity(
        1,
        { backend: "projection", requestedMode: "compact", chars: 6500, compactReport: report },
        "conversation.handoff.delivered",
      ),
      turnId,
    };
    const assigned = {
      ...activity(2, { instanceId: "account", model: "answer" }, "conversation.turn-assigned"),
      turnId,
    };
    const activities = [
      activity(0, report),
      delivered,
      assigned,
      ...Array.from({ length: 305 }, (_, i) =>
        activity(i + 3, { output: "old log" }, "tool.completed"),
      ),
    ];
    const compacted = compactOldActivityPayloads(activities);
    expect(compacted.slice(0, 3)).toEqual(activities.slice(0, 3));
    expect(isCompactedActivityPayload(compacted[3]!)).toBe(true);
    expect(latestHandoffReport(compacted)?.report).toEqual(report);
  });
});
