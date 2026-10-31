import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";

const args = process.argv.slice(2);
const homeIndex = args.indexOf("--home-dir");
const home = args[homeIndex + 1];
if (homeIndex < 0 || !home || !isAbsolute(home)) {
  throw new Error("Pass an absolute T3 home with --home-dir.");
}
const directory = join(resolve(home), "tools", "mcp");
await mkdir(directory, { recursive: true });
const existing = await readFile(join(directory, "package.json"), "utf8").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (existing && JSON.parse(existing).name !== "t3-managed-mcp-tools")
  throw new Error("The target belongs to another tool installation.");
await writeFile(
  join(directory, "package.json"),
  JSON.stringify(
    {
      name: "t3-managed-mcp-tools",
      private: true,
      version: "1.0.0",
      dependencies: {
        "@modelcontextprotocol/server-filesystem": "2026.8.31",
        "@modelcontextprotocol/server-sequential-thinking": "2026.8.31",
        "@upstash/context7-mcp": "4.1.1",
      },
    },
    null,
    2,
  ) + "\n",
);
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const child = spawn(
  process.execPath,
  [npmCli, "install", "--no-audit", "--no-fund", "--ignore-scripts"],
  {
    cwd: directory,
    stdio: "inherit",
    windowsHide: true,
  },
);
await new Promise((res, rej) => {
  child.once("error", rej);
  child.once("exit", (code) => (code === 0 ? res() : rej(new Error(`MCP install exited ${code}`))));
});
console.log(`Installed pinned MCP tools in ${directory}`);
