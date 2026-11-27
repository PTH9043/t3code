// @effect-diagnostics nodeBuiltinImport:off - The installed Windows launcher owns the independent room.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const tools = "E:\\NewAutoUsage\\tools\\upgrade-room";
const run = NodeUtil.promisify(NodeChildProcess.execFile);

async function installedFile(file: string) {
  const stat = await NodeFSP.lstat(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    NodePath.win32.relative(file, await NodeFSP.realpath(file)) !== ""
  ) {
    throw new Error("Unexpected upgrade room installation.");
  }
  return file;
}

export async function linkInstalledRoom(): Promise<unknown> {
  const manifest = JSON.parse(
    await NodeFSP.readFile(await installedFile(NodePath.win32.join(tools, "install.json")), "utf8"),
  );
  if (
    manifest.version !== 2 ||
    typeof manifest.python !== "string" ||
    !/^[a-z]:[\\/]/i.test(manifest.python) ||
    NodePath.win32.basename(manifest.python).toLowerCase() !== "python.exe"
  ) {
    throw new Error("Invalid upgrade room installation.");
  }
  const launcher = await installedFile(NodePath.win32.join(tools, "upgrade-room-runtime.py"));
  // link ensures the shortcut's independently brokered server without opening a window.
  const { stdout } = await run(
    await installedFile(manifest.python),
    ["-I", "-B", launcher, "link"],
    {
      cwd: tools,
      windowsHide: true,
      shell: false,
      timeout: 150_000,
      maxBuffer: 32_768,
    },
  );
  return JSON.parse(stdout);
}

export function parseRoomLink(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (
    data.ok !== true ||
    data.status !== "ready" ||
    typeof data.pid !== "number" ||
    !Number.isSafeInteger(data.pid) ||
    data.pid < 1 ||
    data.projectId !== "autousage-upgrade-project" ||
    data.threadId !== "autousage-upgrade-room" ||
    typeof data.environmentId !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(data.environmentId) ||
    typeof data.url !== "string"
  )
    return null;
  const url = URL.parse(data.url);
  if (
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.origin !== data.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== "/open-room.html" ||
    !/^#token=[A-Za-z0-9_-]+$/.test(url.hash)
  )
    return null;
  return { url, canonical: url.origin + "/" + data.environmentId + "/" + data.threadId };
}
