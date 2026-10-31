// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeStreamPromises from "node:stream/promises";

export const memoryHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");
export const memoryScopeDirectory = (stateDir: string, projectId: string, scope: string) =>
  NodePath.join(
    stateDir,
    "memory-v2",
    scope === "global" ? "global" : NodePath.join("workspaces", memoryHash(projectId).slice(0, 24)),
  );

/** Update a derived note directly at its final path. */
export async function publishMemoryFile(filename: string, text: string) {
  await NodeFSP.mkdir(NodePath.dirname(filename), { recursive: true });
  const previous = await NodeFSP.readFile(filename, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (previous === text) return;
  await NodeFSP.writeFile(filename, text, { flag: previous === null ? "wx" : "w" });
}

const WITHDRAWN_MEMORY_PAGE =
  "# 비활성화된 기억\n\n이 페이지는 더 이상 활성 기억이 아닙니다. 현재 기억과 원문 이력은 T3의 기억 저장소에서 확인하세요.\n";

async function markMemoryFileWithdrawn(filename: string) {
  const handle = await NodeFSP.open(filename, "r+").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (handle === null) return;
  try {
    if ((await handle.readFile("utf8")) === WITHDRAWN_MEMORY_PAGE) return;
    const text = Buffer.from(WITHDRAWN_MEMORY_PAGE);
    let position = 0;
    while (position < text.length) {
      const { bytesWritten } = await handle.write(text, position, text.length - position, position);
      if (bytesWritten === 0) throw new Error("Could not update withdrawn memory page");
      position += bytesWritten;
    }
    await handle.truncate(text.length);
  } finally {
    await handle.close();
  }
}

/** Mark obsolete topic pages as inactive without creating copies or deleting files. */
export async function withdrawMemoryPages(directory: string, prefix: string, retained: number) {
  const names = await NodeFSP.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of names) {
    if (!name.startsWith(`${prefix}-`) || !/^.+-\d{4,}\.md$/.test(name)) continue;
    const part = Number(name.slice(prefix.length + 1, -3));
    if (part < retained) continue;
    await markMemoryFileWithdrawn(NodePath.join(directory, name));
  }
}

export async function archiveMemoryFile(filename: string) {
  await markMemoryFileWithdrawn(filename);
}

export async function verifyHistoryArchive(
  filename: string,
  expected: string,
  signal?: AbortSignal,
) {
  const digest = NodeCrypto.createHash("sha256");
  const unzip = NodeZlib.createGunzip();
  const completion = NodeStreamPromises.pipeline(NodeFS.createReadStream(filename), unzip, {
    signal,
  });
  void completion.catch(() => undefined);
  try {
    for await (const chunk of unzip) digest.update(chunk);
    await completion;
    if (digest.digest("hex") !== expected) throw new Error("History archive SHA-256 mismatch");
  } finally {
    unzip.destroy();
    await completion.catch(() => undefined);
  }
}

/** Escape large SQL text cells a piece at a time instead of copying a multi-megabyte row. */
function* archiveRecordParts(record: unknown): Generator<string> {
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !Object.values(record).some((value) => typeof value === "string" && value.length > 32_768)
  ) {
    yield JSON.stringify(record) + "\n";
    return;
  }
  yield "{";
  let separator = "";
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") continue;
    yield separator + JSON.stringify(key) + ":";
    separator = ",";
    if (typeof value !== "string") {
      yield JSON.stringify(value);
      continue;
    }
    yield '"';
    for (let offset = 0; offset < value.length; ) {
      let end = Math.min(value.length, offset + 8192);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
      yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
      offset = end;
    }
    yield '"';
  }
  yield "}\n";
}

/** Stream a complete history directly into its final gzip artifact. */
export async function writeHistoryArchive(
  directory: string,
  records: AsyncIterable<unknown>,
  signal?: AbortSignal,
) {
  await NodeFSP.mkdir(directory, { recursive: true });
  const filename = NodePath.join(directory, `${NodeCrypto.randomUUID()}.ndjson.gz`);
  const zip = NodeZlib.createGzip({ chunkSize: 16 * 1024 });
  const output = NodeFS.createWriteStream(filename, { flags: "wx" });
  let created = false;
  output.once("open", () => {
    created = true;
  });
  const completion = NodeStreamPromises.pipeline(zip, output, { signal });
  // The producer may fail before it reaches the pipeline await.
  void completion.catch(() => undefined);
  const digest = NodeCrypto.createHash("sha256");
  let bytes = 0;
  let count = 0;
  try {
    for await (const record of records) {
      count++;
      for (const text of archiveRecordParts(record)) {
        digest.update(text);
        bytes += Buffer.byteLength(text);
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) =>
          zip.write(text, (error) => (error ? reject(error) : resolve())),
        );
      }
    }
    zip.end();
    await completion;
    const hash = digest.digest("hex");
    return {
      path: filename,
      sha256: hash,
      records: count,
      originalBytes: bytes,
      compressedBytes: (await NodeFSP.stat(filename)).size,
    };
  } catch (error) {
    zip.destroy();
    await completion.catch(() => undefined);
    if (created) await NodeFSP.rm(filename, { force: true });
    throw error;
  }
}
