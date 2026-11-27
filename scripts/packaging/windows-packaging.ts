// @effect-diagnostics-next-line nodeBuiltinImport:off - Inspect the pinned CLI on disk before starting the build.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Resolve native build tools relative to the checkout.
import * as NodePath from "node:path";

export const WINDOWS_STAGE_INSTALL_ARGS = [
  "install",
  "--prod",
  "--frozen-lockfile",
  "--ignore-scripts",
] as const;

export function resolvePackagingPnpm(repoRoot: string, packageManager: string) {
  const version = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(packageManager)?.[1];
  if (!version) throw new Error(`Expected an exact pnpm packageManager, got ${packageManager}`);
  const cachePath = ["package_manager", "pnpm", version, "pnpm"];
  const roots = [
    NodePath.join(repoRoot, ".vite-plus", ...cachePath),
    NodePath.join(
      process.env.VITE_PLUS_HOME || NodePath.join(NodeOS.homedir(), ".vite-plus"),
      ...cachePath,
    ),
    NodePath.join(
      process.env.COREPACK_HOME ||
        NodePath.join(process.env.LOCALAPPDATA || NodeOS.homedir(), "node/corepack"),
      "v1/pnpm",
      version,
    ),
  ];
  for (const root of roots) {
    const cli = NodePath.join(root, "bin/pnpm.cjs");
    if (!NodeFS.existsSync(cli)) continue;
    const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"));
    if (manifest.name === "pnpm" && manifest.version === version) return cli;
  }
  throw new Error(`Missing ${packageManager} (bin/pnpm.cjs). Checked: ${roots.join(", ")}`);
}

export function windowsPackagingBuildSteps(repoRoot: string) {
  const web = NodePath.join(repoRoot, "apps/web");
  const server = NodePath.join(repoRoot, "apps/server");
  const desktop = NodePath.join(repoRoot, "apps/desktop");
  const webRequire = NodeModule.createRequire(NodePath.join(web, "package.json"));
  // These are the same Vite build and pack entries used by the pinned Vite+ CLI.
  // The file-drop DLL is built for the requested architecture directly into the stage.
  return [
    {
      cwd: web,
      args: [NodePath.join(NodePath.dirname(webRequire.resolve("vite")), "cli.js"), "build"],
    },
    { cwd: server, args: ["scripts/cli.ts", "build"] },
    { cwd: desktop, args: ["scripts/build-preview-annotation-css.mjs"] },
    { cwd: desktop, args: [NodePath.join(repoRoot, "node_modules/vite-plus/dist/pack-bin.js")] },
  ];
}

export function windowsCargoTargetDir(
  repoRoot: string,
  stageRoot: string,
  configured: string | undefined,
) {
  return configured
    ? NodePath.resolve(repoRoot, configured)
    : NodePath.join(stageRoot, "cargo-target");
}
