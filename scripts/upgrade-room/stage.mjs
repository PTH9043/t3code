// Runs only at explicit installation, from the integrated checkout.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { createWindowsStageLock } from "../packaging/windows-stage-lock.ts";
import {
  resolvePackagingPnpm,
  WINDOWS_STAGE_INSTALL_ARGS,
} from "../packaging/windows-packaging.ts";
import { resolveCatalogDependencies } from "../lib/resolve-catalog.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const stage = process.cwd();
const read = (name) => fs.readFileSync(path.join(repo, name), "utf8");
const write = (name, content) => fs.writeFileSync(path.join(stage, name), content, { flag: "wx" });
const pkg = JSON.parse(read("apps/server/package.json"));
const workspace = parse(read("pnpm-workspace.yaml"));
const lock = parse(read("pnpm-lock.yaml"));
const packageManager = JSON.parse(read("package.json")).packageManager;
if (pkg.name !== "t3" || pkg.bin?.t3 !== "./dist/bin.mjs")
  throw new Error("Unexpected server package");

const dependencies = resolveCatalogDependencies(pkg.dependencies, workspace.catalog, pkg.name);
const overrides = resolveCatalogDependencies(workspace.overrides, workspace.catalog, pkg.name);
const patches = {};
for (const [id, filename] of Object.entries(workspace.patchedDependencies)) {
  if (!Object.hasOwn(dependencies, id.slice(0, id.lastIndexOf("@")))) continue;
  if (!/^patches\/[\w@%.+-]+\.patch$/.test(filename)) throw new Error("Invalid patch path");
  fs.mkdirSync(path.join(stage, "patches"), { recursive: true });
  fs.copyFileSync(
    path.join(repo, filename),
    path.join(stage, filename),
    fs.constants.COPYFILE_EXCL,
  );
  patches[id] = filename;
}
const manifest = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: pkg.type,
  bin: pkg.bin,
  packageManager,
  dependencies,
  devDependencies: {},
};
write("package.json", JSON.stringify(manifest));
write("pnpm-lock.yaml", stringify(createWindowsStageLock(lock, manifest, patches)));
write(
  "pnpm-workspace.yaml",
  stringify({
    packages: ["."],
    patchedDependencies: patches,
    overrides,
    nodeLinker: "hoisted",
    packageImportMethod: "copy",
    symlink: false,
    ignorePnpmfile: true,
  }),
);
const pnpm = resolvePackagingPnpm(repo, packageManager);
execFileSync(
  process.execPath,
  [
    "--require",
    path.join(repo, "scripts/lib/packaging-pnpm-no-children.cjs"),
    pnpm,
    ...WINDOWS_STAGE_INSTALL_ARGS,
  ],
  { cwd: stage, stdio: "ignore", windowsHide: true },
);
