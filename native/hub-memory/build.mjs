import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const architectureIndex = args.indexOf("--architecture");
const outputIndex = args.indexOf("--output-directory");
const architecture = architectureIndex >= 0 ? args[architectureIndex + 1] : "x64";
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone compiler launcher has no Effect runtime.
if (NodeOS.platform() !== "win32" || !["x64", "arm64"].includes(architecture)) {
  throw new Error("Hub guard requires Windows and architecture x64 or arm64.");
}
const output = NodePath.resolve(
  outputIndex >= 0 ? args[outputIndex + 1] : NodePath.join(here, "target", architecture),
);
function run(command, arguments_, options = {}) {
  const result = NodeChildProcess.spawnSync(command, arguments_, {
    windowsHide: true,
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}: ${result.stderr?.toString("utf8") ?? ""}`);
  return result.stdout;
}
const vswhere = NodePath.join(
  process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
  "Microsoft Visual Studio",
  "Installer",
  "vswhere.exe",
);
const installation = run(
  vswhere,
  [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ],
  { encoding: "utf8" },
).trim();
if (!installation) throw new Error("Visual Studio C++ build tools are required.");
const vsdevcmd = NodePath.join(installation, "Common7", "Tools", "VsDevCmd.bat");
const vcvars = NodePath.join(installation, "Common7", "Tools", "vsdevcmd", "ext", "vcvars.bat");
const target = architecture === "arm64" ? "arm64" : "x64";
// Initialize the Windows SDK and compiler without VS's optional extensions:
// the vcpkg extension invokes PowerShell, which this environment forbids.
const environmentOutput = run(
  "cmd.exe",
  [
    "/u",
    "/d",
    "/s",
    "/c",
    `"call "${vsdevcmd}" -no_ext -host_arch=x64 -arch=${target} >nul && call "${vcvars}" >nul && set"`,
  ],
  {
    windowsVerbatimArguments: true,
    env: { ...process.env, VSCMD_SKIP_SENDTELEMETRY: "1", VSCMD_VCVARSALL_INIT: "1" },
  },
);
const compilerEnv = { ...process.env };
for (const line of environmentOutput.toString("utf16le").split(/\r?\n/)) {
  const separator = line.indexOf("=");
  if (separator > 0) {
    const key = line.slice(0, separator);
    for (const existing of Object.keys(compilerEnv)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete compilerEnv[existing];
    }
    compilerEnv[key] = line.slice(separator + 1);
  }
}
const vcvarsInclude = compilerEnv.__VSCMD_VCVARS_INCLUDE ?? "";
compilerEnv.INCLUDE = vcvarsInclude + (compilerEnv.INCLUDE ?? "");
compilerEnv.EXTERNAL_INCLUDE = vcvarsInclude + (compilerEnv.EXTERNAL_INCLUDE ?? "");
delete compilerEnv.__VSCMD_VCVARS_INCLUDE;
NodeFS.mkdirSync(output, { recursive: true });
const binary = NodePath.join(output, "t3-hub-guard.exe");
run(
  "cl.exe",
  [
    "/nologo",
    "/std:c++17",
    "/O2",
    "/W4",
    "/WX",
    "/EHsc",
    "/MT",
    "/utf-8",
    NodePath.join(here, "guard.cpp"),
    `/Fo${NodePath.join(output, "guard.obj")}`,
    `/Fe${binary}`,
    "/link",
    "/INCREMENTAL:NO",
  ],
  { env: compilerEnv, stdio: "inherit", cwd: output },
);
const bytes = NodeFS.readFileSync(binary);
const machine = bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4);
if (machine !== (architecture === "arm64" ? 0xaa64 : 0x8664))
  throw new Error("Hub guard target architecture mismatch.");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Execute the native smoke check only on the build host architecture.
if (NodeOS.arch() === architecture) run(binary, ["--version"], { stdio: "inherit" });
console.log(binary);
