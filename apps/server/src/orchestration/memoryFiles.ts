// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeStreamPromises from "node:stream/promises";
import {
  analyzeUserSpeechStyle,
  formatUserSpeechProfileMarkdown,
  type UserSpeechStyleProfile,
} from "@t3tools/shared/userSpeechProfile";

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

export interface ProceduralLessonEntry {
  readonly id: string;
  readonly topic: string;
  readonly summaryHeader: string;
  readonly text: string;
  readonly origin: string;
  readonly requiresReview: boolean;
  readonly createdAtMs?: number;
}

/** Upper bound of procedural/LESSONS.md; the memory store keeps every full text. */
export const PROCEDURAL_LESSONS_MAX_BYTES = 64 * 1024;

/**
 * CoALA Procedural Memory separation: publishes procedural/LESSONS.md as a bounded index of
 * verified user procedures, newest first, one summary line each. Agent-extracted candidates
 * are counted, not listed, and nothing here carries a memory's full text.
 */
export async function publishProceduralLessonsFile(
  scopeDirectory: string,
  entries: ReadonlyArray<ProceduralLessonEntry>,
) {
  const verified = entries
    .filter((entry) => !entry.requiresReview)
    .toSorted((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0));
  const candidateCount = entries.length - verified.length;
  const oneLine = (text: string, limit: number) =>
    Array.from(text.replace(/\s+/g, " ").trim()).slice(0, limit).join("");
  const head = [
    "# 절차적 기억 (Procedural Memory & Runbooks)",
    "",
    "CoALA 인지 아키텍처에 따라 분리된 절차·런북 목차입니다. 에이전트가 자동 추출한 후보 절차(candidate_lesson)는 검증 전까지 필수 지침으로 승격하지 마세요. 전문은 workspace_memory search/read로 확인하세요.",
    "",
    "## 확정 절차 및 런북",
  ];
  const tail = [
    "",
    "## 검증 대기 후보 절차 (candidate_lesson)",
    candidateCount > 0
      ? `(검증 대기 후보 ${candidateCount}개는 이 파일에 싣지 않습니다)`
      : "(검증 대기 후보 없음)",
    "",
  ];
  // Reserve room for the "omitted" line so the file never exceeds the bound.
  let remaining =
    PROCEDURAL_LESSONS_MAX_BYTES - Buffer.byteLength([...head, ...tail].join("\n")) - 128;
  const items: string[] = [];
  for (const entry of verified) {
    const line = `- [${entry.id}] ${oneLine(entry.topic, 120)}: ${oneLine(entry.summaryHeader, 110)}`;
    const size = Buffer.byteLength(line) + 1;
    if (size > remaining) break;
    remaining -= size;
    items.push(line);
  }
  if (items.length < verified.length)
    items.push(`- (용량 한도로 이전 절차 ${verified.length - items.length}개 생략)`);
  const lines = [...head, ...(items.length > 0 ? items : ["(등록된 확정 절차 없음)"]), ...tail];
  await publishMemoryFile(
    NodePath.join(scopeDirectory, "procedural", "LESSONS.md"),
    lines.join("\n"),
  );
}

export interface SeparatedUserUtteranceRecord {
  readonly id: string;
  readonly threadId: string;
  readonly threadTitle?: string | null;
  readonly text: string;
  readonly createdAt: string;
}

export interface SeparatedAiOutputRecord {
  readonly id: string;
  readonly kind: "assistant_message" | "agent_knowledge";
  readonly title: string;
  readonly threadId?: string | null;
  readonly text: string;
  readonly createdAt: string;
}

const USER_UTTERANCE_PAGE_SIZE = 20;
const AI_OUTPUT_PAGE_SIZE = 12;

/**
 * Physically separates:
 * 1) `user-utterances/USER_STYLE_PROFILE.md` + `user-utterances/utterances-XXXX.md`
 *    (100% verbatim user prompts & natural speech patterns, zero AI prose mixed in)
 * 2) `ai-outputs/outputs-XXXX.md`
 *    (AI responses, subagent research, collaboration/council reports)
 */
export async function publishSeparatedConversationCorpora(
  scopeDirectory: string,
  input: {
    readonly userUtterances: ReadonlyArray<SeparatedUserUtteranceRecord>;
    readonly aiOutputs: ReadonlyArray<SeparatedAiOutputRecord>;
  },
): Promise<{
  readonly profile: UserSpeechStyleProfile;
  readonly userPagesWritten: number;
  readonly aiPagesWritten: number;
}> {
  const chronologicalUsers = [...input.userUtterances].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const profile = analyzeUserSpeechStyle(chronologicalUsers);
  const userDir = NodePath.join(scopeDirectory, "user-utterances");
  const aiDir = NodePath.join(scopeDirectory, "ai-outputs");

  await publishMemoryFile(
    NodePath.join(userDir, "USER_STYLE_PROFILE.md"),
    formatUserSpeechProfileMarkdown(profile),
  );

  const newestUsersFirst = [...chronologicalUsers].reverse();
  let userPart = 0;
  for (let offset = 0; offset < newestUsersFirst.length; offset += USER_UTTERANCE_PAGE_SIZE) {
    const slice = newestUsersFirst.slice(offset, offset + USER_UTTERANCE_PAGE_SIZE);
    const sections = slice.map(
      (u) =>
        `## ${u.createdAt} · ${u.threadTitle?.trim() || u.threadId} [message:${u.id}]\n${u.text.trim()}`,
    );
    const body = [
      "# 내 대화 원문 보관소 (User Utterances Only)",
      "",
      "AI 응답·조사 결과와 완전히 분리된 **사용자 본인 발화 원문**입니다. 말투·화법·원래 의도를 가공 없이 보존합니다.",
      "",
      sections.join("\n\n"),
      "",
    ].join("\n");
    await publishMemoryFile(
      NodePath.join(userDir, `utterances-${String(userPart++).padStart(4, "0")}.md`),
      body,
    );
  }
  await withdrawMemoryPages(userDir, "utterances", userPart);

  const newestAiFirst = [...input.aiOutputs].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  let aiPart = 0;
  for (let offset = 0; offset < newestAiFirst.length; offset += AI_OUTPUT_PAGE_SIZE) {
    const slice = newestAiFirst.slice(offset, offset + AI_OUTPUT_PAGE_SIZE);
    const sections = slice.map(
      (item) =>
        `## ${item.createdAt} · ${item.kind === "agent_knowledge" ? "AI 조사·협업" : "AI 응답"} · ${item.title} [${item.id}]\n${item.text.trim()}`,
    );
    const body = [
      "# AI 작성·조사 결과 보관소 (AI Research & Outputs Only)",
      "",
      "사용자 발화와 분리하여 보관된 AI 응답·조사·협업 산출물입니다. 미검증 보고일 수 있으므로 현재 사용자 지시를 우선하세요.",
      "",
      sections.join("\n\n"),
      "",
    ].join("\n");
    await publishMemoryFile(
      NodePath.join(aiDir, `outputs-${String(aiPart++).padStart(4, "0")}.md`),
      body,
    );
  }
  await withdrawMemoryPages(aiDir, "outputs", aiPart);

  return {
    profile,
    userPagesWritten: userPart,
    aiPagesWritten: aiPart,
  };
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
