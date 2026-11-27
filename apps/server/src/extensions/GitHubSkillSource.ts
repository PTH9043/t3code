// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MAX_TREE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 256;

export interface GitHubSkillSource {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly directory: string;
}

export function validSkillPathPart(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/:*?"<>|]/u.test(value) &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32) &&
    !/[. ]$/u.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  );
}

export function parseGitHubSkillSource(source: string): GitHubSkillSource {
  const url = new URL(source);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("GitHub HTTPS 스킬 폴더 주소를 입력하세요.");
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new Error("GitHub 주소의 경로를 확인하세요.");
  }
  const [owner, repo, tree, ref, ...rest] = parts;
  if (
    !owner ||
    !repo ||
    tree !== "tree" ||
    !ref ||
    !rest.length ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(repo) ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(ref) ||
    ref.startsWith("-") ||
    ref.split("/").some((part) => part === "." || part === "..") ||
    rest.some((part) => !validSkillPathPart(part)) ||
    rest.includes(".git")
  )
    throw new Error("GitHub의 tree/브랜치/스킬폴더 주소를 입력하세요.");
  return { owner, repo, ref, directory: rest.join("/") };
}

class GitHubHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`GitHub 요청 실패 (${status})`);
    this.status = status;
  }
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new GitHubHttpError(response.status);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new Error("스킬 자료가 크기 제한을 넘었습니다.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("스킬 자료가 크기 제한을 넘었습니다.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };
async function downloadGitHubSkillApi(
  source: GitHubSkillSource,
  destination: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<string> {
  const api = `https://api.github.com/repos/${source.owner}/${source.repo}`;
  const get = (url: string) =>
    fetcher(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "T3-Code" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  const commitData: unknown = JSON.parse(
    Buffer.from(
      await readBounded(await get(`${api}/commits/${encodeURIComponent(source.ref)}`), 256 * 1024),
    ).toString("utf8"),
  );
  const sha =
    typeof commitData === "object" && commitData !== null && "sha" in commitData
      ? commitData.sha
      : null;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha))
    throw new Error("GitHub 리비전을 확인하지 못했습니다.");
  const treeData: unknown = JSON.parse(
    Buffer.from(
      await readBounded(await get(`${api}/git/trees/${sha}?recursive=1`), MAX_TREE_BYTES),
    ).toString("utf8"),
  );
  if (
    typeof treeData !== "object" ||
    treeData === null ||
    !("tree" in treeData) ||
    !Array.isArray(treeData.tree) ||
    ("truncated" in treeData && treeData.truncated)
  )
    throw new Error("GitHub 스킬 파일 목록을 완전히 읽지 못했습니다.");
  const prefix = `${source.directory}/`;
  const entries = (treeData.tree as TreeEntry[]).filter(
    (entry) =>
      typeof entry.path === "string" && entry.path.startsWith(prefix) && entry.type !== "tree",
  );
  if (!entries.some((entry) => entry.path === `${prefix}SKILL.md`))
    throw new Error("선택한 폴더에 SKILL.md가 없습니다.");
  if (entries.length > MAX_FILES) throw new Error("스킬 파일 수가 제한을 넘었습니다.");
  const names = new Set<string>();
  let declaredTotal = 0;
  for (const entry of entries) {
    const relative = entry.path.slice(prefix.length);
    if (
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      !/^[a-f0-9]{40}$/u.test(entry.sha) ||
      relative.split("/").some((part) => !validSkillPathPart(part) || part.toLowerCase() === ".git")
    )
      throw new Error("지원하지 않는 스킬 파일이나 경로가 있습니다.");
    const folded = relative.toLowerCase();
    if (names.has(folded)) throw new Error("대소문자가 다른 중복 파일이 있습니다.");
    names.add(folded);
    if (typeof entry.size !== "number" || entry.size < 0 || entry.size > MAX_FILE_BYTES)
      throw new Error("스킬 파일 크기를 확인할 수 없거나 제한을 넘었습니다.");
    declaredTotal += entry.size;
  }
  if (declaredTotal > MAX_TOTAL_BYTES) throw new Error("스킬 자료가 크기 제한을 넘었습니다.");
  const files: Array<{ relative: string; mode: string; data: Buffer }> = [];
  for (const entry of entries) {
    const relative = entry.path.slice(prefix.length);
    const rawPath = entry.path.split("/").map(encodeURIComponent).join("/");
    const data = Buffer.from(
      await readBounded(
        await get(
          `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${sha}/${rawPath}`,
        ),
        MAX_FILE_BYTES,
      ),
    );
    if (
      data.length !== entry.size ||
      NodeCrypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex") !==
        entry.sha
    )
      throw new Error("스킬 파일의 리비전 확인에 실패했습니다.");
    files.push({ relative, mode: entry.mode, data });
  }
  await NodeFSP.mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = NodePath.join(destination, ...file.relative.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, file.data, { mode: file.mode === "100755" ? 0o755 : 0o644 });
  }
  return sha;
}

export async function downloadGitHubSkill(
  source: GitHubSkillSource,
  destination: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<string> {
  try {
    return await downloadGitHubSkillApi(source, destination, fetcher);
  } catch (error) {
    if (!(error instanceof GitHubHttpError) || ![403, 429].includes(error.status)) throw error;
    const { downloadGitHubSkillViaGit } = await import("./GitHubSkillGit.ts");
    return downloadGitHubSkillViaGit(source, destination);
  }
}
