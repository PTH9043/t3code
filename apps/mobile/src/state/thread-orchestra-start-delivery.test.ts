import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";
import { DEFAULT_MOBILE_ORCHESTRA_CONFIG } from "./thread-orchestra-config";
import { deliverOrchestraStart } from "./thread-orchestra-start-delivery";

const attempt = {
  threadKey: "env:thread",
  originalText: "목표",
  config: { ...DEFAULT_MOBILE_ORCHESTRA_CONFIG, enabled: true },
  input: { projectId: ProjectId.make("project"), task: "목표", requestId: "start-id" },
};

describe("mobile orchestra start delivery", () => {
  it("sends the saved request only after persistence has completed", async () => {
    const events: string[] = [];
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const send = vi.fn(async () => {
      events.push("send");
      return "accepted";
    });
    const result = deliverOrchestraStart({
      attempt,
      persist: async () => {
        events.push("write");
        await writing;
        events.push("saved");
        return true;
      },
      send,
    });
    expect(events).toEqual(["write"]);
    expect(send).not.toHaveBeenCalled();
    finish();
    expect(await result).toEqual({ kind: "sent", result: "accepted" });
    expect(events).toEqual(["write", "saved", "send"]);
    expect(send).toHaveBeenCalledWith(attempt.input);
  });

  it("never sends when the draft changed or the durable write failed", async () => {
    const send = vi.fn(async () => "accepted");
    expect(await deliverOrchestraStart({ attempt, persist: async () => false, send })).toEqual({
      kind: "changed",
    });
    await expect(
      deliverOrchestraStart({
        attempt,
        persist: async () => {
          throw new Error("storage failure");
        },
        send,
      }),
    ).rejects.toThrow("storage failure");
    expect(send).not.toHaveBeenCalled();
  });
});
