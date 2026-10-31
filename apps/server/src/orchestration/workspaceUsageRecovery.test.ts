import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderUsage } from "@t3tools/contracts";
import { planWorkspaceUsageRecovery } from "./workspaceUsageRecovery.ts";
import {
  buildInitialWorkspaceTaskGraph,
  dispatchableWorkspaceTaskNodes,
} from "./workspaceTaskGraph.ts";
const nowMs = Date.parse("2026-10-22T00:00:00.000Z");
const usage: ServerProviderUsage = {
  source: "provider",
  updatedAt: "2026-10-22T00:00:00.000Z",
  sessionTokens: 0,
  sessionCount: 0,
  activeSessionCount: 0,
  primary: { usedPercent: 100, resetsAt: nowMs / 1000 + 60 },
};
const input = {
  enabled: true,
  error: "HTTP 429 Too Many Requests",
  providerInstanceId: "provider",
  usage,
  attempts: 1,
  nowMs,
};
describe("workspace usage recovery", () => {
  it("requires opt-in, a real limit error and a known future reset", () => {
    expect(planWorkspaceUsageRecovery({ ...input, enabled: false })).toBeUndefined();
    expect(
      planWorkspaceUsageRecovery({ ...input, error: "authentication failed" }),
    ).toBeUndefined();
    expect(planWorkspaceUsageRecovery({ ...input, usage: undefined })).toBeUndefined();
    expect(
      planWorkspaceUsageRecovery({ ...input, usage: undefined, error: "HTTP 429; Retry-After: 30" })
        ?.resumeAt,
    ).toBe("2026-10-22T00:00:31.000Z");
    expect(planWorkspaceUsageRecovery(input)?.resumeAt).toBe("2026-10-22T00:01:01.000Z");
  });
  it("bounds recovery and does not retry the same reset fingerprint again", () => {
    const first = planWorkspaceUsageRecovery(input)!;
    expect(planWorkspaceUsageRecovery({ ...input, previous: first })).toBeUndefined();
    expect(
      planWorkspaceUsageRecovery({
        ...input,
        previous: { ...first, fingerprint: "different", count: 3 },
      }),
    ).toBeUndefined();
    expect(planWorkspaceUsageRecovery({ ...input, attempts: 10 })).toBeUndefined();
    expect(
      planWorkspaceUsageRecovery({
        ...input,
        usage: undefined,
        error: "HTTP 429; Retry-After: 999999999",
      }),
    ).toBeUndefined();
  });
  it("keeps a waiting node out of free slots until its recorded deadline", () => {
    const graph = buildInitialWorkspaceTaskGraph("task");
    const recovery = planWorkspaceUsageRecovery(input)!;
    const waiting = {
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, usageRecovery: recovery })),
    };
    const options = { width: 2, isolateWorktrees: false, inFlight: new Set<string>() };
    expect(dispatchableWorkspaceTaskNodes(waiting, { ...options, nowMs })).toHaveLength(0);
    expect(
      dispatchableWorkspaceTaskNodes(waiting, { ...options, nowMs: nowMs + 61000 }),
    ).toHaveLength(1);
  });
});
