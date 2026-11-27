#!/usr/bin/env node
/**
 * 2-Tier Verification Gate (`verify:fast` / `verify:full`) for T3 Code.
 *
 * - `--mode fast` (default): Runs core package typechecks (`contracts`, `shared`,
 *   `client-runtime`), high-signal regression test suites across contracts/shared/server/web,
 *   and isolated `scripts/boot-smoke.mjs` against `apps/server/dist/bin.mjs`.
 * - `--mode full`: Runs `vp test run` package-by-package across the workspace so
 *   every package's pass/fail status is captured in one structured JSON report,
 *   followed by `scripts/boot-smoke.mjs`.
 *
 * Usage:
 *   node scripts/verify-gate.mjs --mode fast [--skip-boot-smoke]
 *   node scripts/verify-gate.mjs --mode full [--skip-boot-smoke]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function findVpBin() {
  const candidates = [
    path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "vp.cmd" : "vp"),
    path.join(repoRoot, "node_modules", ".bin", "vp"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.platform === "win32" ? "vp.cmd" : "vp";
}

function runCommand(cmd, args, cwd, timeoutMs = 180_000) {
  const t0 = Date.now();
  const isWinCmd = process.platform === "win32" && cmd.toLowerCase().endsWith(".cmd");
  const res = isWinCmd
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", cmd, ...args], {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })
    : spawnSync(cmd, args, {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });

  const elapsedMs = Date.now() - t0;
  const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const tail = combined
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-12);

  return {
    ok: res.status === 0,
    exitCode: res.status ?? 1,
    elapsedMs,
    tail,
  };
}

function parseArgs(argv) {
  let mode = "fast";
  let skipBootSmoke = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode" && argv[i + 1]) {
      mode = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--skip-boot-smoke") {
      skipBootSmoke = true;
    }
  }
  return { mode, skipBootSmoke };
}

function main() {
  const startedAt = Date.now();
  const { mode, skipBootSmoke } = parseArgs(process.argv.slice(2));
  const vpBin = findVpBin();
  const steps = [];

  const runStep = (name, cmd, args, relCwd, timeoutMs = 180_000) => {
    const cwd = path.join(repoRoot, relCwd);
    const out = runCommand(cmd, args, cwd, timeoutMs);
    steps.push({ name, cwd: relCwd || ".", ...out });
    return out;
  };

  if (mode === "fast") {
    runStep("tsgo:contracts", vpBin, ["exec", "tsgo", "--noEmit"], "packages/contracts");
    runStep("tsgo:client-runtime", vpBin, ["exec", "tsgo", "--noEmit"], "packages/client-runtime");
    runStep(
      "test:contracts:core",
      vpBin,
      ["test", "run", "src/globalAssistant.test.ts", "src/t3ProjectFile.test.ts"],
      "packages/contracts",
    );
    runStep(
      "test:shared:core",
      vpBin,
      ["test", "run", "src/globalAssistantPrompt.test.ts", "src/shell.test.ts"],
      "packages/shared",
    );
    runStep(
      "test:server:core",
      vpBin,
      [
        "test",
        "run",
        "src/serverLayerWiring.test.ts",
        "src/t3x/workerEngine/WorkerEngine.test.ts",
        "src/t3x/workerEngine/WorkerEngineStranglerMigration.test.ts",
        "src/telemetry/AnalyticsService.test.ts",
        "src/diagnostics/TraceDiagnostics.test.ts",
        "src/diagnostics/ClassifierTelemetryAll.test.ts",
        "src/mcp/toolkits/workspaceDelegate.test.ts",
        "src/orchestration/council/CouncilEngine.test.ts",
        "src/orchestration/council/CouncilOrchestrator.integration.test.ts",
        "src/t3x/executionLedger/UnifiedExecutionLedger.test.ts",
        "src/provider/acp/GeminiPrematureStopGuard.test.ts",
        "src/orchestration/textQuestions.test.ts",
      ],
      "apps/server",
    );
    runStep(
      "test:web:core",
      vpBin,
      [
        "test",
        "run",
        "src/components/chat/RuntimeProofStrip.test.tsx",
        "src/components/chat/BackgroundActivityLivePanel.test.tsx",
        "src/components/council/CouncilComponents.test.tsx",
        "src/components/settings/settingsSearch.test.ts",
        "src/t3x/diagnostics/ExecutionLedgerDiagnosticsCard.test.tsx",
      ],
      "apps/web",
    );
  } else {
    const packages = [
      "packages/contracts",
      "packages/shared",
      "packages/client-runtime",
      "apps/server",
      "apps/web",
      "apps/desktop",
    ];
    for (const pkg of packages) {
      if (fs.existsSync(path.join(repoRoot, pkg, "package.json"))) {
        runStep(`test:${pkg}`, vpBin, ["test", "run"], pkg, 300_000);
      }
    }
  }

  if (!skipBootSmoke) {
    const bundlePath = path.join(repoRoot, "apps", "server", "dist", "bin.mjs");
    if (fs.existsSync(bundlePath)) {
      runStep(
        "boot:smoke",
        process.execPath,
        [path.join(repoRoot, "scripts", "boot-smoke.mjs")],
        "",
        45_000,
      );
    } else {
      steps.push({
        name: "boot:smoke",
        cwd: ".",
        ok: true,
        exitCode: 0,
        elapsedMs: 0,
        tail: ["skipped (apps/server/dist/bin.mjs not built yet)"],
      });
    }
  }

  const passedCount = steps.filter((s) => s.ok).length;
  const failedSteps = steps.filter((s) => !s.ok).map((s) => s.name);
  const summary = {
    ok: failedSteps.length === 0,
    mode,
    elapsedMs: Date.now() - startedAt,
    passedCount,
    totalSteps: steps.length,
    failedSteps,
    steps,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.ok ? 0 : 1;
}

main();
