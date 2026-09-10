import {
  EventId,
  type ConversationHandoffReport,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { compactOldActivityPayloads } from "./threadReducer.ts";
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
  it("retains the small comparison payload when old tool output is compacted", () => {
    const activities = [
      activity(0, report),
      ...Array.from({ length: 305 }, (_, i) =>
        activity(i + 1, { output: "old log" }, "tool.completed"),
      ),
    ];
    expect(latestHandoffReport(compactOldActivityPayloads(activities))?.report).toEqual(report);
  });
});
