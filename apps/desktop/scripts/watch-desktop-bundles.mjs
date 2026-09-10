import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function fileStamp(path) {
  try {
    const stat = NodeFS.statSync(path);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** Watch only runnable bundles, surviving output directories replaced by clean builds. */
export function watchDesktopBundles({ files, onChange, platform, intervalMs = 1_000 }) {
  const stamps = new Map(files.map((file) => [file, fileStamp(file)]));
  let changed = false;
  const scan = () => {
    let ready = true;
    for (const file of files) {
      const stamp = fileStamp(file);
      if (stamp !== stamps.get(file)) {
        stamps.set(file, stamp);
        changed = true;
      }
      if (stamp === null) ready = false;
    }
    if (ready && changed) {
      changed = false;
      onChange();
    }
  };

  const watchers = [];
  // A replaced Windows build directory can emit an unbounded rename storm
  // from its old fs.watch handle. Poll the three files instead; filtering
  // unwanted callbacks still leaves that native watcher consuming a CPU core.
  if (platform !== "win32") {
    const directories = new Map();
    for (const file of files) {
      const directory = NodePath.dirname(file);
      if (!directories.has(directory)) directories.set(directory, new Set());
      directories.get(directory).add(NodePath.basename(file));
    }
    for (const [directory, names] of directories) {
      try {
        const watcher = NodeFS.watch(directory, (_event, filename) => {
          if (typeof filename === "string" && names.has(filename)) scan();
        });
        // The polling path remains available if a directory disappears.
        watcher.on("error", () => watcher.close());
        watchers.push(watcher);
      } catch {
        // A clean build may briefly remove the directory before startup.
      }
    }
  }

  const timer = setInterval(scan, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const watcher of watchers) watcher.close();
  };
}
