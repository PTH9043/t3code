// Standalone installer: no Effect runtime is present to provide host references.
// oxlint-disable t3code/no-global-process-runtime
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const version = "1.0.46";
const homeArgument = process.argv.indexOf("--home-dir");
const home = process.argv[homeArgument + 1];
if (homeArgument < 0 || !home || !NodePath.isAbsolute(home))
  throw new Error("An absolute --home-dir is required.");
const target = NodePath.join(NodePath.resolve(home), "tools", "grok", version);
const owner = "t3-managed-grok-cli";
const manifest = NodePath.join(target, "package.json");
if (
  NodeFS.existsSync(manifest) &&
  JSON.parse(await NodeFSP.readFile(manifest, "utf8")).name !== owner
)
  throw new Error("The destination belongs to another installation.");
await NodeFSP.mkdir(target, { recursive: true });
const platformPackage = `@xai-official/grok-${NodeOS.platform()}-${NodeOS.arch()}`;
await NodeFSP.writeFile(
  manifest,
  JSON.stringify(
    { name: owner, version: "1.0.0", private: true, dependencies: { [platformPackage]: version } },
    null,
    2,
  ),
);
const npmCli = NodePath.join(
  NodePath.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
await run(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: target,
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
});
const name = NodeOS.platform() === "win32" ? "grok.exe" : "grok";
const source = NodePath.join(target, "node_modules", platformPackage, "bin", name);
const bytes = NodeFS.existsSync(source)
  ? await NodeFSP.readFile(source)
  : NodeZlib.brotliDecompressSync(await NodeFSP.readFile(`${source}.br`));
const binary = NodePath.join(target, name);
await NodeFSP.writeFile(binary, bytes, { mode: 0o755 });
const result = await run(binary, ["--no-auto-update", "--version"], { windowsHide: true });
if (!result.stdout.startsWith(`grok ${version} `))
  throw new Error("The installed binary reported an unexpected version.");
const proof = {
  version,
  binary,
  platformPackage,
  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  reportedVersion: result.stdout.trim(),
};
await NodeFSP.writeFile(NodePath.join(target, "installation.json"), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof));
