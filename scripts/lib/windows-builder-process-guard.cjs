const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const { win32: path } = require("node:path");

const shellName = /^(?:cmd|bash|sh)(?:\.exe)?$/i;
const forbidden = /^(?:powershell(?:_ise)?|pwsh)(?:\.exe|\.cmd|\.bat)?$|\.ps1$/i;
const shellToken = /(?:^|[\s"'&|()\\/;])(?:powershell(?:_ise)?|pwsh)(?:\.exe)?(?=$|[\s"'&|();])/i;

function check(file, args, shell) {
  const name = path.basename(String(file).trim().replace(/^"|"$/g, ""));
  if (
    forbidden.test(name) ||
    (typeof shell === "string" && forbidden.test(path.basename(shell))) ||
    ((shell || shellName.test(name)) && shellToken.test([file, ...args].join(" ")))
  ) {
    throw new Error("PowerShell launch blocked in the Windows electron-builder child");
  }
}

function install() {
  // All asynchronous public APIs (including fork, exec and promisified execFile)
  // converge here with Node's actual executable and normalized shell arguments.
  const spawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (options) {
    check(options.file, options.args ?? [], false);
    return spawn.call(this, options);
  };
  // The synchronous APIs use private references to spawnSync inside Node.
  for (const method of ["spawnSync", "execFileSync", "execSync"]) {
    const original = cp[method];
    cp[method] = function (file, args, options) {
      const opts = Array.isArray(args) || args == null ? options : args;
      const shell = opts?.shell || (method === "execSync" && (process.env.ComSpec || "cmd.exe"));
      check(
        file,
        Array.isArray(args) ? args : [],
        shell === true ? process.env.ComSpec || "cmd.exe" : shell,
      );
      return original.apply(this, arguments);
    };
  }
  syncBuiltinESMExports();
}

module.exports = { install };
