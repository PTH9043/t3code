import * as NodeChildProcess from "node:child_process";

let lastProgress = performance.now();
let stopping = false;
let tripped = false;
const emit = (body) => console.log(JSON.stringify({ at: new Date().toISOString(), ...body }));
const child = NodeChildProcess.fork(new URL("./bot.mjs", import.meta.url), [], {
  execArgv: ["--max-old-space-size=80"],
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  windowsHide: true,
});
emit({ type: "supervisor.spawned", workerPid: child.pid });
let progressed = false;
child.on("message", (receipt) => {
  if (receipt?.type !== "job.completed") return;
  lastProgress = performance.now();
  progressed = true;
});
let escalation;
const stopChild = (reason) => {
  if (stopping) return;
  stopping = true;
  clearInterval(watch);
  emit({ type: "supervisor.stopping", reason, workerPid: child.pid });
  child.kill("SIGTERM");
  escalation = setTimeout(() => child.kill("SIGKILL"), 1_000);
};
const watch = setInterval(() => {
  if (performance.now() - lastProgress <= (progressed ? 5_000 : 9_000)) return;
  tripped = true;
  emit({ type: "supervisor.watchdog", reason: "worker_progress_stalled", workerPid: child.pid });
  stopChild("progress_stalled");
}, 500);
child.on("error", (error) => {
  emit({ type: "supervisor.spawn_failed", message: error.message });
  clearInterval(watch);
  process.exitCode = 71;
});
child.on("exit", (code, signal) => {
  clearInterval(watch);
  clearTimeout(escalation);
  emit({ type: "supervisor.worker_exit", code, signal, watchdog: tripped });
  process.exitCode = tripped ? 75 : stopping ? 0 : code === 0 ? 0 : (code ?? 71);
});
process.on("SIGTERM", () => stopChild("requested_stop"));
process.on("SIGINT", () => stopChild("requested_stop"));
