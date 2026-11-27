// @effect-diagnostics-next-line nodeBuiltinImport:off - The electron-builder hook must run the native SignTool directly.
import * as cp from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Signing preflight inspects local executables before launching any process.
import * as fs from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Resolve native SDK and Dlib paths for the signing host.
import * as path from "node:path";

function required(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Windows signing requires ${key}`);
  return value;
}

function directories(root: string) {
  return fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
}

function nativeTool(file: string | undefined, name: string, setting: string) {
  if (
    !file ||
    !path.isAbsolute(file) ||
    path.basename(file).toLowerCase() !== name.toLowerCase() ||
    !fs.statSync(file, { throwIfNoEntry: false })?.isFile()
  ) {
    throw new Error(`Windows signing requires ${setting} to point to an installed ${name}`);
  }
  const bytes = fs.readFileSync(file);
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0;
  if (
    bytes[0] !== 0x4d ||
    bytes[1] !== 0x5a ||
    pe + 6 > bytes.length ||
    bytes.readUInt32LE(pe) !== 0x4550
  ) {
    throw new Error(`Invalid Windows executable: ${file}`);
  }
  return { path: file, machine: bytes.readUInt16LE(pe + 4), bytes };
}

export function preflightWindowsSigning(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform !== "win32") throw new Error("Azure SignTool signing requires a Windows build host");
  for (const key of ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"])
    required(env, key);
  const publisherName = required(env, "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME");
  const metadata = {
    Endpoint: required(env, "AZURE_TRUSTED_SIGNING_ENDPOINT"),
    CodeSigningAccountName: required(env, "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
    CertificateProfileName: required(env, "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
    // EnvironmentCredential is the workflow's service principal. In particular
    // the native Dlib must never fall through to AzurePowerShellCredential.
    ExcludeCredentials: [
      "ManagedIdentityCredential",
      "WorkloadIdentityCredential",
      "SharedTokenCacheCredential",
      "VisualStudioCredential",
      "VisualStudioCodeCredential",
      "AzureCliCredential",
      "AzurePowerShellCredential",
      "AzureDeveloperCliCredential",
      "InteractiveBrowserCredential",
    ],
  };
  const x86Root = env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
  const sdk = path.join(x86Root, "Windows Kits/10/bin");
  const defaultTool = () =>
    directories(sdk)
      .filter((v) => /^10\.0\.\d+\.\d+$/.test(v))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
      .map((v) => path.join(sdk, v, "x64/signtool.exe"))
      .find((file) => fs.existsSync(file));
  const tool = nativeTool(env.SIGNTOOL_PATH || defaultTool(), "signtool.exe", "SIGNTOOL_PATH");
  // /dlib and /dmdf are documented in the native tool's Unicode argument table.
  if (
    !["/dlib", "/dmdf"].every((flag) =>
      tool.bytes.includes(Buffer.from(flag.slice(1) + "\0", "utf16le")),
    )
  ) {
    throw new Error("Windows SDK SignTool with /dlib and /dmdf support is required");
  }
  const arch = tool.machine === 0x8664 ? "x64" : tool.machine === 0x14c ? "x86" : undefined;
  if (!arch) throw new Error("Azure Dlib requires an x64 or x86 SignTool");
  const dllName = "Azure.CodeSigning.Dlib.dll";
  const dll = nativeTool(
    env.AZURE_TRUSTED_SIGNING_DLIB ||
      path.join(x86Root, "Microsoft/ArtifactSigningClientTools/bin", dllName),
    dllName,
    "AZURE_TRUSTED_SIGNING_DLIB",
  );
  if (tool.machine !== dll.machine) throw new Error(`SignTool requires the ${arch} Azure Dlib`);
  const dir = path.dirname(dll.path);
  for (const file of [
    "Azure.CodeSigning.Dlib.Core.dll",
    "Ijwhost.dll",
    "Azure.CodeSigning.Dlib.runtimeconfig.json",
  ]) {
    if (!fs.statSync(path.join(dir, file), { throwIfNoEntry: false })?.isFile())
      throw new Error(`Incomplete Azure Dlib installation: missing ${file}`);
  }
  const { framework, rollForward } = JSON.parse(
    fs
      .readFileSync(path.join(dir, "Azure.CodeSigning.Dlib.runtimeconfig.json"), "utf8")
      .replace(/^\uFEFF/, ""),
  ).runtimeOptions;
  if (framework?.name !== "Microsoft.NETCore.App" || !/^\d+\.\d+\.\d+$/.test(framework.version))
    throw new Error("Unsupported .NET framework in Azure Dlib runtimeconfig.json");
  const dotnet =
    env[`DOTNET_ROOT_${arch.toUpperCase()}`] ||
    env.DOTNET_ROOT ||
    path.join(
      arch === "x64" ? env.ProgramW6432 || env.ProgramFiles || "C:/Program Files" : x86Root,
      "dotnet",
    );
  const shared = path.join(dotnet, "shared/Microsoft.NETCore.App");
  const [major = 0, minor = 0, patch = 0] = String(framework.version).split(".").map(Number);
  if (
    !directories(shared).some((v) => {
      if (!/^\d+\.\d+\.\d+$/.test(v)) return false;
      const [a = 0, b = 0, c = 0] = v.split(".").map(Number);
      const allowMajor = rollForward === "Major" || rollForward === "LatestMajor";
      const allowMinor = allowMajor || ["Minor", "LatestMinor"].includes(rollForward ?? "Minor");
      const compatible =
        (a === major && b === minor && (rollForward === "Disable" ? c === patch : c >= patch)) ||
        (allowMinor && a === major && b > minor) ||
        (allowMajor && a > major);
      const runtime = path.join(shared, v, "coreclr.dll");
      return (
        compatible &&
        fs.existsSync(runtime) &&
        nativeTool(runtime, "coreclr.dll", "DOTNET_ROOT").machine === tool.machine
      );
    })
  )
    throw new Error(`Azure Dlib requires the ${arch} .NET ${major}.${minor} runtime in ${dotnet}`);
  const timestamp =
    env.AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161 || "http://timestamp.acs.microsoft.com";
  if (
    new URL(metadata.Endpoint).protocol !== "https:" ||
    !["https:", "http:"].includes(new URL(timestamp).protocol)
  )
    throw new Error("Azure signing requires an HTTPS endpoint and an HTTP(S) timestamp URL");
  return {
    metadata,
    publisherName,
    tool: tool.path,
    dlib: dll.path,
    timestamp,
    fileDigest: env.AZURE_TRUSTED_SIGNING_FILE_DIGEST || "SHA256",
    timestampDigest: env.AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST || "SHA256",
  };
}

type SigningCommand = Omit<
  ReturnType<typeof preflightWindowsSigning>,
  "metadata" | "publisherName"
> & { metadataFile: string };

// electron-builder's signtoolOptions.sign hook, called for each signable file.
export function sign({ path: file }: { path: string }) {
  const plan: SigningCommand = JSON.parse(required(process.env, "T3CODE_NATIVE_WINDOWS_SIGNING"));
  const options = { shell: false, windowsHide: true, stdio: "inherit" } as const;
  cp.execFileSync(
    plan.tool,
    [
      "sign",
      "/fd",
      plan.fileDigest,
      "/tr",
      plan.timestamp,
      "/td",
      plan.timestampDigest,
      "/dlib",
      plan.dlib,
      "/dmdf",
      plan.metadataFile,
      file,
    ],
    options,
  );
  verifyNativeSignature(file, plan.tool);
}

export function verifyNativeSignature(file: string, tool: string) {
  // /tw returns a warning for a missing timestamp. Any nonzero exit fails the build.
  cp.execFileSync(tool, ["verify", "/pa", "/all", "/tw", file], {
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  });
}
