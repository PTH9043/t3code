import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { preflightWindowsSigning } from "./packaging/windows-signing.ts";

const repo = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

test(
  "official --signed command rejects missing credentials before any build child",
  { skip: process.platform !== "win32" },
  () => {
    const env = {
      ...process.env,
      AZURE_TENANT_ID: "",
      AZURE_CLIENT_ID: "",
      AZURE_CLIENT_SECRET: "",
    };
    const result = cp.spawnSync(
      process.execPath,
      [
        "--require",
        "./scripts/lib/packaging-pnpm-no-children.cjs",
        "scripts/build-desktop-artifact.ts",
        "--platform",
        "win",
        "--target",
        "nsis",
        "--arch",
        "x64",
        "--signed",
      ],
      { cwd: repo, env, encoding: "utf8", windowsHide: true, shell: false },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Windows signing requires AZURE_TENANT_ID/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /cannot launch a child process|Building desktop\/server/,
    );
  },
);

test("signed preflight validates local prerequisites without executing a process", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3 signing & "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pe = Buffer.alloc(256);
  pe.write("MZ");
  pe.writeUInt32LE(80, 60);
  pe.write("PE", 80);
  pe.writeUInt16LE(0x8664, 84);
  pe.write("dlib\0dmdf\0", 128, "utf16le");
  const env = {
    AZURE_TENANT_ID: "tenant",
    AZURE_CLIENT_ID: "client",
    AZURE_CLIENT_SECRET: "test-secret",
    AZURE_TRUSTED_SIGNING_ENDPOINT: "https://unused.invalid/",
    AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "Publisher",
    AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "account",
    AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "profile",
    SIGNTOOL_PATH: path.join(dir, "signtool.exe"),
    AZURE_TRUSTED_SIGNING_DLIB: path.join(dir, "Azure.CodeSigning.Dlib.dll"),
    DOTNET_ROOT_X64: dir,
  };
  assert.throws(() => preflightWindowsSigning(env, "linux"), /Windows build host/);
  assert.throws(
    () => preflightWindowsSigning({ ...env, AZURE_CLIENT_SECRET: "" }, "win32"),
    /AZURE_CLIENT_SECRET/,
  );
  assert.throws(() => preflightWindowsSigning(env, "win32"), /SIGNTOOL_PATH/);
  fs.writeFileSync(env.SIGNTOOL_PATH, pe);
  assert.throws(() => preflightWindowsSigning(env, "win32"), /AZURE_TRUSTED_SIGNING_DLIB/);
  pe.writeUInt16LE(0x14c, 84);
  fs.writeFileSync(env.AZURE_TRUSTED_SIGNING_DLIB, pe);
  assert.throws(() => preflightWindowsSigning(env, "win32"), /x64 Azure Dlib/);
  pe.writeUInt16LE(0x8664, 84);
  fs.writeFileSync(env.AZURE_TRUSTED_SIGNING_DLIB, pe);
  assert.throws(() => preflightWindowsSigning(env, "win32"), /Incomplete Azure Dlib/);
  for (const file of ["Azure.CodeSigning.Dlib.Core.dll", "Ijwhost.dll"])
    fs.writeFileSync(path.join(dir, file), pe);
  fs.writeFileSync(
    path.join(dir, "Azure.CodeSigning.Dlib.runtimeconfig.json"),
    JSON.stringify({
      runtimeOptions: { framework: { name: "Microsoft.NETCore.App", version: "10.0.0" } },
    }),
  );
  assert.throws(() => preflightWindowsSigning(env, "win32"), /\.NET 10\.0/);
  const runtime = path.join(dir, "shared/Microsoft.NETCore.App/10.0.1");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "coreclr.dll"), pe);
  const plan = preflightWindowsSigning(env, "win32");
  assert.equal(plan.metadata.CertificateProfileName, "profile");
  assert.ok(plan.metadata.ExcludeCredentials.includes("AzurePowerShellCredential"));
  assert.ok(!JSON.stringify(plan).includes("test-secret"));
});

