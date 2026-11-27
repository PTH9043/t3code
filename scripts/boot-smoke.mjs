#!/usr/bin/env node
/**
 * Isolated pre-flight boot smoke test for the bundled T3 server (`apps/server/dist/bin.mjs`).
 *
 * Spawns the built bundle against an isolated temporary `--base-dir` on an ephemeral
 * loopback port, verifies:
 *   1. Process starts cleanly without Effect Layer / `Service not found` errors.
 *   2. `/.well-known/t3/environment` returns HTTP 200 with valid JSON.
 *   3. `/` returns HTTP 200 (and serves the built `index-*.js` when `dist/client` exists).
 *   4. Clean shutdown of only the spawned PID and full removal of the temporary directory.
 *
 * Usage:
 *   node scripts/boot-smoke.mjs [--timeout-ms 25000] [--entry apps/server/dist/bin.mjs]
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  let timeoutMs = 25_000;
  let entryPath = path.join(repoRoot, "apps", "server", "dist", "bin.mjs");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--timeout-ms" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed >= 3_000 && parsed <= 120_000) {
        timeoutMs = parsed;
      }
      i += 1;
    } else if (arg === "--entry" && argv[i + 1]) {
      entryPath = path.resolve(repoRoot, argv[i + 1]);
      i += 1;
    }
  }
  return { timeoutMs, entryPath };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to allocate ephemeral port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

function httpGet(url, reqTimeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: reqTimeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`HTTP timeout after ${reqTimeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await sleep(150);
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Ignore if already exited.
  }
  await sleep(300);
}

async function main() {
  const startedAt = Date.now();
  const { timeoutMs, entryPath } = parseArgs(process.argv.slice(2));
  const result = {
    ok: false,
    entryPath,
    port: null,
    elapsedMs: 0,
    envStatus: null,
    rootStatus: null,
    builtIndexJs: null,
    rootHasBuiltJs: null,
    nativeMemoryCore: { loaded: false, capabilities: null },
    fatalOutputLines: [],
    error: null,
  };

  // Optional pre-flight check for bundled Rust `t3_memory_core.node`
  const nativeAddonPath = path.join(
    path.dirname(entryPath),
    "native",
    "t3-memory-core",
    `${process.platform}-${process.arch}`,
    "t3_memory_core.node",
  );
  if (fs.existsSync(nativeAddonPath)) {
    try {
      const req = createRequire(import.meta.url);
      const addon = req(nativeAddonPath);
      result.nativeMemoryCore = {
        loaded: typeof addon.runtimeCapabilities === "function",
        capabilities:
          typeof addon.runtimeCapabilities === "function" ? addon.runtimeCapabilities() : null,
      };
    } catch (err) {
      result.nativeMemoryCore = {
        loaded: false,
        capabilities: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!fs.existsSync(entryPath)) {
    result.error = `Server bundle not found: ${entryPath}`;
    result.elapsedMs = Date.now() - startedAt;
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }

  const clientIndexPath = path.join(path.dirname(entryPath), "client", "index.html");
  if (fs.existsSync(clientIndexPath)) {
    const html = fs.readFileSync(clientIndexPath, "utf8");
    const match = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
    result.builtIndexJs = match ? match[1] : null;
  }

  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-boot-smoke-"));
  let child = null;
  const stdoutLines = [];
  const stderrLines = [];

  try {
    const port = await getFreePort();
    result.port = port;

    const env = {
      ...process.env,
      T3CODE_HOME: smokeDir,
      T3CODE_NO_BROWSER: "1",
      T3CODE_TELEMETRY_ENABLED: "false",
    };

    child = spawn(
      process.execPath,
      [entryPath, "serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", smokeDir],
      {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const recordLines = (buf, target) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        target.push(trimmed);
        if (target.length > 100) target.shift();
        if (
          /Service not found:|Unhandled|ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|TypeError:/i.test(
            trimmed,
          )
        ) {
          result.fatalOutputLines.push(trimmed.slice(0, 300));
        }
      }
    };

    child.stdout?.on("data", (chunk) => recordLines(chunk, stdoutLines));
    child.stderr?.on("data", (chunk) => recordLines(chunk, stderrLines));

    const deadline = Date.now() + timeoutMs;
    let lastProbeErr = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        result.error = `Server exited early with code ${child.exitCode}`;
        break;
      }
      try {
        const envResp = await httpGet(`http://127.0.0.1:${port}/.well-known/t3/environment`, 2_000);
        result.envStatus = envResp.status;
        if (envResp.status === 200) {
          JSON.parse(envResp.body);
          const rootResp = await httpGet(`http://127.0.0.1:${port}/`, 2_000);
          result.rootStatus = rootResp.status;
          if (result.builtIndexJs) {
            result.rootHasBuiltJs = rootResp.body.includes(result.builtIndexJs);
          }
          const rootOk =
            rootResp.status === 200 &&
            (result.builtIndexJs === null || result.rootHasBuiltJs === true);
          if (rootOk && result.fatalOutputLines.length === 0) {
            result.ok = true;
            break;
          }
          if (!rootOk) {
            result.error = `Root check failed: status=${rootResp.status}, hasBuiltJs=${result.rootHasBuiltJs}`;
            break;
          }
          if (result.fatalOutputLines.length > 0) {
            result.error = "Fatal error lines observed during boot";
            break;
          }
        }
      } catch (err) {
        lastProbeErr = err instanceof Error ? err.message : String(err);
      }
      await sleep(300);
    }

    if (!result.ok && !result.error) {
      result.error = `Boot smoke timed out after ${timeoutMs}ms (lastProbeErr=${lastProbeErr ?? "none"})`;
    }
  } finally {
    await stopChild(child);
    try {
      fs.rmSync(smokeDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    } catch {
      // Best-effort cleanup on Windows file locks.
    }
  }

  result.elapsedMs = Date.now() - startedAt;
  if (!result.ok) {
    result.stdoutTail = stdoutLines.slice(-15);
    result.stderrTail = stderrLines.slice(-15);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

await main();
