#!/usr/bin/env node
/**
 * Builds the optional Rust `native/t3-memory-core` N-API addon (`t3_memory_core.node`),
 * stages it into both `native/t3-memory-core/` (dev) and `apps/server/dist/native/t3-memory-core/<platform>-<arch>/` (prod),
 * and runs a fast self-smoke test verifying `runtimeCapabilities()`.
 *
 * Never invokes PowerShell.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const manifestPath = path.join(__dirname, "Cargo.toml");

const args = new Set(process.argv.slice(2));
const optional = args.has("--optional");

const platformKey = `${process.platform}-${process.arch}`;
const builtArtifactName =
  process.platform === "win32"
    ? "t3_memory_core.dll"
    : process.platform === "darwin"
      ? "libt3_memory_core.dylib"
      : "libt3_memory_core.so";

const cargoRes = spawnSync("cargo", ["build", "--release", "--manifest-path", manifestPath], {
  cwd: repoRoot,
  stdio: "inherit",
  windowsHide: true,
});

if (cargoRes.error || cargoRes.status !== 0) {
  const msg = cargoRes.error
    ? `cargo not available (${cargoRes.error.message})`
    : `cargo build exited with code ${cargoRes.status}`;
  if (optional) {
    console.warn(
      `[t3-memory-core] Optional native build skipped: ${msg}. Server will fall back to pure JS.`,
    );
    process.exit(0);
  }
  console.error(`[t3-memory-core] Build failed: ${msg}`);
  process.exit(cargoRes.status ?? 1);
}

const builtPath = path.join(__dirname, "target", "release", builtArtifactName);
if (!fs.existsSync(builtPath)) {
  console.error(`[t3-memory-core] Expected output binary not found: ${builtPath}`);
  process.exit(1);
}

const devTarget = path.join(__dirname, "t3_memory_core.node");
const distTarget = path.join(
  repoRoot,
  "apps",
  "server",
  "dist",
  "native",
  "t3-memory-core",
  platformKey,
  "t3_memory_core.node",
);

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeCopyBinary(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) {
    try {
      if (sha256File(src) === sha256File(dst)) {
        return "unchanged";
      }
    } catch {
      // fall through to copy
    }
  }
  try {
    fs.copyFileSync(src, dst);
    return "copied";
  } catch (err) {
    if (err && (err.code === "EBUSY" || err.code === "EPERM") && fs.existsSync(dst)) {
      console.warn(
        `[t3-memory-core] Target locked by running process, keeping existing binary: ${dst}`,
      );
      return "locked-kept";
    }
    throw err;
  }
}

safeCopyBinary(builtPath, devTarget);
const distCopyStatus = safeCopyBinary(builtPath, distTarget);

// Self-smoke load check
const require = createRequire(import.meta.url);
const addon = require(distTarget);
const caps =
  typeof addon.runtimeCapabilities === "function" ? addon.runtimeCapabilities() : "unknown";
console.log(
  JSON.stringify({
    ok: true,
    platformKey,
    devTarget,
    distTarget,
    capabilities: caps,
  }),
);
