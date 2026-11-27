// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeUtil from "node:util";
import { memoryHash, memoryScopeDirectory } from "./memoryFiles.ts";

const gunzip = NodeUtil.promisify(NodeZlib.gunzip);

type ArchiveRow = {
  thread_id: string;
  path: string;
  sha256: string;
  records: number;
  created_at: string;
};
type ImportedActivity = { thread_id: string; payload_json: string };

/** Read only app-owned immutable source files and verify their complete contents. */
export async function readWorkspaceArchiveFiles(input: {
  stateDir: string;
  projectId: string;
  archives: readonly ArchiveRow[];
  imports: readonly ImportedActivity[];
}) {
  const sourceArchives = [];
  for (const row of input.archives) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256))
      throw new Error("대화 보관 원본의 해시가 올바르지 않습니다.");
    const expectedDir = NodePath.join(
      memoryScopeDirectory(input.stateDir, input.projectId, "project"),
      "sources",
      memoryHash(row.thread_id),
    );
    const directory = await NodeFs.realpath(expectedDir);
    const actual = await NodeFs.realpath(row.path);
    if (NodePath.dirname(actual) !== directory || !actual.endsWith(".ndjson.gz"))
      throw new Error("대화 보관 원본의 위치가 프로젝트 범위를 벗어났습니다.");
    const content = await gunzip(await NodeFs.readFile(actual));
    if (NodeCrypto.createHash("sha256").update(content).digest("hex") !== row.sha256)
      throw new Error("대화 보관 원본의 해시가 일치하지 않습니다.");
    sourceArchives.push({
      threadId: row.thread_id,
      sha256: row.sha256,
      records: row.records,
      createdAt: row.created_at,
      content: content.toString("utf8"),
    });
  }
  const importedSources = [];
  for (const row of input.imports) {
    let data: unknown;
    try {
      data = JSON.parse(row.payload_json);
    } catch {
      throw new Error("가져온 대화 원본의 출처를 해석할 수 없습니다.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("가져온 대화 출처가 올바르지 않습니다.");
    const metadata = data as Record<string, unknown>;
    const hash = metadata.sourceHash;
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error("가져온 대화 원본의 해시가 올바르지 않습니다.");
    const directory = await NodeFs.realpath(NodePath.join(input.stateDir, "conversation-imports"));
    const actual = await NodeFs.realpath(NodePath.join(directory, hash + ".txt"));
    if (NodePath.dirname(actual) !== directory)
      throw new Error("가져온 대화 원본의 위치가 올바르지 않습니다.");
    const content = await NodeFs.readFile(actual);
    if (NodeCrypto.createHash("sha256").update(content).digest("hex") !== hash)
      throw new Error("가져온 대화 원본의 해시가 일치하지 않습니다.");
    importedSources.push({
      threadId: row.thread_id,
      sha256: hash,
      format: typeof metadata.format === "string" ? metadata.format : "unknown",
      content: content.toString("utf8"),
    });
  }
  return { sourceArchives, importedSources };
}
