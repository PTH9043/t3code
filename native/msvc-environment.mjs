import * as NodePath from "node:path";

export function readMsvcEnvironment(installation, architecture, run) {
  const vsdevcmd = NodePath.join(installation, "Common7", "Tools", "VsDevCmd.bat");
  const vcvars = NodePath.join(installation, "Common7", "Tools", "vsdevcmd", "ext", "vcvars.bat");
  if (!["x64", "arm64"].includes(architecture))
    throw new Error("Unsupported compiler architecture.");
  // Initialize the Windows SDK and compiler without VS's optional extensions:
  // the vcpkg extension invokes PowerShell, which this environment forbids.
  const environmentOutput = run(
    "cmd.exe",
    [
      "/u",
      "/d",
      "/s",
      "/c",
      `"call "${vsdevcmd}" -no_ext -host_arch=x64 -arch=${architecture} >nul && call "${vcvars}" >nul && set"`,
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
  return compilerEnv;
}
