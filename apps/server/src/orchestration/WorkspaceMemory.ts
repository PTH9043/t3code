// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import {
  type ProjectId,
  type ThreadId,
  type MessageId,
  WorkspaceMemoryError,
  type WorkspaceMemoryAction,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";
import { readHistorySource } from "../persistence/historySource.ts";
import {
  buildSearchQuery,
  analyzeSearchText,
  chunkSearchableContent,
  CHUNK_OVERLAP,
  termCoverage,
} from "../persistence/searchText.ts";
import { matchedMemoryExcerpt, selectMemoryEvidence } from "./memoryRetrieval.ts";
import {
  memoryHash,
  memoryScopeDirectory,
  publishMemoryFile,
  writeHistoryArchive,
  verifyHistoryArchive,
  withdrawMemoryPages,
  archiveMemoryFile,
} from "./memoryFiles.ts";

const MAX_NOTE_CHARS = 8_000;
const PAGE_SIZE = 64;
const MANIFEST_BYTES = 8 * 1024;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const durableUserText =
  /기억|항상|금지|하지\s*마|지시|결정|규칙|정정|실패|원인|remember|always|never|decision|convention|root cause/iu;
const Settings = Schema.Struct({
  conversationRag: Schema.optional(Schema.Struct({ enabled: Schema.Boolean })),
  contextOptimization: Schema.optional(
    Schema.Struct({ autoChatMemory: Schema.optional(Schema.Boolean) }),
  ),
});
const decodeSettings = Schema.decodeUnknownSync(Schema.fromJsonString(Settings));
const Source = Schema.Struct({
  kind: Schema.String,
  id: Schema.String,
  projectId: Schema.optionalKey(Schema.String),
  folder: Schema.optionalKey(Schema.String),
});
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(Source));
const isMemoryError = Schema.is(WorkspaceMemoryError);
type RecordRow = {
  id: string;
  project_id: string;
  scope: string;
  topic: string;
  text: string;
  source_json: string;
  source_hash: string;
  origin: string;
  verification: string;
  status: string;
  created_at: string;
  updated_at: string;
};
type MessageRow = {
  rowid: number;
  message_id: string;
  thread_id: string;
  turn_id: string | null;
  role: string;
  text: string;
  text_length: number;
  created_at: string;
  updated_at: string;
  settled: number;
};
type Capture = {
  projectId: string;
  id: string;
  topic: string;
  text: string;
  source: unknown;
  origin: string;
  verification: string;
  createdAt: string;
  scope?: string | undefined;
  durable?: boolean;
};
type PreparedCapture = {
  input: Capture;
  sourceJson: string;
  scope: string;
  hash: string;
  text: string;
  searchText: string;
  existing: RecordRow | undefined;
};

export class WorkspaceMemory extends Context.Service<
  WorkspaceMemory,
  {
    invoke: (
      input: WorkspaceMemoryAction,
      context?: { readonly threadId: ThreadId },
    ) => Effect.Effect<string, WorkspaceMemoryError>;
    context: (
      projectId: ProjectId,
      task: string,
      directivesOnly?: boolean,
      current?: {
        readonly threadId: ThreadId;
        readonly messageId: MessageId;
        readonly inheritFolder?: boolean;
        readonly excludeDirectives?: boolean;
        readonly excludeRecentConversation?: boolean;
      },
    ) => Effect.Effect<string, WorkspaceMemoryError>;
    contextPaths: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly cwd: string;
      readonly recordCurrent?: boolean;
    }) => Effect.Effect<ReadonlyArray<string>, WorkspaceMemoryError>;
    reconcile: (projectId: ProjectId) => Effect.Effect<void, WorkspaceMemoryError>;
    handoff: (
      projectId: ProjectId,
      threadId: ThreadId,
      messageId: MessageId,
      archive: boolean,
    ) => Effect.Effect<string | undefined, WorkspaceMemoryError>;
  }
