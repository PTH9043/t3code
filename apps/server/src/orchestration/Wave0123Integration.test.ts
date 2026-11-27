// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  evaluateMandateAction,
  isPathWithinAllowedPrefixes,
  type DelegateMandate,
} from "@t3tools/contracts";
import {
  evaluateModelComplianceWarning,
  LLAMA_MODCHIP_SAFE_SAMPLING,
  recommendLlamaModchipProfile,
} from "@t3tools/shared/llamaModchipPreset";
import * as Effect from "effect/Effect";

import {
  AdapterCircuitBreaker,
  readLastKnownGoodConfig,
  resolveLastKnownGoodPath,
  saveLastKnownGoodConfig,
} from "../configRecoveryGuard.ts";
import {
  makeSemanticSearch,
  SEMANTIC_QUERY_EMBED_TIMEOUT_MS,
} from "../documents/semanticSearch.ts";
import {
  buildObscuraServeCommand,
  probeObscuraBinary,
  validateObscuraTargetUrl,
} from "../mcp/ObscuraBrowserBridge.ts";
import {
  BILLION_CONTEXT_ATTRIBUTION,
  buildBillionContextProviderEnv,
  resolveBillionContextBaseUrl,
} from "../provider/BillionContextBridge.ts";
import { activeWorkRegistry } from "./ActiveWorkTracker.ts";

