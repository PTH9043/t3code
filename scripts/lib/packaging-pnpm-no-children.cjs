// Preload only in pinned pnpm children. A frozen, script-free install and the
// collector's read-only queries need no external commands. In particular pnpm
// can otherwise shell out to PowerShell while diagnosing a Windows link error.
const cp = require("node:child_process");
function deny(command) {
  throw new Error(`Windows packaging pnpm cannot launch a child process (${command})`);
}
for (const method of [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]) {
  cp[method] = deny;
}
require("node:module").syncBuiltinESMExports();
