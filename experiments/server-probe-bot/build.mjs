import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = import.meta.dirname;
const variant = process.env.BOT_VARIANT ?? "complete";
const version = process.env.BOT_VERSION ?? "0.1.0";
if (!["complete", "incomplete", "wrong-result", "broken-build"].includes(variant)) {
  throw new Error("Unknown bot variant");
}
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid bot version");
const output = NodePath.join(root, "build");
NodeFS.mkdirSync(output, { recursive: true });
for (const filename of ["job.mjs", "bot.mjs", "supervisor.mjs", "healthcheck.mjs", "probe.mjs"]) {
  NodeChildProcess.execFileSync(process.execPath, ["--check", NodePath.join(root, filename)], {
    stdio: "inherit",
    windowsHide: true,
  });
  NodeFS.copyFileSync(NodePath.join(root, filename), NodePath.join(output, filename));
}
if (variant === "broken-build") {
  const invalidModule = NodePath.join(output, "unfinished.mjs");
  NodeFS.writeFileSync(invalidModule, "export const unfinished = ;\n");
  NodeChildProcess.execFileSync(process.execPath, ["--check", invalidModule], {
    stdio: "inherit",
    windowsHide: true,
  });
}
NodeFS.writeFileSync(
  NodePath.join(output, "build.json"),
  `${JSON.stringify({ name: "server-probe-bot", version, variant, contract: 1, mode: "simulation" })}\n`,
);
console.log(JSON.stringify({ type: "build.completed", version, variant }));
