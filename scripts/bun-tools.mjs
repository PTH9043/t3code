import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";

import { HostProcessPlatform } from "../packages/shared/src/hostProcess.ts";

export const BUN_VERSION = JSON.parse(
  NodeFS.readFileSync(new URL("./bun-release.json", import.meta.url), "utf8"),
).version;
const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const hostPlatform = Effect.runSync(HostProcessPlatform);
export const bunExecutable = NodePath.join(
  root,
  ".t3",
  "tools",
  "bun",
  BUN_VERSION,
  hostPlatform === "win32" ? "bun.exe" : "bun",
);

export function bunArguments(command, targets) {
  if (command === "version") return ["--version"];
  if (targets.length === 0 || targets.some((target) => !target || target.startsWith("-"))) {
    throw new Error(
      "검사할 파일 또는 프로젝트 경로를 명시하세요. 전체 저장소 검사는 자동으로 실행하지 않습니다.",
    );
  }
  if (command === "fmt" || command === "fmt-check") {
    return ["fmt", "--no-script", ...(command === "fmt-check" ? ["--check"] : []), ...targets];
  }
  if (command === "check" && targets.length === 1) {
    return ["check", "--no-script", "--noEmit", "--threads=2", "--project", targets[0]];
  }
  throw new Error(
    "사용법: bun-tools.mjs version | setup | fmt <파일...> | fmt-check <파일...> | check <프로젝트>",
  );
}

export function run(argv) {
  const [command, ...rawTargets] = argv;
  const targets = rawTargets[0] === "--" ? rawTargets.slice(1) : rawTargets;
  if (command === "setup") {
    const result = NodeChildProcess.spawnSync(
      "python",
      [NodePath.join(root, "scripts/setup-bun.py")],
      {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
        shell: false,
      },
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  const args = bunArguments(command, targets);
  if (!NodeFS.existsSync(bunExecutable)) {
    throw new Error(
      "프로젝트 Bun이 없습니다. node scripts/bun-tools.mjs setup 을 먼저 실행하세요.",
    );
  }
  const version = NodeChildProcess.spawnSync(bunExecutable, ["--version"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (version.error) throw version.error;
  if (version.status !== 0 || version.stdout.trim() !== BUN_VERSION) {
    throw new Error(`Bun ${BUN_VERSION} 실행 파일이 필요합니다.`);
  }
  const result = NodeChildProcess.spawnSync(bunExecutable, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