describe("Wave 0-3 integration guards and bridges", () => {
  it("enforces DelegateMandate path prefixes and destructive command blocks", () => {
    const mandate: DelegateMandate = {
      allowedPaths: ["apps/server/src/mcp", "packages/contracts/src"],
      allowNetwork: false,
      allowDestructiveGit: false,
      maxBudgetTokens: 16_000,
    };

    assert.isTrue(
      isPathWithinAllowedPrefixes(
        "apps/server/src/mcp/toolkits/workspaceDelegate.ts",
        mandate.allowedPaths,
      ),
    );
    assert.isFalse(isPathWithinAllowedPrefixes("apps/web/src/App.tsx", mandate.allowedPaths));

    const allowedWrite = evaluateMandateAction({
      mandate,
      targetPath: "packages/contracts/src/workspaceDelegate.ts",
    });
    assert.isTrue(allowedWrite.allowed);

    const blockedWrite = evaluateMandateAction({
      mandate,
      targetPath: "E:/NewAutoUsage/userdata/state.sqlite",
    });
    assert.isFalse(blockedWrite.allowed);

    const blockedForcePush = evaluateMandateAction({
      mandate,
      shellCommand: "git push origin main --force",
    });
    assert.isFalse(blockedForcePush.allowed);

    const blockedRm = evaluateMandateAction({
      mandate,
      shellCommand: "rm -rf /important",
    });
    assert.isFalse(blockedRm.allowed);
  });

  it("saves and restores Last-Known-Good config and isolates degraded adapters", () => {
    const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lkg-test-"));
    try {
      const settingsPath = NodePath.join(tmpDir, "settings.json");
      const validJson = JSON.stringify({ enableLegacyTokenStreaming: false });

      const first = saveLastKnownGoodConfig(settingsPath, validJson);
      assert.isTrue(first.written);
      assert.strictEqual(first.backupPath, resolveLastKnownGoodPath(settingsPath));

      // Identical content should be a no-op write (dedup by sha256).
      const second = saveLastKnownGoodConfig(settingsPath, validJson);
      assert.isFalse(second.written);
      assert.strictEqual(second.sha256, first.sha256);

      // Corrupt primary file; LKG backup remains intact and readable.
      NodeFS.writeFileSync(settingsPath, "{corrupt json", "utf8");
      const recovered = readLastKnownGoodConfig(settingsPath);
      assert.strictEqual(recovered, validJson);
    } finally {
      NodeFS.rmSync(tmpDir, { recursive: true, force: true });
    }

    const breaker = new AdapterCircuitBreaker();
    breaker.recordSuccess("codex_main");
    breaker.recordFailure("broken_plugin", new Error("connection refused"));
    assert.strictEqual(breaker.getState("codex_main")?.status, "healthy");
    assert.strictEqual(breaker.getState("broken_plugin")?.status, "degraded");
    assert.strictEqual(breaker.getState("broken_plugin")?.failureCount, 1);
    assert.lengthOf(breaker.listDegraded(), 1);
  });

  it("mirrors active work registry atomically to disk and clears cleanly", () => {
    const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-active-work-"));
    try {
      activeWorkRegistry.configureStateDir(tmpDir);
      activeWorkRegistry.clearAll();
      activeWorkRegistry.register({
        kind: "delegation",
        id: "del-1",
        threadId: "thread-1",
        summary: "worker test",
        startedAtMs: Date.now() - 5_000,
      });
      const filePath = NodePath.join(tmpDir, "active-work.json");
      const disk = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as {
        totalActive: number;
        activeDelegations: number;
        pid: number;
      };
      assert.strictEqual(disk.totalActive, 1);
      assert.strictEqual(disk.activeDelegations, 1);
      assert.strictEqual(disk.pid, process.pid);

      activeWorkRegistry.unregister("delegation", "del-1");
      const cleared = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as { totalActive: number };
      assert.strictEqual(cleared.totalActive, 0);
    } finally {
      activeWorkRegistry.clearAll();
      NodeFS.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.effect("falls back cleanly within 400ms cap when query embedding stalls", () =>
    Effect.gen(function* () {
      assert.strictEqual(SEMANTIC_QUERY_EMBED_TIMEOUT_MS, 400);
      const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sem-timeout-"));
      try {
        const engine = makeSemanticSearch({
          now: () => Date.now(),
          embed: ({ purpose, texts, signal }) => {
            if (purpose === "index") {
              return Promise.resolve(texts.map(() => [0.5, 0.5, 0.5]));
            }
            // Simulate a 4-second bge-m3 stall on query embedding.
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve([[0.5, 0.5, 0.5]]), 4_000);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            });
          },
        });
        const scope = {
          stateDir: tmpDir,
          projectId: "proj-timeout",
          endpoint: "http://127.0.0.1:11434",
          model: "nomic-embed-text-v2-moe",
        };
        const controller = new AbortController();
        yield* Effect.tryPromise(() =>
          engine.index({
            ...scope,
            candidates: [{ id: "doc-1", title: "Spec", content: "exact content" }],
            signal: controller.signal,
          }),
        );

        const started = Date.now();
        const result = yield* Effect.tryPromise(() =>
          engine({
            ...scope,
            query: "slow embedding test",
            candidates: [{ id: "doc-1", title: "Spec", content: "exact content" }],
            queryEmbedTimeoutMs: 60,
            signal: controller.signal,
          }),
        );
        const elapsed = Date.now() - started;
        assert.isFalse(result.interrupted);
        assert.lengthOf(result.ranked, 0);
        assert.isBelow(elapsed, 1_500);
      } finally {
        NodeFS.rmSync(tmpDir, { recursive: true, force: true });
      }
    }),
  );

  it("enforces loopback-only Obscura & BillionContext bridges and Gemini ACP direct bypass", () => {
    const probe = probeObscuraBinary({ env: { PATH: "" } });
    assert.isFalse(probe.available);
    assert.strictEqual(probe.cdpEndpoint, "ws://127.0.0.1:9222");

    const cmd = buildObscuraServeCommand({ binaryPath: "/opt/obscura", port: 9222 });
    assert.isTrue(cmd.args.includes("127.0.0.1"));
    assert.isTrue(validateObscuraTargetUrl("https://example.com").allowed);
    assert.isFalse(validateObscuraTargetUrl("http://169.254.169.254/latest/meta-data/").allowed);
    assert.isFalse(validateObscuraTargetUrl("file:///C:/Windows/System32").allowed);

    assert.strictEqual(resolveBillionContextBaseUrl(18787), "http://127.0.0.1:18787");
    assert.include(BILLION_CONTEXT_ATTRIBUTION.licenseNote, "MIT");

    const cfg = { enabled: true, port: 18787 };
    const codexPatch = buildBillionContextProviderEnv({ provider: "codex", config: cfg });
    assert.strictEqual(
      codexPatch?.env.OPENAI_BASE_URL,
      "http://127.0.0.1:18787/bili/https://api.openai.com/v1",
    );
    assert.isTrue(codexPatch?.suppressNativeCompaction);

    const claudePatch = buildBillionContextProviderEnv({ provider: "claudeAgent", config: cfg });
    assert.strictEqual(
      claudePatch?.env.ANTHROPIC_BASE_URL,
      "http://127.0.0.1:18787/bili/https://api.anthropic.com",
    );
    assert.isTrue(claudePatch?.suppressNativeCompaction);

    const geminiPatch = buildBillionContextProviderEnv({ provider: "gemini", config: cfg });
    assert.isTrue(geminiPatch?.bypassForAcpProbe);
    assert.deepEqual(geminiPatch?.env, {});
  });

  it("recommends hardware-aware llama-modchip profiles and flags regional/ToS compliance warnings", () => {
    assert.strictEqual(LLAMA_MODCHIP_SAFE_SAMPLING.temperature, 0.6);
    assert.strictEqual(LLAMA_MODCHIP_SAFE_SAMPLING.top_p, 0.95);

    // Current local PC snapshot: 32GB total, 6.7GB available RAM -> insufficient warning
    const tightRec = recommendLlamaModchipProfile({
      totalRamGb: 32,
      availableRamGb: 6.7,
      logicalCores: 16,
      availableVramGb: 2.2,
    });
    assert.strictEqual(tightRec.tier, "insufficient");
    assert.strictEqual(tightRec.threads, 15);
    assert.include(tightRec.warning ?? "", "부족");

    // 32GB RAM with sufficient headroom
    const tier32 = recommendLlamaModchipProfile({
      totalRamGb: 32,
      availableRamGb: 22,
      logicalCores: 16,
    });
    assert.strictEqual(tier32.tier, "32gb");

    // 64GB+ machine
    const tier64 = recommendLlamaModchipProfile({
      totalRamGb: 64,
      availableRamGb: 48,
      logicalCores: 16,
    });
    assert.strictEqual(tier64.tier, "64gb");

    const minimaxWarn = evaluateModelComplianceWarning("PrunaAI/P-H3-Image");
    assert.strictEqual(minimaxWarn?.severity, "error");
    assert.strictEqual(minimaxWarn?.code, "license_region_excluded");
    assert.include(minimaxWarn?.message ?? "", "대한민국");

    const perchWarn = evaluateModelComplianceWarning("perch-qwen-3.8-max");
    assert.strictEqual(perchWarn?.severity, "warning");
    assert.strictEqual(perchWarn?.code, "cli_surface_only");

    const boxWarn = evaluateModelComplianceWarning("simular-box-cloud");
    assert.strictEqual(boxWarn?.severity, "warning");
    assert.strictEqual(boxWarn?.code, "ephemeral_sandbox_limit");
  });
});