test("electron-builder invokes the native hook and propagates signing and verification failures", async (t) => {
  const desktop = createRequire(path.join(repo, "apps/desktop/package.json"));
  const builder = createRequire(desktop.resolve("electron-builder/cli.js"));
  const lib = createRequire(builder.resolve("app-builder-lib/package.json"));
  const { WindowsSignToolManager } = lib("./out/codeSign/windowsSignToolManager");
  const signtoolOptions = {
    sign: path.join(repo, "scripts/packaging/windows-signing.ts"),
    publisherName: "Publisher",
    signingHashAlgorithms: ["sha256"],
  };
  const manager = new WindowsSignToolManager({
    platformSpecificBuildOptions: { signtoolOptions },
    appInfo: { computePackageUrl: async () => null },
    info: { getWorkspaceRoot: async () => repo },
    getCscLink: () => null,
    get vm() {
      throw new Error("Certificate-store enumeration attempted");
    },
  });
  const plan = {
    tool: "fake signtool.exe",
    dlib: "plugin & provider.dll",
    metadataFile: "stage & data.json",
    timestamp: "https://unused.invalid/",
    fileDigest: "SHA256",
    timestampDigest: "SHA256",
  };
  const key = "T3CODE_NATIVE_WINDOWS_SIGNING";
  const saved = process.env[key];
  t.after(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });
  process.env[key] = JSON.stringify(plan);
  let failAt;
  const calls = [];
  const fake = t.mock.method(cp, "execFileSync", (exe, args, options) => {
    assert.equal(exe, plan.tool);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    calls.push(args);
    if (args[0] === failAt) throw new Error(`fake ${failAt} failure`);
  });
  syncBuiltinESMExports();
  t.after(() => {
    fake.mock.restore();
    syncBuiltinESMExports();
  });
  const file = "App setup & 한글.exe";
  const invoke = () => manager.signFile({ path: file, options: { signtoolOptions } });
  assert.equal(await invoke(), true);
  assert.deepEqual(calls, [
    [
      "sign",
      "/fd",
      "SHA256",
      "/tr",
      plan.timestamp,
      "/td",
      "SHA256",
      "/dlib",
      plan.dlib,
      "/dmdf",
      plan.metadataFile,
      file,
    ],
    ["verify", "/pa", "/all", "/tw", file],
  ]);
  for (const op of ["sign", "verify"]) {
    failAt = op;
    await assert.rejects(invoke(), new RegExp(`fake ${op} failure`));
  }
});

test("Windows builder rejects process launches before reaching Node's real spawn functions", (t) => {
  const backend = () => {
    throw new Error("fake backend");
  };
  // Keep every execution path inert even if the guard regresses.
  const mocks = ["spawnSync", "execSync", "execFileSync"].map((k) => t.mock.method(cp, k, backend));
  mocks.push(t.mock.method(cp.ChildProcess.prototype, "spawn", backend));
  t.after(() => {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  });
  require("./lib/windows-builder-process-guard.cjs").install();
  const forbidden = /PowerShell launch blocked/;
  assert.throws(
    () => cp.spawn("C:/Windows/System32/WindowsPowerShell/v1.0/PowerShell.EXE", []),
    forbidden,
  );
  assert.throws(() => cp.execFile("pwsh", []), forbidden);
  assert.throws(() => cp.spawnSync("cmd.exe", ["/c", "powershell -NoProfile"]), forbidden);
  assert.throws(() => cp.execFileSync("pwsh.exe", []), forbidden);
  assert.throws(() => cp.execSync("placeholder", { shell: "C:/Tools/pwsh.exe" }), forbidden);
  assert.throws(
    () => cp.spawnSync("signtool.exe", ["verify", "/pa", "Example.exe"]),
    /fake backend/,
  );
});

test("Windows release build selects Bash, native workspace tools and checked signing inputs", () => {
  const job = parse(fs.readFileSync(path.join(repo, ".github/workflows/release.yml"), "utf8")).jobs
    .build;
  for (const step of job.steps) {
    if (step.run) assert.equal(step.shell ?? job.defaults.run.shell, "bash", step.name);
    if (step.uses?.includes("setup-vp") || step.uses?.includes("rust-toolchain"))
      assert.equal(step.if, "matrix.platform != 'win'");
  }
  const pack = job.steps.find((s) => s.name === "Build desktop artifact").run;
  assert.match(pack, /Incomplete Azure signing configuration/);
  assert.match(pack, /export AZURE_TRUSTED_SIGNING_DLIB=/);
  assert.match(pack, /args\+=\(--signed\)/);
});
