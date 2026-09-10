import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ClientOrchestrationCommand, ThreadMetaUpdatedPayload } from "./orchestration.ts";

const isCommand = Schema.is(ClientOrchestrationCommand);
const decodePayload = Schema.decodeUnknownSync(ThreadMetaUpdatedPayload);
describe("handoff setting wire compatibility", () => {
  it("accepts opt-in and reversal over the existing metadata command", () => {
    for (const handoffMode of ["standard", "compact"]) {
      expect(
        isCommand({
          type: "thread.meta.update",
          commandId: "cmd",
          threadId: "thread",
          handoffMode,
        }),
      ).toBe(true);
    }
    expect(
      isCommand({
        type: "thread.meta.update",
        commandId: "cmd",
        threadId: "thread",
        handoffMode: "aggressive",
      }),
    ).toBe(false);
  });
  it("keeps old payloads valid without silently enabling compression", () => {
    expect(
      decodePayload({
        threadId: "thread",
        title: "Older server",
        updatedAt: "2026-09-05T03:00:00.000Z",
      }).handoffMode,
    ).toBeUndefined();
  });
});
