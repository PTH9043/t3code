// Adapter for app-builder-lib 26.15.6, confined to the Windows packaging child.
// Keep the upstream pnpm graph/hoister and replace only process discovery and I/O.
if (require.main === module) require("./lib/windows-builder-process-guard.cjs").install();
const { spawn } = require("node:child_process");
const { open } = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");

function configureStageCollector(builderRequire, pnpmCli) {
  const lib = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
  const version = lib("./package.json").version;
  if (version !== "26.15.6")
    throw new Error(`Review the Windows dependency collector for app-builder-lib@${version}`);
  const collector = lib("./out/node-module-collector");
  const { NodeModulesCollector } = lib("./out/node-module-collector/nodeModulesCollector");
  const { stripSensitiveEnvVars } = lib("builder-util");

  // We created this single-importer workspace. Upstream discovery otherwise
  // executes a PATH-resolved "pnpm --workspace-root exec pwd" from the stage.
  collector.determinePackageManagerEnv = ({ projectDir }) => ({
    value: { pm: collector.PM.PNPM, workspaceRoot: projectDir },
  });
  NodeModulesCollector.prototype.streamCollectorCommandToFile = async function (
    command,
    args,
    cwd,
    file,
  ) {
    if (this.installOptions.manager !== collector.PM.PNPM)
      throw new Error(`Unexpected stage collector: ${command}`);
    const output = await open(file, "w");
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--require",
            path.join(__dirname, "lib/packaging-pnpm-no-children.cjs"),
            pnpmCli,
            ...args,
          ],
          {
            cwd,
            env: stripSensitiveEnvVars(process.env),
            shell: false,
            windowsHide: true,
            stdio: ["ignore", output.fd, "pipe"],
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr = (stderr + chunk).slice(-20000);
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`pnpm ${args.join(" ")} exited ${signal ?? code}: ${stderr}`));
        });
      });
    } finally {
      await output.close();
    }
  };
}

module.exports = { configureStageCollector };
if (require.main === module) {
  const desktop = createRequire(path.resolve(__dirname, "../apps/desktop/package.json"));
  const cli = desktop.resolve("electron-builder/cli.js");
  const [pnpmCli, ...builderArgs] = process.argv.slice(2);
  configureStageCollector(createRequire(cli), pnpmCli);
  process.argv = [process.execPath, cli, ...builderArgs];
  require(cli);
}
