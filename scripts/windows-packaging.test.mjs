import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { readMsvcEnvironment } from "../native/msvc-environment.mjs";
import {
  resolvePackagingPnpm,
  WINDOWS_STAGE_INSTALL_ARGS,
  windowsCargoTargetDir,
  windowsPackagingBuildSteps,
} from "./packaging/windows-packaging.ts";
import { createWindowsStageLock } from "./packaging/windows-stage-lock.ts";

const repo = path.resolve(import.meta.dirname, "..");
const pin = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).packageManager;

test("pnpm selection checks the manifest before executing a cached CLI", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pnpm-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, ".vite-plus/package_manager/pnpm/0.0.0/pnpm");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const cli = path.join(root, "bin/pnpm.cjs");
  fs.writeFileSync(cli, 'throw Error("cache lookup must not execute a CLI probe")');
  for (const version of ["1.0.0", "0.0.0"]) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pnpm", version }));
    if (version === "0.0.0") assert.equal(resolvePackagingPnpm(dir, "pnpm@0.0.0"), cli);
    else assert.throws(() => resolvePackagingPnpm(dir, "pnpm@0.0.0"), /Missing pnpm@0.0.0/);
  }
  assert.throws(() => resolvePackagingPnpm(dir, "pnpm@latest"), /exact pnpm/);
});

test("stage preserves locked peer and patch resolutions, including promoted native binaries", () => {
  const lock = parse(fs.readFileSync(path.join(repo, "pnpm-lock.yaml"), "utf8"));
  const server = lock.importers["apps/server"].dependencies;
  const desktop = lock.importers["apps/desktop"].dependencies;
  const binary = "@ff-labs/fff-bin-win32-arm64";
  const fffVersion =
    lock.snapshots[`@ff-labs/fff-node@${server["@ff-labs/fff-node"].version}`].optionalDependencies[
      binary
    ];
  const stage = {
    dependencies: {
      "@opencode-ai/sdk": server["@opencode-ai/sdk"].specifier,
      "node-pty": server["node-pty"].specifier,
      "electron-updater": desktop["electron-updater"].specifier,
      [binary]: fffVersion,
    },
    devDependencies: { electron: desktop.electron.specifier },
  };
  const result = createWindowsStageLock(lock, stage, {
    "node-pty@1.1.0": "patches/node-pty@1.1.0.patch",
  });
  const importer = result.importers["."];
  for (const name of ["@opencode-ai/sdk", "node-pty", "electron-updater"]) {
    assert.deepEqual(importer.dependencies[name], desktop[name] ?? server[name]);
  }
  assert.equal(importer.dependencies[binary].version, fffVersion);
  assert.deepEqual(importer.devDependencies.electron, desktop.electron);
  assert.deepEqual(result.patchedDependencies, {
    "node-pty@1.1.0": lock.patchedDependencies["node-pty@1.1.0"],
  });
  assert.equal(result.snapshots, lock.snapshots);
  assert.equal(result.packages, lock.packages);
  assert.throws(
    () => createWindowsStageLock(lock, { ...stage, dependencies: { "node-pty": "^9" } }, {}),
    /No matching locked snapshot/,
  );
});

test("build tools resolve inside the checkout and Cargo builds into the chosen stage target", () => {
  const steps = windowsPackagingBuildSteps(repo);
  for (const step of steps) assert.ok(fs.existsSync(path.resolve(step.cwd, step.args[0])));
  assert.deepEqual(
    steps.map((step) => path.basename(step.args[0])),
    ["cli.js", "cli.ts", "build-preview-annotation-css.mjs", "pack-bin.js"],
  );
  const stage = path.join(os.tmpdir(), "stage");
  assert.equal(windowsCargoTargetDir(repo, stage, undefined), path.join(stage, "cargo-target"));
  assert.equal(windowsCargoTargetDir(repo, stage, "custom"), path.join(repo, "custom"));
  assert.equal(windowsCargoTargetDir(repo, stage, stage), stage);
});

test("both native builds use the SDK and compiler without optional VS extensions", () => {
  const env = readMsvcEnvironment("C:/Program Files/VS", "arm64", (cmd, args, options) => {
    assert.equal(cmd, "cmd.exe");
    assert.match(args.at(-1), /VsDevCmd\.bat" -no_ext -host_arch=x64 -arch=arm64/);
    assert.match(args.at(-1), /&& call ".*vcvars\.bat"/);
    assert.equal(options.env.VSCMD_SKIP_SENDTELEMETRY, "1");
    return Buffer.from("INCLUDE=sdk\r\n__VSCMD_VCVARS_INCLUDE=vc;\r\n", "utf16le");
  });
  assert.equal(env.INCLUDE, "vc;sdk");
});

test(
  "frozen script-free install and real builder collector use only the pinned Node CLI",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3 stage & 한글-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pnpm = resolvePackagingPnpm(repo, pin);
    const guard = path.join(repo, "scripts/lib/packaging-pnpm-no-children.cjs");
    const writeJson = (file, data) => fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
    writeJson("package.json", {
      name: "fixture",
      version: "1.0.0",
      packageManager: pin,
      dependencies: { sample: "file:sample" },
      scripts: { preinstall: "exit 1" },
    });
    fs.mkdirSync(path.join(dir, "sample"));
    writeJson("sample/package.json", { name: "sample", version: "1.0.0" });
    fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages: []\n");
    function runPnpm(args) {
      const result = cp.spawnSync(process.execPath, ["--require", guard, pnpm, ...args], {
        cwd: dir,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
    }
    runPnpm([
      "install",
      "--offline",
      "--lockfile-only",
      "--ignore-scripts",
      "--no-frozen-lockfile",
    ]);
    assert.deepEqual(WINDOWS_STAGE_INSTALL_ARGS, [
      "install",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
    runPnpm([...WINDOWS_STAGE_INSTALL_ARGS, "--offline"]);

    // Reject a regression before it could execute a shell or a PATH shim.
    const calls = [];
    const spawn = cp.spawn;
    t.mock.method(cp, "spawn", (exe, args, options) => {
      assert.equal(exe, process.execPath);
      assert.deepEqual(args.slice(0, 3), ["--require", guard, pnpm]);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.cwd, dir);
      calls.push(args.slice(3));
      return spawn(exe, args, options);
    });
    const desktopRequire = createRequire(path.join(repo, "apps/desktop/package.json"));
    const builderRequire = createRequire(desktopRequire.resolve("electron-builder/cli.js"));
    const require = createRequire(import.meta.url);
    require("./windows-electron-builder.cjs").configureStageCollector(builderRequire, pnpm);
    const lib = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
    const api = lib("./out/node-module-collector");
    const pm = await api.determinePackageManagerEnv({ projectDir: dir, appDir: dir }).value;
    assert.equal(await pm.workspaceRoot, dir);
    assert.deepEqual(calls, []);
    let index = 0;
    const collector = api.getCollectorByPackageManager(pm.pm, dir, {
      getTempFile: async () => path.join(dir, `output-${++index}.txt`),
    });
    const result = await collector.getNodeModules({ packageName: "fixture" });
    assert.ok(result.nodeModules.some((pkg) => pkg.name === "sample"));
    assert.deepEqual(
      (await collector.asyncExec("pnpm.cmd", ["--version"])).stdout,
      pin.slice("pnpm@".length),
    );
    assert.ok((await collector.asyncExec("pnpm.cmd", ["config", "list"])).stdout);
    assert.ok(calls.some((args) => args[0] === "list" && args.includes("--prod")));
  },
);
