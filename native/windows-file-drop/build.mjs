import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone native compiler launcher has no Effect runtime.
if (NodeOS.platform() !== "win32") {
  if (!args.includes("--optional")) throw new Error("The Windows file-drop DLL requires Windows.");
} else {
  const archAt = args.indexOf("--architecture");
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone native compiler launcher has no Effect runtime.
  const architecture = archAt >= 0 ? args[archAt + 1] : NodeOS.arch();
  if (architecture !== "x64" && architecture !== "arm64")
    throw new Error("Unsupported file-drop architecture.");
  const outputAt = args.indexOf("--output-directory");
  const output = NodePath.resolve(
    outputAt >= 0 ? args[outputAt + 1] : NodePath.join(here, "target", architecture),
  );
  const binary = NodePath.join(output, "t3-file-drop.dll");
  const source = NodePath.join(here, "file-drop.cpp");
  const machine = architecture === "arm64" ? 0xaa64 : 0x8664;
  const matchesArchitecture = () => {
    if (!NodeFS.existsSync(binary)) return false;
    const bytes = NodeFS.readFileSync(binary);
    if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) return false;
    const pe = bytes.readUInt32LE(0x3c);
    return (
      pe + 6 <= bytes.length &&
      bytes.readUInt32LE(pe) === 0x4550 &&
      bytes.readUInt16LE(pe + 4) === machine
    );
  };
  const modified = Math.max(
    NodeFS.statSync(source).mtimeMs,
    NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
  );
  if (!matchesArchitecture() || NodeFS.statSync(binary).mtimeMs < modified) {
    const run = (command, arguments_, options = {}) => {
      const result = NodeChildProcess.spawnSync(command, arguments_, {
        windowsHide: true,
        shell: false,
        ...options,
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `${command} exited ${result.status}: ${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`,
        );
      return result.stdout;
    };
    const vswhere = NodePath.join(
      process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
      "Microsoft Visual Studio/Installer/vswhere.exe",
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
    if (!installation)
      throw new Error("Visual Studio C++ build tools are required for Windows file drops.");
    const vcvars = NodePath.join(installation, "VC/Auxiliary/Build/vcvarsall.bat");
    const target = architecture === "arm64" ? "amd64_arm64" : "amd64";
    const environment = run(
      process.env.ComSpec ?? "cmd.exe",
      ["/u", "/d", "/s", "/c", `"call "${vcvars}" ${target} >nul && set"`],
      { windowsVerbatimArguments: true },
    );
    const compilerEnv = { ...process.env };
    for (const line of environment.toString("utf16le").split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator);
      for (const existing of Object.keys(compilerEnv))
        if (existing.toLowerCase() === key.toLowerCase()) delete compilerEnv[existing];
      compilerEnv[key] = line.slice(separator + 1);
    }
    NodeFS.mkdirSync(output, { recursive: true });
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
        "/LD",
        source,
        `/Fo${NodePath.join(output, "file-drop.obj")}`,
        `/Fe${binary}`,
        "/link",
        "/INCREMENTAL:NO",
        "user32.lib",
        "shell32.lib",
        "comctl32.lib",
      ],
      { env: compilerEnv, cwd: output, stdio: "inherit" },
    );
    if (!matchesArchitecture()) throw new Error("Windows file-drop DLL architecture mismatch.");
  }
  console.log(binary);
}
