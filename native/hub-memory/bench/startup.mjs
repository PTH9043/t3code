import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const run = promisify(execFile);
const binary = resolve(import.meta.dirname, "../target", process.arch, "t3-hub-guard.exe");
const legacy = readFileSync(join(import.meta.dirname, "legacy-guard.ps1"), "utf8");
const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const samples = { cpp: [], powershell: [] };
for (let trial = 0; trial < 11; trial++) {
  for (const backend of trial % 2 ? ["cpp", "powershell"] : ["powershell", "cpp"]) {
    const started = performance.now();
    await run(
      backend === "cpp" ? binary : powershell,
      backend === "cpp"
        ? []
        : [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(legacy, "utf16le").toString("base64"),
          ],
      {
        windowsHide: true,
        timeout: 10000,
        env: {
          ...process.env,
          T3_HUB_GUARDED_COMMAND: "exit /b 0",
          T3_HUB_MEMORY_HARD_CAP_MB: "256",
        },
      },
    );
    if (trial) samples[backend].push(performance.now() - started);
  }
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[4] + sorted[5]) / 2;
};
const result = {
  at: new Date().toISOString(),
  samples,
  medianMs: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, median(v)])),
  binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  command: "exit /b 0",
  capMiB: 256,
  node: process.version,
};
writeFileSync(
  resolve(import.meta.dirname, "../target/startup-benchmark.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