>()("t3/orchestration/WorkspaceMemory") {
  static readonly layer = Layer.effect(
    WorkspaceMemory,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const clock = yield* Clock.Clock;
      const gate = yield* Semaphore.make(1);
      const exportGate = yield* Semaphore.make(1);
      const folderCache = new Map<
        ThreadId,
        {
          projectId: ProjectId;
          cwd: string;
          rowid: number;
          messageId: MessageId;
          folder: string | null;
        }
      >();
      const now = () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
      const io = <A>(f: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({
          try: f,
          catch: (cause) =>
            new WorkspaceMemoryError({ message: "기억 원문 파일을 처리하지 못했습니다.", cause }),
        });
      const safe = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isMemoryError(cause)
              ? cause
              : new WorkspaceMemoryError({ message: "기억 저장소를 처리하지 못했습니다.", cause }),
          ),
        );
      const directory = (project: string, scope = "project") =>
        memoryScopeDirectory(config.stateDir, project, scope);
      const inbox = (project: string, scope: string, id: string) =>
        NodePath.join(directory(project, scope), "observations", "_inbox", `${id}.md`);
      const dirty = (projectId: string, scope: string, topic: string) =>
        sql`INSERT OR IGNORE INTO workspace_memory_v2_dirty(project_id,scope,topic) VALUES (${projectId},${scope},${topic})`;
      const checkedProject = Effect.fn("WorkspaceMemory.project")(function* (projectId: string) {
        const [project] = yield* sql<{
          workspace_control_json: string;
        }>`SELECT workspace_control_json FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
        if (!project)
          return yield* new WorkspaceMemoryError({ message: "프로젝트를 찾을 수 없습니다." });
        return yield* Effect.try({
          try: () => decodeSettings(project.workspace_control_json),
          catch: (cause) =>
            new WorkspaceMemoryError({
              message: "프로젝트 기억 설정을 확인하지 못했습니다.",
              cause,
            }),
        });
      });
      const checkedThread = Effect.fn("WorkspaceMemory.thread")(function* (
        projectId: string,
        threadId: string,
      ) {
        const [thread] =
          yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id=${threadId} AND project_id=${projectId} AND deleted_at IS NULL`;
        if (!thread)
          return yield* new WorkspaceMemoryError({
            message: "현재 프로젝트의 대화만 조회할 수 있습니다.",
          });
      });
      const contextPaths = Effect.fn("WorkspaceMemory.contextPaths")(function* (input: {
        readonly projectId: ProjectId;
        readonly threadId: ThreadId;
        readonly messageId: MessageId;
        readonly cwd: string;
        readonly recordCurrent?: boolean;
      }) {
        yield* checkedThread(input.projectId, input.threadId);
        const [boundary] = yield* sql<{
          rowid: number;
        }>`SELECT rowid FROM projection_thread_messages WHERE thread_id=${input.threadId} AND message_id=${input.messageId}`;
        if (!boundary) {
          return yield* new WorkspaceMemoryError({
            message: "현재 대화의 메시지 위치를 확인하지 못했습니다.",
          });
        }
        const root = NodePath.resolve(input.cwd);
        const canonicalRoot = yield* fileSystem
          .realPath(root)
          .pipe(Effect.orElseSucceed(() => null));
        if (!canonicalRoot) {
          return yield* new WorkspaceMemoryError({
            message: "현재 작업 폴더를 확인하지 못했습니다.",
          });
        }
        const previous = folderCache.get(input.threadId);
        let validPrevious =
          previous?.projectId === input.projectId &&
          previous.cwd === root &&
          (previous.rowid < boundary.rowid ||
            (previous.rowid === boundary.rowid && previous.messageId === input.messageId));
        if (validPrevious && previous) {
          const [existing] = yield* sql<{
            rowid: number;
          }>`SELECT rowid FROM projection_thread_messages WHERE thread_id=${input.threadId} AND message_id=${previous.messageId} AND rowid=${previous.rowid}`;
          validPrevious = Boolean(existing);
        }
        const lower = validPrevious && previous ? previous.rowid : 0;
        let upper = boundary.rowid;
        let folder: string | null = validPrevious && previous ? previous.folder : null;
        while (upper > lower) {
          const rows = yield* sql<{
            rowid: number;
            text: string;
          }>`SELECT rowid,text FROM projection_thread_messages
            WHERE thread_id=${input.threadId} AND role='user' AND rowid>${lower} AND rowid<=${upper}
            ORDER BY rowid DESC LIMIT ${PAGE_SIZE}`;
          if (!rows.length) break;
          let selected: string | null | undefined;
          for (const row of rows) {
            const tokens = collectComposerInlineTokens(`${row.text} `)
              .filter((token) => token.type === "mention")
              .map((token) => token.value);
            const quoted = [...row.text.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1] ?? "");
            const bare = [
              ...row.text.matchAll(
                /(?:^|\s)([\p{L}\p{N}_.:-]+(?:[\\/][\p{L}\p{N}_.-]+)+)(?=\s|$)/gu,
              ),
            ].map((match) => match[1] ?? "");
            const found = new Set<string>();
            for (const candidate of new Set([...tokens, ...quoted, ...bare])) {
              if (!candidate || candidate.includes("\0")) continue;
              const absolute = NodePath.resolve(root, candidate);
              const relative = NodePath.relative(root, absolute);
              if (
                relative === ".." ||
                relative.startsWith(`..${NodePath.sep}`) ||
                NodePath.isAbsolute(relative)
              )
                continue;
              const canonical = yield* fileSystem
                .realPath(absolute)
                .pipe(Effect.orElseSucceed(() => null));
              if (!canonical) continue;
              const inside = NodePath.relative(canonicalRoot, canonical);
              if (
                inside === ".." ||
                inside.startsWith(`..${NodePath.sep}`) ||
                NodePath.isAbsolute(inside)
              )
                continue;
              const info = yield* fileSystem.stat(canonical).pipe(Effect.orElseSucceed(() => null));
              if (info?.type !== "Directory") continue;
              const normalized = relative.replaceAll("\\", "/");
              if (normalized.length > 240) continue;
              found.add(normalized);
            }
            if (found.size === 1) {
              selected = [...found][0] || null;
              break;
            }
            if (found.size > 1 && input.recordCurrent) {
              const [prior] = yield* sql<{ folder: string | null }>`
                SELECT f.folder FROM projection_thread_messages u
                LEFT JOIN workspace_memory_v2_message_folders f
                  ON f.message_id=u.message_id AND f.project_id=${input.projectId}
                WHERE u.thread_id=${input.threadId} AND u.role='user' AND u.rowid<${row.rowid}
                ORDER BY u.rowid DESC LIMIT 1`;
              if (prior?.folder != null) {
                selected = prior.folder || null;
                break;
              }
              return yield* new WorkspaceMemoryError({
                message: "여러 작업 폴더가 지정되어 이전에 확인한 폴더를 찾지 못했습니다.",
              });
            }
          }
          if (selected !== undefined) {
            folder = selected;
            break;
          }
          if (rows.length < PAGE_SIZE) break;
          upper = rows[rows.length - 1]!.rowid - 1;
          yield* Effect.yieldNow;
        }
        const cached = folderCache.get(input.threadId);
        if (!cached || cached.rowid <= boundary.rowid || !validPrevious) {
          folderCache.set(input.threadId, {
            projectId: input.projectId,
            cwd: root,
            rowid: boundary.rowid,
            messageId: input.messageId,
            folder,
          });
        }
        if (input.recordCurrent) {
          yield* sql`INSERT OR IGNORE INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
            SELECT message_id,${input.projectId},${input.threadId},${folder ?? ""}
            FROM projection_thread_messages WHERE thread_id=${input.threadId} AND message_id=${input.messageId} AND role='user'`;
          const [recorded] = yield* sql<{
            folder: string;
          }>`SELECT folder FROM workspace_memory_v2_message_folders
            WHERE message_id=${input.messageId} AND project_id=${input.projectId} AND thread_id=${input.threadId}`;
          if (!recorded || recorded.folder !== (folder ?? ""))
            return yield* new WorkspaceMemoryError({
              message: "현재 메시지의 기록된 폴더가 달라 기억을 주입하지 않았습니다.",
            });
        }
        return folder ? [folder] : [];
      });
      const prepareCapture = Effect.fn("WorkspaceMemory.prepareCapture")(function* (
        input: Capture,
      ) {
        const sourceJson = encodeJson(input.source);
        const scope = input.scope ?? "project";
        const hash = memoryHash(encodeJson([input.text, sourceJson, scope, input.topic]));
        const text = Array.from(input.text).slice(0, MAX_NOTE_CHARS).join("");
        const [existing] =
          yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 WHERE id=${input.id}`;
        if (
          existing?.status === "forgotten" ||
          (existing?.source_hash === hash &&
            existing.text === text &&
            existing.status !== "archived")
        )
          return;
        // SQLite is the durable source; do not create transient inbox documents.
        return {
          input,
          sourceJson,
          scope,
          hash,
          text,
          searchText: analyzeSearchText(input.topic + " " + text),
          existing,
        };
      });
      const persistCapture = Effect.fn("WorkspaceMemory.persistCapture")(function* (
        prepared: PreparedCapture,
      ) {
        const { input, sourceJson, scope, hash, text, searchText, existing } = prepared;
        if (existing) yield* dirty(existing.project_id, existing.scope, existing.topic);
        yield* sql`INSERT INTO workspace_memory_v2 (id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,created_at,updated_at)
          VALUES (${input.id},${input.projectId},${scope},${input.topic},${text},${sourceJson},${hash},${input.origin},${input.verification},${input.durable ? "pending" : "observed"},${input.createdAt},${now()})
          ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,scope=excluded.scope,topic=excluded.topic,text=excluded.text,source_json=excluded.source_json,source_hash=excluded.source_hash,origin=excluded.origin,verification=excluded.verification,status=excluded.status,created_at=excluded.created_at,updated_at=excluded.updated_at`;
        yield* sql`DELETE FROM workspace_memory_v2_fts WHERE rowid=(SELECT rowid FROM workspace_memory_v2 WHERE id=${input.id})`;
        yield* sql`INSERT INTO workspace_memory_v2_fts(rowid,id,project_id,scope,content) SELECT rowid,id,project_id,scope,${searchText} FROM workspace_memory_v2 WHERE id=${input.id}`;
        if (input.durable) yield* dirty(input.projectId, scope, input.topic);
      });
      const capture = Effect.fn("WorkspaceMemory.capture")(function* (input: Capture) {
        const prepared = yield* prepareCapture(input);
        if (prepared) yield* sql.withTransaction(persistCapture(prepared));
      });
      const clearChunks = Effect.fn("WorkspaceMemory.clearChunks")(function* (memoryId: string) {
        yield* sql`DELETE FROM workspace_memory_v2_chunks WHERE rowid IN (SELECT chunk_rowid FROM workspace_memory_v2_chunk_rows WHERE memory_id=${memoryId})`;
        yield* sql`DELETE FROM workspace_memory_v2_chunk_rows WHERE memory_id=${memoryId}`;
      });
      const indexLongSource = Effect.fn("WorkspaceMemory.indexLongSource")(function* (input: {
        projectId: string;
        memoryId: string;
        kind: "message" | "knowledge";
        sourceId: string;
        updatedAt: string;
        length: number;
      }) {
        const [record] =
          yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 WHERE id=${input.memoryId}`;
        const [state] = yield* sql<{
          source_version: string;
        }>`SELECT source_version FROM workspace_memory_v2_chunk_state WHERE memory_id=${input.memoryId}`;
        if (input.length <= MAX_NOTE_CHARS && !state) return;
        if (!record || record.status === "forgotten" || record.status === "archived") {
          if (state) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* clearChunks(input.memoryId);
                yield* sql`DELETE FROM workspace_memory_v2_chunk_state WHERE memory_id=${input.memoryId}`;
              }),
            );
          }
          return;
        }
        const version = `${input.updatedAt}:${input.length}`;
        if (state?.source_version === version) return;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* clearChunks(input.memoryId);
            if (input.length > MAX_NOTE_CHARS) {
              for (
                let offset = 0;
                offset < input.length;
                offset += MAX_NOTE_CHARS - CHUNK_OVERLAP
              ) {
                const [page] =
                  input.kind === "message"
                    ? yield* sql<{
                        text: string;
                      }>`SELECT substr(m.text,${offset + 1},${MAX_NOTE_CHARS}) AS text FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id WHERE m.message_id=${input.sourceId} AND t.project_id=${input.projectId} AND t.deleted_at IS NULL`
                    : yield* sql<{
                        text: string;
                      }>`SELECT substr(content,${offset + 1},${MAX_NOTE_CHARS}) AS text FROM projection_workspace_knowledge_items WHERE project_id=${input.projectId} AND item_id=${input.sourceId} AND status='active'`;
                if (!page)
                  return yield* new WorkspaceMemoryError({
                    message: "기억 원문을 찾을 수 없습니다.",
                  });
                for (const chunk of chunkSearchableContent(page.text)) {
                  yield* sql`INSERT INTO workspace_memory_v2_chunk_rows(memory_id) VALUES (${input.memoryId})`;
                  yield* sql`INSERT INTO workspace_memory_v2_chunks(rowid,memory_id,project_id,chunk_text,content) VALUES (last_insert_rowid(),${input.memoryId},${input.projectId},${chunk},${analyzeSearchText(chunk)})`;
                }
              }
            }
            yield* sql`INSERT INTO workspace_memory_v2_chunk_state(memory_id,project_id,source_kind,source_id,source_version)
              VALUES (${input.memoryId},${input.projectId},${input.kind},${input.sourceId},${version})
              ON CONFLICT(memory_id) DO UPDATE SET project_id=excluded.project_id,source_kind=excluded.source_kind,source_id=excluded.source_id,source_version=excluded.source_version`;
          }),
        );
      });
      const indexLongMessage = (projectId: string, row: MessageRow) =>
        indexLongSource({
          projectId,
          memoryId: memoryHash(`message:${row.message_id}`),
          kind: "message",
          sourceId: row.message_id,
          updatedAt: row.updated_at,
          length: row.text_length,
        });
      const manifest = Effect.fn("WorkspaceMemory.manifest")(function* (
        projectId: string,
        scope = "project",
      ) {
        const rows = yield* sql<{
          topic: string;
          total: number;
        }>`SELECT topic,count(*) AS total FROM workspace_memory_v2 r
        WHERE ${scope === "global" ? sql`scope='global'` : sql`project_id=${projectId} AND scope='project'`} AND status='consolidated'
        AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
        GROUP BY topic ORDER BY max(updated_at) DESC,topic LIMIT 65`;
        let text = `# ${scope === "global" ? "공용" : "프로젝트"} 기억 목차\n\n자동 생성된 출처 목차입니다. workspace_memory search/read로 확인하고, 최신의 명시적 정정을 우선하세요.\n`;
        let entries = 0;
        for (const row of rows.slice(0, 64)) {
          const line = `\n- ${row.topic.replace(/\s+/g, " ")} (${row.total}개): topics/${memoryHash(row.topic).slice(0, 24)}-0000.md`;
          if (Buffer.byteLength(text + line) > MANIFEST_BYTES - 180) break;
          text += line;
          entries++;
        }
        if (entries < rows.length) text += "\n\n추가 주제는 전체 검색 색인에서 조회하세요.";
        return text;
      });
      const dream = Effect.fn("WorkspaceMemory.dream")(function* (projectId: string) {
        let written = 0;
        while (true) {
          const topics = yield* sql<{
            topic: string;
            scope: string;
          }>`SELECT DISTINCT topic,scope FROM workspace_memory_v2_dirty WHERE project_id=${projectId} OR scope='global' ORDER BY scope,topic LIMIT 64`;
          if (!topics.length) break;
          for (const topic of topics) {
            let date = "\uffff";
            let cursor = "\uffff";
            let part = 0;
            const seen = new Set<string>();
            const root = directory(projectId, topic.scope);
            const prefix = memoryHash(topic.topic).slice(0, 24);
            while (true) {
              const rows = yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 r WHERE
              ${topic.scope === "global" ? sql`scope='global'` : sql`project_id=${projectId} AND scope='project'`} AND topic=${topic.topic}
              AND status IN ('pending','consolidated') AND (created_at<${date} OR (created_at=${date} AND id<${cursor}))
              AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
              ORDER BY created_at DESC,id DESC LIMIT 8`;
              if (!rows.length) break;
              const chunks: string[] = [];
              for (const row of rows) {
                const digest = memoryHash(row.text);
                chunks.push(
                  `## ${row.created_at} · ${row.origin} · ${row.verification} [${row.id}]\n${seen.has(digest) ? "동일 본문의 추가 출처" : row.text}\n근거: ${row.source_json}`,
                );
                if (seen.size < 4096) seen.add(digest);
              }
              const body = `# ${topic.topic}\n\n최신 기록부터 나열한 근거 모음입니다. 현재 사용자 지시·명시적 정정을 우선하고, 에이전트 보고는 검증 전 사실로 확정하지 마세요.\n\n${chunks.join("\n\n")}\n`;
              yield* io(() =>
                publishMemoryFile(
                  NodePath.join(root, "topics", `${prefix}-${String(part++).padStart(4, "0")}.md`),
                  body,
                ),
              );
              yield* sql`UPDATE workspace_memory_v2 SET status='consolidated' WHERE id IN ${sql.in(rows.map((row) => row.id))}`;
              for (const row of rows)
                yield* io(() => archiveMemoryFile(inbox(row.project_id, row.scope, row.id)));
              date = rows.at(-1)!.created_at;
              cursor = rows.at(-1)!.id;
              written++;
              yield* Effect.yieldNow;
            }
            yield* io(() => withdrawMemoryPages(NodePath.join(root, "topics"), prefix, part));
            yield* sql`DELETE FROM workspace_memory_v2_dirty WHERE topic=${topic.topic} AND ${topic.scope === "global" ? sql`scope='global'` : sql`scope='project' AND project_id=${projectId}`}`;
          }
        }
        for (const scope of ["project", "global"]) {
          const text = yield* manifest(projectId, scope);
          yield* io(() =>
            publishMemoryFile(NodePath.join(directory(projectId, scope), "MEMORY.md"), text),
          );
        }
        return { topicPagesWritten: written, consolidation: "source-preserving-extractive" };
      });
      const messageCapture = (projectId: string, row: MessageRow): Capture => ({
        projectId,
        id: memoryHash(`message:${row.message_id}`),
        topic: row.role === "user" ? "사용자 결정과 정정" : "이전 작업 보고",
        text: row.text,
        source: {
          kind: "message",
          id: row.message_id,
          projectId,
          threadId: row.thread_id,
          turnId: row.turn_id,
          length: row.text_length,
          excerpt: row.text_length > MAX_NOTE_CHARS,
        },
        origin: row.role,
        verification: row.role === "user" ? "user-statement" : "unverified-report",
        createdAt: row.created_at,
        durable: row.role === "user" && durableUserText.test(row.text),
      });
      const backfill = Effect.fn("WorkspaceMemory.backfill")(function* (projectId: string) {
        if ((yield* checkedProject(projectId)).conversationRag?.enabled === false)
          return { processed: 0, hasMore: false };
        const key = `messages:${projectId}`;
        const [progress] = yield* sql<{
          position: number;
        }>`SELECT position FROM workspace_memory_v2_progress WHERE stream_key=${key}`;
        const rows =
          yield* sql<MessageRow>`SELECT m.rowid,m.message_id,m.thread_id,m.turn_id,m.role,substr(m.text,1,${MAX_NOTE_CHARS}) AS text,length(m.text) AS text_length,m.created_at,m.updated_at,
        (m.is_streaming=0 AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM projection_turns p WHERE p.thread_id=m.thread_id AND p.turn_id=m.turn_id AND p.state IN ('completed','interrupted','error')))) AS settled
        FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND m.rowid>${progress?.position ?? 0} ORDER BY m.rowid LIMIT ${PAGE_SIZE}`;
        const prepared = yield* Effect.forEach(
          rows,
          (row) =>
            row.settled && row.text.trim()
              ? prepareCapture(messageCapture(projectId, row))
              : Effect.succeed(undefined),
          { concurrency: 1 },
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const row of rows) {
              if (!row.settled)
                yield* sql`INSERT OR IGNORE INTO workspace_memory_v2_pending(message_id,project_id) VALUES (${row.message_id},${projectId})`;
            }
            for (const entry of prepared) if (entry) yield* persistCapture(entry);
            if (rows.length)
              yield* sql`INSERT INTO workspace_memory_v2_progress(stream_key,position,updated_at) VALUES (${key},${rows.at(-1)!.rowid},${now()}) ON CONFLICT(stream_key) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at`;
          }),
        );
        const pending =
          yield* sql<MessageRow>`SELECT m.rowid,m.message_id,m.thread_id,m.turn_id,m.role,substr(m.text,1,${MAX_NOTE_CHARS}) AS text,length(m.text) AS text_length,m.created_at,m.updated_at,1 AS settled
        FROM workspace_memory_v2_pending q JOIN projection_thread_messages m ON m.message_id=q.message_id JOIN projection_threads t ON t.thread_id=m.thread_id
        WHERE q.project_id=${projectId} AND t.deleted_at IS NULL AND m.is_streaming=0 AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM projection_turns p WHERE p.thread_id=m.thread_id AND p.turn_id=m.turn_id AND p.state IN ('completed','interrupted','error')))
        ORDER BY m.rowid LIMIT ${PAGE_SIZE}`;
        const preparedPending = yield* Effect.forEach(
          pending,
          (row) =>
            row.text.trim()
              ? prepareCapture(messageCapture(projectId, row))
              : Effect.succeed(undefined),
          { concurrency: 1 },
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const entry of preparedPending) if (entry) yield* persistCapture(entry);
          }),
        );
        for (const row of pending) {
          if (row.text_length > MAX_NOTE_CHARS) yield* indexLongMessage(projectId, row);
          yield* sql`DELETE FROM workspace_memory_v2_pending WHERE message_id=${row.message_id}`;
        }
        return {
          processed: rows.length + pending.length,
          hasMore: rows.length === PAGE_SIZE || pending.length === PAGE_SIZE,
        };
      });
      const backfillLongMessages = Effect.fn("WorkspaceMemory.backfillLongMessages")(function* (
        projectId: string,
      ) {
        const key = `long-messages:${projectId}`;
        const [progress] = yield* sql<{
          position: number;
        }>`SELECT position FROM workspace_memory_v2_progress WHERE stream_key=${key}`;
        const rows =
          yield* sql<MessageRow>`SELECT m.rowid,m.message_id,m.thread_id,m.turn_id,m.role,substr(m.text,1,${MAX_NOTE_CHARS}) AS text,length(m.text) AS text_length,m.created_at,m.updated_at,
          (m.is_streaming=0 AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM projection_turns p WHERE p.thread_id=m.thread_id AND p.turn_id=m.turn_id AND p.state IN ('completed','interrupted','error')))) AS settled
          FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id
          WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND m.rowid>${progress?.position ?? 0} AND length(CAST(m.text AS BLOB))>${MAX_NOTE_CHARS}
          ORDER BY m.rowid LIMIT ${PAGE_SIZE}`;
        for (const row of rows) {
          if (!row.settled) {
            yield* sql`INSERT OR IGNORE INTO workspace_memory_v2_pending(message_id,project_id) VALUES (${row.message_id},${projectId})`;
          } else if (row.text.trim()) {
            yield* capture(messageCapture(projectId, row));
            yield* indexLongMessage(projectId, row);
          }
          yield* sql`INSERT INTO workspace_memory_v2_progress(stream_key,position,updated_at) VALUES (${key},${row.rowid},${now()})
            ON CONFLICT(stream_key) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at`;
        }
        return rows.length === PAGE_SIZE;
      });
      const refreshLongMessages = Effect.fn("WorkspaceMemory.refreshLongMessages")(function* (
        projectId: string,
      ) {
        while (true) {
          const rows =
            yield* sql<MessageRow>`SELECT m.rowid,m.message_id,m.thread_id,m.turn_id,m.role,substr(m.text,1,${MAX_NOTE_CHARS}) AS text,length(m.text) AS text_length,m.created_at,m.updated_at,1 AS settled
            FROM workspace_memory_v2_chunk_state s JOIN projection_thread_messages m ON m.message_id=s.source_id
            JOIN projection_threads t ON t.thread_id=m.thread_id
            WHERE s.project_id=${projectId} AND s.source_kind='message' AND t.project_id=${projectId} AND t.deleted_at IS NULL
            AND s.source_version<>(m.updated_at || ':' || length(m.text)) AND m.is_streaming=0
            AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM projection_turns p WHERE p.thread_id=m.thread_id AND p.turn_id=m.turn_id AND p.state IN ('completed','interrupted','error')))
            ORDER BY m.rowid LIMIT ${PAGE_SIZE}`;
          for (const row of rows) {
            yield* capture(messageCapture(projectId, row));
            yield* indexLongMessage(projectId, row);
          }
          if (rows.length < PAGE_SIZE) break;
          yield* Effect.yieldNow;
        }
      });
      const reconcileUnsafe = Effect.fn("WorkspaceMemory.reconcile")(function* (
        projectId: ProjectId,
      ) {
        if ((yield* checkedProject(projectId)).conversationRag?.enabled === false) return;
        let cursor = "";
        while (true) {
          const notes = yield* sql<{
            item_id: string;
            title: string;
            content: string;
            content_length: number;
            status: string;
            origin: string;
            scope: string;
            created_at: string;
            updated_at: string;
          }>`SELECT item_id,title,substr(content,1,${MAX_NOTE_CHARS}) AS content,length(content) AS content_length,status,origin,scope,created_at,updated_at FROM projection_workspace_knowledge_items
          WHERE project_id=${projectId} AND kind IN ('directive','goal','prompt','long-term-memory') AND item_id>${cursor} ORDER BY item_id LIMIT ${PAGE_SIZE}`;
          for (const note of notes) {
            const id = memoryHash(`knowledge:${projectId}:${note.item_id}`);
            if (note.status !== "active" || note.scope === "folder") {
              const [old] =
                yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 WHERE id=${id} AND status NOT IN ('archived','forgotten')`;
              if (old) {
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* dirty(old.project_id, old.scope, old.topic);
                    yield* sql`UPDATE workspace_memory_v2 SET status='archived' WHERE id=${id}`;
                    yield* clearChunks(id);
                    yield* sql`DELETE FROM workspace_memory_v2_chunk_state WHERE memory_id=${id}`;
                  }),
                );
                yield* io(() => archiveMemoryFile(inbox(old.project_id, old.scope, id)));
              }
            } else {
              yield* capture({
                projectId,
                id,
                topic: note.title,
                text: note.content,
                source: {
                  kind: "knowledge",
                  id: note.item_id,
                  projectId,
                  updatedAt: note.updated_at,
                },
                origin: note.origin,
                verification: note.origin === "user" ? "user-statement" : "unverified-report",
                createdAt: note.updated_at,
                scope: note.scope === "environment" ? "global" : "project",
                durable: true,
              });
              yield* indexLongSource({
                projectId,
                memoryId: id,
                kind: "knowledge",
                sourceId: note.item_id,
                updatedAt: note.updated_at,
                length: note.content_length,
              });
            }
          }
          if (notes.length < PAGE_SIZE) break;
          cursor = notes.at(-1)!.item_id;
          yield* Effect.yieldNow;
        }
        let more = true;
        while (more) {
          more = (yield* backfill(projectId)).hasMore;
          yield* Effect.yieldNow;
        }
        more = true;
        while (more) {
          more = yield* backfillLongMessages(projectId);
          yield* Effect.yieldNow;
        }
        yield* refreshLongMessages(projectId);
        yield* dream(projectId);
      });
      const sourceScopeIsCurrent = sql`CASE WHEN json_valid(r.source_json) THEN (
        json_extract(r.source_json,'$.kind') <> 'knowledge' OR EXISTS (
          SELECT 1 FROM projection_workspace_knowledge_items k
          WHERE k.project_id=r.project_id AND k.item_id=json_extract(r.source_json,'$.id')
            AND k.status='active' AND (
              (r.scope='project' AND k.scope='project') OR
              (r.scope='global' AND k.scope='environment')
            )
        )
      ) ELSE 0 END`;
      const search = Effect.fn("WorkspaceMemory.search")(function* (
        projectId: string,
        query: string,
        limit = 8,
        excludeFromThread?: { readonly threadId: ThreadId; readonly fromRowid: number },
        folder?: string,
      ) {
        const parsed = buildSearchQuery(query);
        if (!parsed) return [];
        const candidateLimit = Math.min(64, Math.max(limit, limit * 8));
        const beforeCurrent = excludeFromThread
          ? sql`CASE WHEN json_valid(r.source_json) THEN (
              json_extract(r.source_json,'$.kind') <> 'message' OR NOT EXISTS (
                SELECT 1 FROM projection_thread_messages m
                WHERE m.message_id=json_extract(r.source_json,'$.id')
                  AND m.thread_id=${excludeFromThread.threadId} AND m.rowid>=${excludeFromThread.fromRowid}
              )
            ) ELSE 0 END`
          : sql`1=1`;
        const inFolder =
          folder === undefined
            ? sql`1=1`
            : sql`(
          r.scope='global' OR (r.project_id=${projectId} AND CASE
            WHEN json_extract(r.source_json,'$.kind')='message' THEN EXISTS (
              SELECT 1 FROM projection_thread_messages m
              JOIN workspace_memory_v2_message_folders f ON f.message_id=(
                SELECT u.message_id FROM projection_thread_messages u
                WHERE u.thread_id=m.thread_id AND u.role='user' AND u.rowid<=m.rowid
                ORDER BY u.rowid DESC LIMIT 1
              )
              WHERE m.message_id=json_extract(r.source_json,'$.id') AND f.project_id=${projectId} AND f.folder=${folder}
            )
            WHEN json_extract(r.source_json,'$.kind')='manual' THEN json_extract(r.source_json,'$.folder')=${folder}
            WHEN json_extract(r.source_json,'$.kind')='knowledge' THEN ${folder}=''
            ELSE 0 END)
        )`;
        const rows =
          yield* sql<RecordRow>`SELECT r.* FROM workspace_memory_v2_fts f JOIN workspace_memory_v2 r ON r.id=f.id
        WHERE workspace_memory_v2_fts MATCH ${parsed.match} AND (r.project_id=${projectId} OR r.scope='global') AND r.status NOT IN ('forgotten','archived')
        AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
        AND ${sourceScopeIsCurrent}
        AND ${beforeCurrent}
        AND ${inFolder}
        ORDER BY bm25(workspace_memory_v2_fts),r.created_at DESC,r.id LIMIT ${candidateLimit}`;
        const chunks = yield* sql<RecordRow & { chunk_text: string }>`
          WITH hits AS MATERIALIZED (
            SELECT r.id AS memory_id,c.rowid AS chunk_rowid,bm25(workspace_memory_v2_chunks) AS score
            FROM workspace_memory_v2_chunks c JOIN workspace_memory_v2 r ON r.id=c.memory_id
            WHERE workspace_memory_v2_chunks MATCH ${parsed.match} AND (r.project_id=${projectId} OR r.scope='global')
            AND r.status NOT IN ('forgotten','archived')
            AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
            AND ${sourceScopeIsCurrent}
            AND ${beforeCurrent}
            AND ${inFolder}
          ), ranked AS (
            SELECT *,row_number() OVER (PARTITION BY memory_id ORDER BY score,chunk_rowid) AS ordinal FROM hits
          )
          SELECT r.*,c.chunk_text FROM ranked h JOIN workspace_memory_v2 r ON r.id=h.memory_id
          JOIN workspace_memory_v2_chunks c ON c.rowid=h.chunk_rowid WHERE h.ordinal=1
          ORDER BY h.score,r.created_at DESC,r.id LIMIT ${candidateLimit}`;
        const candidates = [
          ...rows.map((row, rank) => ({ row, rank })),
          ...chunks.map(({ chunk_text, ...row }, rank) => ({
            row: { ...row, text: chunk_text },
            rank,
          })),
        ].map((candidate) => ({
          ...candidate,
          coverage: termCoverage(parsed.terms, candidate.row.text),
        }));
        candidates.sort((a, b) => b.coverage - a.coverage || a.rank - b.rank);
        const unique = new Map<string, RecordRow>();
        for (const candidate of candidates)
          if (!unique.has(candidate.row.id)) unique.set(candidate.row.id, candidate.row);
        return selectMemoryEvidence(
          [...unique.values()],
          query,
          limit,
          clock.currentTimeMillisUnsafe(),
        );
      });
      const context = Effect.fn("WorkspaceMemory.context")(function* (
        projectId: ProjectId,
        task: string,
        directivesOnly = false,
        current?: {
          readonly threadId: ThreadId;
          readonly messageId: MessageId;
          readonly inheritFolder?: boolean;
          readonly excludeDirectives?: boolean;
          readonly excludeRecentConversation?: boolean;
        },
      ) {
        const settings = yield* checkedProject(projectId);
        const directives = yield* sql<{ project_id: string; item_id: string; content: string }>`
          SELECT k.project_id,k.item_id,k.content FROM projection_workspace_knowledge_items k
          JOIN projection_projects p ON p.project_id=k.project_id
          WHERE p.deleted_at IS NULL AND k.status='active' AND k.origin='user' AND k.kind='directive'
          AND (k.scope='environment' OR (k.project_id=${projectId} AND k.scope='project'))
          ORDER BY k.updated_at,k.project_id,k.item_id`;
        const required =
          current?.excludeDirectives || directives.length === 0
            ? ""
            : [
                "<t3_user_directives>",
                "사용자가 명시한 필수 지침입니다. 공용 지침은 모든 프로젝트에 적용합니다. 검색 관련도와 자동 기억 설정에 관계없이 적용하고, 현재 사용자 지시와 최신 명시적 정정을 우선하세요.",
                ...directives.map(
                  (item) => `[${item.project_id}/${item.item_id}]\n${item.content}`,
                ),
                "</t3_user_directives>",
              ].join("\n\n");
        if (
          directivesOnly ||
          settings.conversationRag?.enabled === false ||
          settings.contextOptimization?.autoChatMemory !== true
        )
          return required;
        type RecentMessage = {
          rowid: number;
          message_id: string;
          role: string;
          text: string;
          created_at: string;
        };
        let recent: ReadonlyArray<RecentMessage> = [];
        let boundaryRowid: number | undefined;
        let currentFolder: string | undefined;
        let hasUnclassifiedHistory = false;
        if (current) {
          yield* checkedThread(projectId, current.threadId);
          const [boundary] = yield* sql<{
            rowid: number;
          }>`SELECT rowid FROM projection_thread_messages WHERE thread_id=${current.threadId} AND message_id=${current.messageId}`;
          if (!boundary) {
            return yield* new WorkspaceMemoryError({
              message: "현재 대화의 메시지 위치를 확인하지 못했습니다.",
            });
          }
          boundaryRowid = boundary.rowid;
          let [selected] = yield* sql<{
            folder: string | null;
          }>`SELECT folder FROM workspace_memory_v2_message_folders
            WHERE message_id=${current.messageId} AND thread_id=${current.threadId} AND project_id=${projectId}`;
          if (!selected && current.inheritFolder) {
            [selected] = yield* sql<{
              folder: string | null;
            }>`SELECT f.folder FROM projection_thread_messages u
              LEFT JOIN workspace_memory_v2_message_folders f ON f.message_id=u.message_id AND f.project_id=${projectId}
              WHERE u.thread_id=${current.threadId} AND u.role='user' AND u.rowid<${boundary.rowid}
              ORDER BY u.rowid DESC LIMIT 1`;
            if (selected?.folder != null)
              yield* sql`INSERT OR IGNORE INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
              SELECT message_id,${projectId},${current.threadId},${selected.folder} FROM projection_thread_messages
              WHERE thread_id=${current.threadId} AND message_id=${current.messageId} AND role='user'`;
          }
          if (!selected || selected.folder === null)
            return [
              required,
              "<t3_folder_memory_unavailable>현재 요청의 대화 기억에 적용할 폴더 범위가 기록되지 않아 이전 대화 기억 검색을 생략했습니다. 폴더가 없다는 뜻은 아닙니다. 기존 기록은 보존되어 있으며 확인되지 않은 기억을 읽었다고 추측하지 마세요.</t3_folder_memory_unavailable>",
            ]
              .filter(Boolean)
              .join("\n\n");
          currentFolder = selected.folder;
          const [unclassified] = yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM projection_thread_messages m
            WHERE m.thread_id=${current.threadId} AND m.role='user' AND m.rowid<${boundary.rowid}
            AND NOT EXISTS(SELECT 1 FROM workspace_memory_v2_message_folders f WHERE f.message_id=m.message_id AND f.project_id=${projectId})`;
          hasUnclassifiedHistory = (unclassified?.count ?? 0) > 0;
          recent =
            current.excludeRecentConversation === true
              ? []
              : yield* sql<RecentMessage>`SELECT m.rowid,m.message_id,m.role,substr(m.text,1,2000) AS text,m.created_at
            FROM projection_thread_messages m WHERE m.thread_id=${current.threadId} AND m.rowid<${boundary.rowid}
            AND m.is_streaming=0 AND length(trim(m.text))>0 AND EXISTS (
              SELECT 1 FROM workspace_memory_v2_message_folders f WHERE f.project_id=${projectId} AND f.folder=${currentFolder}
              AND f.message_id=(SELECT u.message_id FROM projection_thread_messages u WHERE u.thread_id=m.thread_id AND u.role='user' AND u.rowid<=m.rowid ORDER BY u.rowid DESC LIMIT 1)
            ) ORDER BY m.rowid DESC LIMIT 30`;
        }
        let previousUser = recent.find((row) => row.role === "user");
        if (!previousUser && current && boundaryRowid !== undefined && recent.length > 0) {
          [previousUser] =
            yield* sql<RecentMessage>`SELECT m.rowid,m.message_id,m.role,substr(m.text,1,2000) AS text,m.created_at
            FROM projection_thread_messages m WHERE m.thread_id=${current.threadId} AND m.rowid<${boundaryRowid}
            AND m.role='user' AND m.is_streaming=0 AND length(trim(m.text))>0 AND EXISTS (
              SELECT 1 FROM workspace_memory_v2_message_folders f WHERE f.message_id=m.message_id AND f.project_id=${projectId} AND f.folder=${currentFolder ?? ""}
            ) ORDER BY m.rowid DESC LIMIT 1`;
          if (previousUser) recent = [...recent.slice(0, 29), previousUser];
        }
        const query = previousUser ? `${task}\n${previousUser.text}` : task;
        const matches = yield* search(
          projectId,
          query,
          6,
          current && boundaryRowid !== undefined
            ? { threadId: current.threadId, fromRowid: boundaryRowid }
            : undefined,
          currentFolder,
        );
        const terms = buildSearchQuery(query)?.terms ?? [];
        const recentLines: Array<{ rowid: number; text: string }> = [];
        let chars = 0;
        const prioritized = previousUser
          ? [previousUser, ...recent.filter((row) => row.message_id !== previousUser.message_id)]
          : recent;
        for (const row of prioritized) {
          const line = `[${row.role}] [message:${row.message_id}] ${row.created_at}\n${row.text}`;
          if (chars + line.length > 16_000 && recentLines.length > 0) break;
          recentLines.push({ rowid: row.rowid, text: line });
          chars += line.length;
        }
        recentLines.sort((left, right) => left.rowid - right.rowid);
        const recentContext = recentLines.length
          ? `<t3_recent_conversation>\n현재 폴더에서 확인된 같은 대화의 최근 발언 발췌입니다(오래된 순). 현재 사용자 지시와 최신 명시적 정정이 우선이며, 에이전트의 보고는 완료 사실을 검증한 증거가 아닙니다. 필요한 근거는 workspace_memory search/read로 확인하세요.\n${recentLines.map((line) => line.text).join("\n\n")}\n</t3_recent_conversation>`
          : "";
        let body = `<t3_memory_v2>\n과거 근거보다 현재 사용자 지시와 최신 정정이 우선입니다. 에이전트 보고는 미검증입니다. 작업 중 새로 알게 된 식별자나 관련 단서가 더 필요한 경우 workspace_memory search로 해당 키워드를 다시 찾고, 관련성이 확인된 원문만 read로 확인하세요.\n`;
        for (const row of matches) {
          const additional = row.additionalSources
            ? `\n동일 근거 ${row.additionalSources}개 추가 · 조회 ID: ${row.supportingIds?.join(", ")}`
            : "";
          const excerpt = `\n[${row.id}] ${row.topic} · ${row.created_at} · ${row.verification}\n${matchedMemoryExcerpt(row.text, terms, 1200)}\n근거: ${row.source_json}${additional}\n`;
          if (Buffer.byteLength(body + excerpt) > 14_000) break;
          body += excerpt;
        }
        return [
          required,
          hasUnclassifiedHistory
            ? "<t3_folder_history_unclassified>현재 요청의 기억은 기록된 폴더 범위로 조회했습니다. 일부 이전 대화는 당시 폴더가 기록되지 않아 자동 주입에서 제외했습니다. 원문은 보존되며 확인되지 않은 이전 기억을 읽었다고 추측하지 마세요.</t3_folder_history_unclassified>"
            : "",
          recentContext,
          body + "</t3_memory_v2>",
        ]
          .filter(Boolean)
          .join("\n\n");
      });
      const history = Effect.fn("WorkspaceMemory.history")(function* (
        projectId: string,
        threadId: string,
        after = 0,
        query?: string,
        folder?: string,
      ) {
        yield* checkedThread(projectId, threadId);
        const inFolder =
          folder === undefined
            ? sql`1=1`
            : sql`EXISTS (
          SELECT 1 FROM workspace_memory_v2_message_folders f WHERE f.project_id=${projectId} AND f.folder=${folder}
            AND f.message_id=(SELECT u.message_id FROM projection_thread_messages u
              WHERE u.thread_id=m.thread_id AND u.role='user' AND u.rowid<=m.rowid ORDER BY u.rowid DESC LIMIT 1)
        )`;
        const rows =
          yield* sql<MessageRow>`SELECT m.rowid,m.message_id,m.thread_id,m.turn_id,m.role,substr(m.text,1,1200) AS text,length(m.text) AS text_length,m.created_at,m.updated_at FROM projection_thread_messages m
        WHERE m.thread_id=${threadId} AND m.rowid>${after} AND m.is_streaming=0 AND ${query ? sql`instr(lower(m.text),lower(${query}))>0` : sql`1=1`} AND ${inFolder} ORDER BY m.rowid LIMIT 21`;
        const entries = rows.slice(0, 20);
        return {
          entries,
          next: rows.length > 20 ? entries.at(-1)!.rowid : null,
          complete: rows.length <= 20,
          note:
            folder === undefined
              ? "본문은 최대 1,200자 발췌입니다. 긴 원문은 read message:<message_id>와 offset으로 이어서 조회하세요. 활동·도구 원문까지 일관된 스냅샷으로 확인하려면 export를 사용하세요."
              : "현재 폴더가 확인된 메시지만 표시합니다. 다른 폴더와 폴더가 기록되지 않은 과거 기록은 제외했으며 원문은 보존됩니다. 본문은 최대 1,200자이며 긴 원문은 read message:<message_id>와 offset으로 이어서 조회하세요. 전체 대화 export는 사용할 수 없습니다.",
        };
      });
      const read = Effect.fn("WorkspaceMemory.read")(function* (
        projectId: string,
        id: string,
        offset = 0,
        folder?: string,
      ) {
        let source: typeof Source.Type;
        if (id.startsWith("message:") || id.startsWith("activity:")) {
          const [kind, ...rest] = id.split(":");
          source = { kind: kind!, id: rest.join(":"), projectId };
        } else {
          const [record] =
            yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 r WHERE id=${id} AND (project_id=${projectId} OR scope='global') AND status NOT IN ('archived','forgotten') AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL) AND ${sourceScopeIsCurrent}`;
          if (!record)
            return yield* new WorkspaceMemoryError({
              message: "조회 가능한 기억을 찾을 수 없습니다.",
            });
          source = yield* decodeSource(record.source_json);
          if (
            source.kind === "manual" &&
            folder !== undefined &&
            record.scope !== "global" &&
            source.folder !== folder
          )
            return yield* new WorkspaceMemoryError({
              message: "현재 폴더 범위를 확인할 수 없는 기억입니다.",
            });
          if (source.kind === "manual")
            return {
              id,
              text: record.text,
              next: null,
              source: record.source_json,
              verification: record.verification,
            };
          source = { ...source, projectId: record.project_id };
        }
        const sourceProject = source.projectId ?? projectId;
        if (folder !== undefined && source.kind === "message") {
          const [allowed] = yield* sql`SELECT 1 AS allowed FROM projection_thread_messages m
            JOIN workspace_memory_v2_message_folders f ON f.message_id=(SELECT u.message_id FROM projection_thread_messages u
              WHERE u.thread_id=m.thread_id AND u.role='user' AND u.rowid<=m.rowid ORDER BY u.rowid DESC LIMIT 1)
            WHERE m.message_id=${source.id} AND f.project_id=${projectId} AND f.folder=${folder}`;
          if (!allowed)
            return yield* new WorkspaceMemoryError({
              message: "원문의 폴더 범위가 현재 폴더와 다르거나 확인되지 않습니다.",
            });
        }
        if (folder !== undefined && source.kind === "activity")
          return yield* new WorkspaceMemoryError({
            message: "활동 원문의 폴더 범위가 기록되지 않아 조회하지 않았습니다.",
          });
        if (folder !== undefined && source.kind === "knowledge") {
          const [note] = yield* sql<{
            scope: string;
          }>`SELECT scope FROM projection_workspace_knowledge_items
            WHERE item_id=${source.id} AND project_id=${sourceProject} AND status='active'`;
          if (note?.scope !== "environment" && !(folder === "" && note?.scope === "project"))
            return yield* new WorkspaceMemoryError({
              message: "이 원문의 폴더 범위가 확인되지 않아 조회하지 않았습니다.",
            });
        }
        const rows =
          source.kind === "message"
            ? yield* sql<{
                text: string;
                total: number;
              }>`SELECT substr(m.text,${offset + 1},12000) AS text,length(m.text) AS total FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id WHERE m.message_id=${source.id} AND t.project_id=${sourceProject} AND t.deleted_at IS NULL`
            : source.kind === "activity"
              ? yield* sql<{
                  text: string;
                  total: number;
                }>`SELECT substr(a.payload_json,${offset + 1},12000) AS text,length(a.payload_json) AS total FROM projection_thread_activities a JOIN projection_threads t ON t.thread_id=a.thread_id WHERE a.activity_id=${source.id} AND t.project_id=${sourceProject} AND t.deleted_at IS NULL`
              : yield* sql<{
                  text: string;
                  total: number;
                }>`SELECT substr(content,${offset + 1},12000) AS text,length(content) AS total FROM projection_workspace_knowledge_items WHERE item_id=${source.id} AND project_id=${sourceProject} AND status='active' AND (project_id=${projectId} OR scope='environment')`;
        const row = rows[0];
        if (!row)
          return yield* new WorkspaceMemoryError({
            message: "원문이 없거나 현재 프로젝트 범위 밖입니다.",
          });
        return { id, offset, ...row, next: offset + 12000 < row.total ? offset + 12000 : null };
      });
      const exportHistoryUnsafe = Effect.fn("WorkspaceMemory.export")(function* (
        projectId: string,
        threadId: string,
      ) {
        yield* checkedThread(projectId, threadId);
        const archive = yield* Effect.gen(function* () {
          const reader = yield* SqlClient.SqlClient;
          return yield* reader.withTransaction(
            Effect.gen(function* () {
              const iterable = yield* readHistorySource(
                reader,
                threadId,
                {
                  record_type: "header",
                  version: 1,
                  projectId,
                  threadId,
                  exportedAt: now(),
                },
                process.versions.bun === undefined,
              );
              return yield* io((signal) =>
                writeHistoryArchive(
                  NodePath.join(directory(projectId), "sources", memoryHash(threadId)),
                  iterable,
                  signal,
                ),
              );
            }),
          );
        }).pipe(
          Effect.provide(makeRuntimeSqliteLayer({ filename: config.dbPath, readonly: true })),
        );
        yield* io((signal) => verifyHistoryArchive(archive.path, archive.sha256, signal));
        yield* sql`INSERT OR IGNORE INTO workspace_memory_source_archives(sha256,project_id,thread_id,path,records,original_bytes,compressed_bytes,created_at)
        VALUES (${archive.sha256},${projectId},${threadId},${archive.path},${archive.records},${archive.originalBytes},${archive.compressedBytes},${now()})`;
        return archive;
      });
      const exportHistory = (projectId: string, threadId: string) =>
        exportGate.withPermit(exportHistoryUnsafe(projectId, threadId));
      const invokeUnsafe = Effect.fn("WorkspaceMemory.invoke")(function* (
        input: WorkspaceMemoryAction,
        context?: { readonly threadId: ThreadId },
      ) {
        yield* checkedProject(input.projectId);
        let folder: string | undefined;
        if (context && input.action !== "status") {
          yield* checkedThread(input.projectId, context.threadId);
          const [owner] = yield* sql<{
            orchestra_run_thread_id: string | null;
          }>`SELECT orchestra_run_thread_id FROM projection_threads
            WHERE thread_id=${context.threadId} AND project_id=${input.projectId} AND deleted_at IS NULL`;
          const folderThread = owner?.orchestra_run_thread_id ?? context.threadId;
          yield* checkedThread(input.projectId, folderThread);
          const [selected] = yield* sql<{
            folder: string;
          }>`SELECT f.folder FROM projection_thread_messages m
            LEFT JOIN workspace_memory_v2_message_folders f ON f.message_id=m.message_id AND f.project_id=${input.projectId}
            WHERE m.thread_id=${folderThread} AND m.role='user' ORDER BY m.rowid DESC LIMIT 1`;
          if (!selected || selected.folder === null)
            return yield* new WorkspaceMemoryError({
              message:
                "현재 대화의 작업 폴더가 기록되지 않아 기억을 조회하지 않았습니다. 기존 기록은 보존됩니다.",
            });
          folder = selected.folder;
        }
        let result: unknown;
        switch (input.action) {
          case "search": {
            const matches = (yield* search(
              input.projectId,
              input.query,
              input.limit,
              undefined,
              folder,
            )).map((row) => ({
              id: row.id,
              topic: row.topic,
              text: matchedMemoryExcerpt(
                row.text,
                buildSearchQuery(input.query)?.terms ?? [],
                2000,
              ),
              source: row.source_json,
              verification: row.verification,
              createdAt: row.created_at,
              ...(row.additionalSources
                ? { supportingIds: row.supportingIds, additionalSources: row.additionalSources }
                : {}),
            }));
            result =
              folder === undefined
                ? matches
                : {
                    matches,
                    note: "당시 폴더가 기록되지 않은 이전 대화는 제외했습니다. 원문은 보존됩니다.",
                  };
            break;
          }
          case "read":
            result = yield* read(input.projectId, input.id, input.offset, folder);
            break;
          case "history":
            result = yield* history(
              input.projectId,
              input.threadId,
              input.after,
              input.query,
              folder,
            );
            break;
          case "export":
            if (folder !== undefined)
              return yield* new WorkspaceMemoryError({
                message:
                  "전체 대화에는 다른 폴더 또는 범위 미확인 기록이 섞일 수 있어 현재 폴더에서 일괄 내보내지 않았습니다.",
              });
            result = yield* exportHistory(input.projectId, input.threadId);
            break;
          case "backfill":
            result = yield* gate.withPermit(backfill(input.projectId));
            break;
          case "dream":
            result = yield* gate.withPermit(dream(input.projectId));
            break;
          case "remember": {
            if (!input.text.trim() || !input.topic.trim())
              return yield* new WorkspaceMemoryError({ message: "기억 본문과 주제를 입력하세요." });
            const id = memoryHash(`manual:${input.projectId}:${input.requestId}`);
            result = yield* gate.withPermit(
              Effect.gen(function* () {
                const [existing] =
                  yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 WHERE id=${id}`;
                const existingSource = existing
                  ? yield* decodeSource(existing.source_json)
                  : undefined;
                const scopedFolder = input.scope === "global" ? undefined : folder;
                if (
                  existing &&
                  (existing.status === "forgotten" ||
                    existing.text !== input.text ||
                    existing.topic !== input.topic ||
                    existing.scope !== (input.scope ?? "project") ||
                    existingSource?.folder !== scopedFolder)
                )
                  return yield* new WorkspaceMemoryError({
                    message:
                      "같은 requestId에는 같은 기억만 재요청할 수 있습니다. 수정은 새 requestId로 저장하세요.",
                  });
                yield* capture({
                  projectId: input.projectId,
                  id,
                  topic: input.topic,
                  text: input.text,
                  source: {
                    kind: "manual",
                    id: input.requestId,
                    projectId: input.projectId,
                    ...(scopedFolder === undefined ? {} : { folder: scopedFolder }),
                  },
                  origin: "user-requested",
                  verification: "user-requested-note",
                  createdAt: existing?.created_at ?? now(),
                  scope: input.scope,
                  durable: scopedFolder === undefined,
                });
                yield* dream(input.projectId);
                return { id, saved: true };
              }),
            );
            break;
          }
          case "forget":
            if (folder !== undefined) yield* read(input.projectId, input.id, 0, folder);
            result = yield* gate.withPermit(
              Effect.gen(function* () {
                const [record] =
                  yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 WHERE id=${input.id} AND project_id=${input.projectId}`;
                if (!record)
                  return yield* new WorkspaceMemoryError({
                    message: "현재 프로젝트가 소유한 기억만 제외할 수 있습니다.",
                  });
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* dirty(record.project_id, record.scope, record.topic);
                    yield* sql`UPDATE workspace_memory_v2 SET status='forgotten',updated_at=${now()} WHERE id=${input.id}`;
                    yield* sql`DELETE FROM workspace_memory_v2_fts WHERE rowid=(SELECT rowid FROM workspace_memory_v2 WHERE id=${input.id})`;
                    yield* clearChunks(input.id);
                    yield* sql`DELETE FROM workspace_memory_v2_chunk_state WHERE memory_id=${input.id}`;
                  }),
                );
                yield* io(() =>
                  archiveMemoryFile(inbox(record.project_id, record.scope, record.id)),
                );
                yield* dream(input.projectId);
                return { id: input.id, forgotten: true, sourceHistoryPreserved: true };
              }),
            );
            break;
          case "status":
            result = {
              version: 2,
              directory: directory(input.projectId),
              manifestBytes: MANIFEST_BYTES,
              counts:
                yield* sql`SELECT status,verification,count(*) AS total FROM workspace_memory_v2 WHERE project_id=${input.projectId} GROUP BY status,verification`,
              progress:
                yield* sql`SELECT * FROM workspace_memory_v2_progress WHERE stream_key=${`messages:${input.projectId}`}`,
              semanticIndexing:
                yield* sql`SELECT count(*) AS pendingJobs,coalesce(sum(failures>0),0) AS retryingJobs
                  FROM workspace_semantic_index_jobs WHERE project_id=${input.projectId}`,
            };
            break;
        }
        return encodeJson(result);
      });
      const handoff = Effect.fn("WorkspaceMemory.handoff")(function* (
        projectId: ProjectId,
        threadId: ThreadId,
        messageId: MessageId,
        archive: boolean,
      ) {
        yield* checkedThread(projectId, threadId);
        const [boundary] = yield* sql<{
          rowid: number;
        }>`SELECT rowid FROM projection_thread_messages WHERE thread_id=${threadId} AND message_id=${messageId}`;
        if (!boundary) return undefined;
        const [selected] = yield* sql<{
          folder: string;
        }>`SELECT folder FROM workspace_memory_v2_message_folders
          WHERE message_id=${messageId} AND thread_id=${threadId} AND project_id=${projectId}`;
        if (!selected)
          return "<t3_folder_memory_unavailable>현재 요청의 대화 기억에 적용할 폴더 범위가 기록되지 않아 이전 대화 인계를 생략했습니다. 폴더가 없다는 뜻은 아니며 기존 원문은 보존됩니다.</t3_folder_memory_unavailable>";
        const recent = yield* sql<{
          role: string;
          text: string;
        }>`SELECT m.role,substr(m.text,1,2000) AS text FROM projection_thread_messages m
        WHERE m.thread_id=${threadId} AND m.rowid<${boundary.rowid} AND m.is_streaming=0 AND length(trim(m.text))>0
        AND EXISTS (SELECT 1 FROM workspace_memory_v2_message_folders f WHERE f.project_id=${projectId} AND f.folder=${selected.folder}
          AND f.message_id=(SELECT u.message_id FROM projection_thread_messages u WHERE u.thread_id=m.thread_id AND u.role='user' AND u.rowid<=m.rowid ORDER BY u.rowid DESC LIMIT 1))
        ORDER BY m.rowid DESC LIMIT 30`;
        const [mismatch] = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM projection_thread_messages m
          LEFT JOIN workspace_memory_v2_message_folders f ON f.message_id=m.message_id AND f.project_id=${projectId}
          WHERE m.thread_id=${threadId} AND m.role='user' AND (f.folder IS NULL OR f.folder<>${selected.folder})`;
        if (!recent.length && (mismatch?.count ?? 0) === 0) return undefined;
        const lines: string[] = [];
        let chars = 0;
        for (const row of recent) {
          const line = `[${row.role}] ${row.text}`;
          if (chars + line.length > 16000 && lines.length) break;
          lines.push(line);
          chars += line.length;
        }
        let evidence =
          (mismatch?.count ?? 0) > 0
            ? "다른 폴더 또는 폴더 미확인 대화는 인계에서 제외했습니다. 원문은 보존됩니다."
            : "현재 폴더에서 필요한 기억은 workspace_memory search/read로 확인하세요.";
        if (archive && (mismatch?.count ?? 0) === 0) {
          const result = yield* exportHistory(projectId, threadId).pipe(Effect.result);
          if (result._tag === "Success")
            evidence += `\n원문 스냅샷: ${result.success.path}; gzip NDJSON; SHA-256(압축 해제 내용): ${result.success.sha256}; ${result.success.records}개 레코드. 스트리밍·현재 요청은 완료된 과거 답변으로 해석하지 마세요.`;
          else
            yield* Effect.logWarning(
              "Could not prepare full handoff archive; original history remains available through workspace_memory",
              { cause: result.failure },
            );
        }
        return `<t3_conversation_handoff>\n다른 모델에서 이어받은 현재 폴더의 최근 대화 발췌입니다(오래된 순). 새 사용자 메시지에 이어서 답하세요. 과거 기록은 현재 지시보다 우선하지 않으며 에이전트 보고는 미검증입니다. 필요한 결정·실패 근거가 없으면 workspace_memory search/read로 추가 조회하세요.\n${lines.toReversed().join("\n")}\n${evidence}\n</t3_conversation_handoff>`;
      });
      return WorkspaceMemory.of({
        invoke: (input, context) => safe(invokeUnsafe(input, context)),
        context: (projectId, task, directivesOnly, current) =>
          safe(context(projectId, task, directivesOnly, current)),
        contextPaths: (input) => safe(contextPaths(input)),
        reconcile: (projectId) => safe(gate.withPermit(reconcileUnsafe(projectId))),
        handoff: (projectId, threadId, messageId, archive) =>
          safe(handoff(projectId, threadId, messageId, archive)),
      });
    }),
  );
}
