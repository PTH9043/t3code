// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { validSkillPathPart, type GitHubSkillSource } from "./GitHubSkillSource.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** Read Git objects without checking out the repository or running its files. */
export async function downloadGitHubSkillViaGit(
  source: GitHubSkillSource,
  destination: string,
): Promise<string> {
  const parent = NodePath.resolve(NodePath.dirname(destination));
  await NodeFSP.mkdir(parent, { recursive: true });
  const temporary = await NodeFSP.mkdtemp(NodePath.join(parent, ".t3-git-skill-"));
  const repo = NodePath.join(temporary, "repo");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NodePath.join(temporary, "no-global-config"),
    GIT_ATTR_NOSYSTEM: "1",
  });
  const git = async (args: string[], limit = 8 * 1024 * 1024) => {
    const result = await execFile("git", args, {
      env,
      encoding: "buffer",
      timeout: 30_000,
      maxBuffer: limit,
      windowsHide: true,
    });
    return result.stdout;
  };
  try {
    await git(["init", "--quiet", repo]);
    await git([
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      `https://github.com/${source.owner}/${source.repo}.git`,
    ]);
    await git([
      "-C",
      repo,
      "-c",
      "protocol.file.allow=never",
      "fetch",
      "--quiet",
      "--no-tags",
      "--filter=blob:none",
      "--depth=1",
      "origin",
      source.ref,
    ]);
    const revision = (await git(["-C", repo, "rev-parse", "FETCH_HEAD^{commit}"]))
      .toString("utf8")
      .trim();
    if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("GitHub 리비전을 확인하지 못했습니다.");
    const rawTree = await git([
      "-C",
      repo,
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      revision,
      "--",
      source.directory,
    ]);
    const records = new TextDecoder("utf-8", { fatal: true })
      .decode(rawTree)
      .split("\0")
      .filter(Boolean);
    if (records.length > 256) throw new Error("스킬 파일 수가 제한을 넘었습니다.");
    const prefix = `${source.directory}/`;
    const entries = records.map((record) => {
      const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(record);
      if (!match || !match[4]!.startsWith(prefix))
        throw new Error("스킬 파일 경로를 확인하지 못했습니다.");
      return {
        mode: match[1]!,
        type: match[2]!,
        sha: match[3]!,
        relative: match[4]!.slice(prefix.length),
      };
    });
    if (!entries.some((entry) => entry.relative === "SKILL.md"))
      throw new Error("선택한 폴더에 SKILL.md가 없습니다.");
    const names = new Set<string>();
    let total = 0;
    const files: Array<{ relative: string; mode: string; data: Buffer }> = [];
    for (const entry of entries) {
      if (
        entry.type !== "blob" ||
        !["100644", "100755"].includes(entry.mode) ||
        entry.relative
          .split("/")
          .some((part) => !validSkillPathPart(part) || part.toLowerCase() === ".git")
      )
        throw new Error("지원하지 않는 스킬 파일이나 경로가 있습니다.");
      const folded = entry.relative.toLowerCase();
      if (names.has(folded)) throw new Error("대소문자가 다른 중복 파일이 있습니다.");
      names.add(folded);
      const size = Number(
        (await git(["-C", repo, "cat-file", "-s", entry.sha])).toString("utf8").trim(),
      );
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MAX_FILE_BYTES ||
        (total += size) > MAX_TOTAL_BYTES
      )
        throw new Error("스킬 자료가 크기 제한을 넘었습니다.");
      const data = await git(["-C", repo, "cat-file", "blob", entry.sha], MAX_FILE_BYTES + 1024);
      if (
        data.length !== size ||
        NodeCrypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex") !==
          entry.sha
      )
        throw new Error("스킬 파일의 리비전 확인에 실패했습니다.");
      files.push({ relative: entry.relative, mode: entry.mode, data });
    }
    await NodeFSP.mkdir(destination, { recursive: true });
    for (const file of files) {
      const target = NodePath.join(destination, ...file.relative.split("/"));
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, file.data, { mode: file.mode === "100755" ? 0o755 : 0o644 });
    }
    return revision;
  } finally {
    if (
      NodePath.dirname(NodePath.resolve(temporary)) === parent &&
      NodePath.basename(temporary).startsWith(".t3-git-skill-")
    )
      await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}
