import { describe, expect, it } from "vite-plus/test";
import {
  applyMonorepoPathAliases,
  buildPromptCacheKey,
  clipInjectedContextToBudget,
  formatPipeTable,
  planContextAssembly,
} from "./contextAssemblyGate.ts";

describe("contextAssemblyGate", () => {
  it("excludes recent conversation and RAG bloat on handoff turns", () => {
    const plan = planContextAssembly({
      skipWorkspaceRetrieval: false,
      hasNativeHistory: false,
      needsHandoff: true,
      userInitiated: true,
      complexityProfile: "deep-architectural",
      hasHandoffPayload: true,
    });

    expect(plan.mode).toBe("handoff-minimal");
    expect(plan.excludeRecentConversation).toBe(true);
    expect(plan.includeRag).toBe(false);
    expect(plan.includeWorkingMemory).toBe(false);
    expect(plan.includeLongTermMemory).toBe(false);
    expect(plan.workspacePromptMaxChars).toBeLessThanOrEqual(3_000);
  });

  it("always excludes recent conversation on native continuation turns and uses MoC when routing graph is ready", () => {
    const standardCont = planContextAssembly({
      skipWorkspaceRetrieval: false,
      hasNativeHistory: true,
      needsHandoff: false,
      userInitiated: true,
      complexityProfile: "standard-dev",
      routingGraphReady: false,
    });
    expect(standardCont.mode).toBe("native-continuation");
    expect(standardCont.excludeRecentConversation).toBe(true);
    expect(standardCont.workspacePromptMaxChars).toBe(8_000);

    const graphCont = planContextAssembly({
      skipWorkspaceRetrieval: false,
      hasNativeHistory: true,
      needsHandoff: false,
      userInitiated: true,
      complexityProfile: "standard-dev",
      routingGraphReady: true,
    });
    expect(graphCont.mode).toBe("native-continuation-graph");
    expect(graphCont.includeRoutingMoc).toBe(true);
    expect(graphCont.includeRag).toBe(false);
    expect(graphCont.includeMemoryContext).toBe(false);
    expect(graphCont.workspacePromptMaxChars).toBeLessThanOrEqual(3_000);
  });

  it("preserves full rehydration on fresh non-handoff sessions", () => {
    const fresh = planContextAssembly({
      skipWorkspaceRetrieval: false,
      hasNativeHistory: false,
      needsHandoff: false,
      userInitiated: true,
      complexityProfile: "standard-dev",
      routingGraphReady: false,
    });
    expect(fresh.mode).toBe("fresh-session");
    expect(fresh.excludeRecentConversation).toBe(false);
    expect(fresh.includeMemoryContext).toBe(true);
  });

  it("clips oversized injected context cleanly without breaking short inputs", () => {
    const short = clipInjectedContextToBudget("hello", 100);
    expect(short.clipped).toBe(false);
    expect(short.text).toBe("hello");

    const big = clipInjectedContextToBudget("x".repeat(500), 120);
    expect(big.clipped).toBe(true);
    expect(big.text.length).toBeLessThanOrEqual(120);
    expect(big.text).toContain("workspace_memory");
  });

  it("applies monorepo @Alias path macros and compact pipe tables", () => {
    const sample = [
      "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
      "apps/server/src/orchestration/WorkspaceMemory.ts",
      "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    ].join("\n");
    const aliased = applyMonorepoPathAliases(sample);
    expect(aliased.header).toContain("@orch=apps/server/src/orchestration");
    expect(aliased.text).toContain("@orch/Layers/ProviderCommandReactor.ts");
    expect(aliased.text).toContain("@orch/WorkspaceMemory.ts");
    // Only 1 occurrence of @prov, so not aliased
    expect(aliased.header).not.toContain("@prov=");

    const table = formatPipeTable(
      ["path", "lines", "status"],
      [
        ["@orch/WorkspaceMemory.ts", "1-120", "UNCHANGED"],
        ["@prov/ClaudeAdapter.ts", "40-90", "MODIFIED"],
      ],
    );
    expect(table).toBe(
      "path | lines | status\n@orch/WorkspaceMemory.ts | 1-120 | UNCHANGED\n@prov/ClaudeAdapter.ts | 40-90 | MODIFIED",
    );
  });

  it("produces deterministic thread-scoped prompt cache keys", () => {
    const k1 = buildPromptCacheKey({
      projectId: "proj-1",
      threadId: "thr-1",
      driver: "codex",
      model: "gpt-6.2-sol",
    });
    const k2 = buildPromptCacheKey({
      projectId: "proj-1",
      threadId: "thr-1",
      driver: "codex",
      model: "gpt-6.2-sol",
    });
    const k3 = buildPromptCacheKey({
      projectId: "proj-1",
      threadId: "thr-2",
      driver: "codex",
      model: "gpt-6.2-sol",
    });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1.startsWith("t3_codex_")).toBe(true);
  });
});
