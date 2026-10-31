// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, MessageId, type WorkspaceMemoryAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { layerConfig as sqlite } from "../persistence/Layers/Sqlite.ts";
import { ServerConfig, layerTest } from "../config.ts";
import { WorkspaceMemory } from "./WorkspaceMemory.ts";
import { memoryHash, memoryScopeDirectory } from "./memoryFiles.ts";
import { readHistorySource } from "../persistence/historySource.ts";
import { analyzeSearchText } from "../persistence/searchText.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeId = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }));
const decodePart = Schema.decodeUnknownEffect(
  Schema.Struct({ text: Schema.String, next: Schema.NullOr(Schema.Number) }),
);
const decodeArchive = Schema.decodeUnknownEffect(
  Schema.Struct({ path: Schema.String, sha256: Schema.String, records: Schema.Number }),
);
const decodePage = Schema.decodeUnknownEffect(
  Schema.Struct({
    entries: Schema.Array(Schema.Struct({ message_id: Schema.String })),
    next: Schema.NullOr(Schema.Number),
    complete: Schema.Boolean,
  }),
);
const layer = WorkspaceMemory.layer.pipe(
  Layer.provideMerge(sqlite),
  Layer.provideMerge(layerTest("/tmp", { prefix: "memory-v2-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const at = "2026-10-19T00:00:00.000Z";
const seed = Effect.fn(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,workspace_control_json) VALUES (${id},${id},'/tmp','[]',${at},${at},'{"conversationRag":{"enabled":true},"contextOptimization":{"autoChatMemory":true}}')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES (${`t-${id}`},${id},'Test',${at},${at})`;
  return ProjectId.make(id);
});
const invoke = Effect.fn(function* (input: WorkspaceMemoryAction) {
  const memory = yield* WorkspaceMemory;
  return decode(yield* memory.invoke(input));
});
const remember = (
  id: ProjectId,
  requestId: string,
  text: string,
  scope: "project" | "global" = "project",
) => invoke({ projectId: id, action: "remember", requestId, topic: "규칙", text, scope });

it.layer(layer)("WorkspaceMemory v2", (it) => {
  it.effect("returns matching passages instead of unrelated memory catalog entries", () =>
    Effect.gen(function* () {
      const id = yield* seed("matching-excerpts");
      const memory = yield* WorkspaceMemory;
      const note = yield* remember(id, "long-note", `${"prefix ".repeat(300)}TAILFACTONLYALPHA`);
      yield* memory.invoke({
        projectId: id,
        action: "remember",
        requestId: "unrelated-note",
        topic: "UNRELATED_ARCHITECTURE_TOPIC",
        text: "An unrelated subject with no shared keywords.",
      });
      const found = yield* invoke({ projectId: id, action: "search", query: "TAILFACTONLYALPHA" });
      expect(found).toEqual([
        expect.objectContaining({ text: expect.stringContaining("TAILFACTONLYALPHA") }),
      ]);
      const context = yield* memory.context(id, "TAILFACTONLYALPHA");
      expect(context).toContain("TAILFACTONLYALPHA");
      expect(context).toContain("workspace_memory search");
      expect(context).not.toContain("UNRELATED_ARCHITECTURE_TOPIC");
      const source = yield* invoke({
        projectId: id,
        action: "read",
        id: (yield* decodeId(note)).id,
      });
      expect(source).toMatchObject({ text: expect.stringContaining("TAILFACTONLYALPHA") });
    }),
  );

  it.effect(
    "includes the prior turn for follow-ups without leaking future or foreign messages",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("recent-follow-up"),
          other = yield* seed("recent-other-project"),
          sql = yield* SqlClient.SqlClient,
          memory = yield* WorkspaceMemory;
        yield* remember(id, "related", "SILVERWRENCH_DEPLOYMENT requires preserving the setting.");
        yield* remember(other, "private", "SILVERWRENCH_DEPLOYMENT PRIVATE_OTHER_PROJECT");
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('recent-user',${`t-${id}`},'user','SILVERWRENCH_DEPLOYMENT 작업을 수정해',0,'2026-10-19T00:00:01.000Z',${at}),
        ('recent-assistant',${`t-${id}`},'assistant','확인한 사항은 아직 검증 중입니다.',0,'2026-10-19T00:00:02.000Z',${at}),
        ('recent-current',${`t-${id}`},'user','계속해 CURRENT_REQUEST_ONLY',0,'2026-10-19T00:00:03.000Z',${at}),
        ('recent-future',${`t-${id}`},'user','SILVERWRENCH_DEPLOYMENT FUTURE_MESSAGE_ONLY',0,'2026-10-19T00:00:04.000Z',${at})`;
        yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<64)
        INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        SELECT 'recent-future-extra-'||x,${`t-${id}`},'user','SILVERWRENCH_DEPLOYMENT FUTURE_MESSAGE_ONLY '||x,0,'2026-10-19T00:00:05.000Z',${at} FROM n`;
        yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
          VALUES ('recent-user',${id},${`t-${id}`},''),('recent-current',${id},${`t-${id}`},'')`;
        yield* memory.reconcile(id);
        const context = yield* memory.context(id, "계속해 CURRENT_REQUEST_ONLY", false, {
          threadId: ThreadId.make(`t-${id}`),
          messageId: MessageId.make("recent-current"),
        });
        expect(context).toContain("<t3_recent_conversation>");
        expect(context).toContain("[message:recent-user]");
        expect(context).toContain("[message:recent-assistant]");
        expect(context.indexOf("[message:recent-user]")).toBeLessThan(
          context.indexOf("[message:recent-assistant]"),
        );
        expect(context).not.toContain("preserving the setting");
        expect(context).not.toContain("CURRENT_REQUEST_ONLY");
        expect(context).not.toContain("FUTURE_MESSAGE_ONLY");
        expect(context).not.toContain("PRIVATE_OTHER_PROJECT");
        expect(context).toContain("에이전트의 보고는 완료 사실을 검증한 증거가 아닙니다");
      }),
  );

  it.effect("retains the last user request within the approved recent-history limits", () =>
    Effect.gen(function* () {
      const id = yield* seed("recent-user-priority"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('priority-prior',${`t-${id}`},'user','KEEP_THE_ORIGINAL_REQUEST',0,'2026-10-19T00:00:01.000Z',${at})`;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<35)
        INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        SELECT 'priority-assistant-'||x,${`t-${id}`},'assistant',printf('%02500d',x),0,'2026-10-19T00:00:02.000Z',${at} FROM n`;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('priority-current',${`t-${id}`},'user','계속해',0,'2026-10-19T00:00:03.000Z',${at})`;
      yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
        VALUES ('priority-prior',${id},${`t-${id}`},''),('priority-current',${id},${`t-${id}`},'')`;
      const context = yield* memory.context(id, "계속해", false, {
        threadId: ThreadId.make(`t-${id}`),
        messageId: MessageId.make("priority-current"),
      });
      const block = context
        .split("<t3_recent_conversation>")[1]
        ?.split("</t3_recent_conversation>")[0];
      expect(block).toContain("KEEP_THE_ORIGINAL_REQUEST");
      expect((block?.match(/\[message:/g) ?? []).length).toBeLessThanOrEqual(30);
      expect(block?.length).toBeLessThan(16_500);
      expect(block).not.toContain("0".repeat(2_001));
    }),
  );

  it.effect("does not add recent history when automatic chat memory is disabled", () =>
    Effect.gen(function* () {
      const id = yield* seed("recent-disabled"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('disabled-prior',${`t-${id}`},'user','DISABLED_PREVIOUS_REQUEST',0,${at},${at}),
        ('disabled-current',${`t-${id}`},'user','다음',0,${at},${at})`;
      yield* sql`UPDATE projection_projects SET workspace_control_json='{"conversationRag":{"enabled":true},"contextOptimization":{"autoChatMemory":false}}' WHERE project_id=${id}`;
      const context = yield* memory.context(id, "다음", false, {
        threadId: ThreadId.make(`t-${id}`),
        messageId: MessageId.make("disabled-current"),
      });
      expect(context).not.toContain("DISABLED_PREVIOUS_REQUEST");
      expect(context).not.toContain("<t3_recent_conversation>");
    }),
  );

  it.effect("reports an unavailable current message instead of searching future history", () =>
    Effect.gen(function* () {
      const id = yield* seed("missing-boundary"),
        memory = yield* WorkspaceMemory;
      const error = yield* memory
        .context(id, "계속해", false, {
          threadId: ThreadId.make(`t-${id}`),
          messageId: MessageId.make("missing-message"),
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("메시지 위치");
    }),
  );

  it.effect("keeps the explicitly selected folder across follow-ups and reverts", () =>
    Effect.gen(function* () {
      const id = yield* seed("selected-folder"),
        sql = yield* SqlClient.SqlClient,
        fs = yield* FileSystem.FileSystem,
        memory = yield* WorkspaceMemory;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "memory-folder-context-" });
      yield* fs.makeDirectory(`${root}/apps/web`, { recursive: true });
      yield* fs.makeDirectory(`${root}/apps/server`, { recursive: true });
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('folder-web',${`t-${id}`},'user','[web](apps/web) 작업을 진행해',0,${at},${at})`;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<40)
        INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        SELECT 'folder-followup-'||x,${`t-${id}`},'user','계속해',0,${at},${at} FROM n`;
      const resolve = (message: string, recordCurrent = false) =>
        memory.contextPaths({
          projectId: id,
          threadId: ThreadId.make(`t-${id}`),
          messageId: MessageId.make(message),
          cwd: root,
          recordCurrent,
        });
      expect(yield* resolve("folder-web", true)).toEqual(["apps/web"]);
      expect(yield* resolve("folder-followup-40")).toEqual(["apps/web"]);
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('folder-server',${`t-${id}`},'user','[server](apps/server) 작업을 진행해',0,${at},${at})`;
      expect(yield* resolve("folder-server", true)).toEqual(["apps/server"]);
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('folder-ambiguous',${`t-${id}`},'user','[web](apps/web) [server](apps/server) 비교',0,${at},${at})`;
      expect(yield* resolve("folder-ambiguous", true)).toEqual(["apps/server"]);
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('folder-after-ambiguous',${`t-${id}`},'user','계속해',0,${at},${at})`;
      expect(yield* resolve("folder-after-ambiguous", true)).toEqual(["apps/server"]);
      yield* sql`DELETE FROM projection_thread_messages WHERE message_id IN ('folder-server','folder-ambiguous','folder-after-ambiguous')`;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('folder-reverted',${`t-${id}`},'user','@"../outside" 계속해',0,${at},${at})`;
      expect(yield* resolve("folder-reverted")).toEqual(["apps/web"]);
    }),
  );

  it.effect("reports an ambiguous folder when no previous folder was confirmed", () =>
    Effect.gen(function* () {
      const id = yield* seed("folder-unknown-choice");
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const memory = yield* WorkspaceMemory;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "memory-folder-choice-" });
      yield* fs.makeDirectory(`${root}/apps/web`, { recursive: true });
      yield* fs.makeDirectory(`${root}/apps/server`, { recursive: true });
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('folder-unknown-choice',${`t-${id}`},'user','[web](apps/web) [server](apps/server) 비교',0,${at},${at})`;
      const error = yield* memory
        .contextPaths({
          projectId: id,
          threadId: ThreadId.make(`t-${id}`),
          messageId: MessageId.make("folder-unknown-choice"),
          cwd: root,
          recordCurrent: true,
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("이전에 확인한 폴더를 찾지 못했습니다");
    }),
  );

  it.effect(
    "keeps newly recorded conversation memory inside its folder and preserves unclassified history",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("folder-conversation");
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const memory = yield* WorkspaceMemory;
        const threadId = ThreadId.make(`t-${id}`);
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "memory-folder-scope-" });
        yield* fs.makeDirectory(`${root}/apps/web`, { recursive: true });
        yield* fs.makeDirectory(`${root}/apps/server`, { recursive: true });
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('folder-old',${threadId},'user','SCOPE_CANARY OLD_UNCLASSIFIED',0,${at},${at}),
        ('folder-web-user',${threadId},'user','[web](apps/web) SCOPE_CANARY WEB_ONLY',0,${at},${at}),
        ('folder-web-answer',${threadId},'assistant','SCOPE_CANARY WEB_ANSWER',0,${at},${at}),
        ('folder-server-user',${threadId},'user','[server](apps/server) SCOPE_CANARY SERVER_ONLY',0,${at},${at}),
        ('folder-server-answer',${threadId},'assistant','SCOPE_CANARY SERVER_ANSWER',0,${at},${at}),
        ('folder-web-current',${threadId},'user','[web](apps/web) SCOPE_CANARY 계속해',0,${at},${at})`;
        const rootThread = ThreadId.make(`root-${id}`);
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES (${rootThread},${id},'Root',${at},${at})`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('folder-root-user',${rootThread},'user','프로젝트 루트에서 계속',0,${at},${at})`;
        yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at,scope)
          VALUES (${id},'root-knowledge','prompt','루트 자료','ROOT_KNOWLEDGE_SCOPE 확인된 프로젝트 자료','active','user',${at},${at},'project')`;
        yield* memory.contextPaths({
          projectId: id,
          threadId: rootThread,
          messageId: MessageId.make("folder-root-user"),
          cwd: root,
          recordCurrent: true,
        });
        for (const messageId of ["folder-web-user", "folder-server-user", "folder-web-current"]) {
          yield* memory.contextPaths({
            projectId: id,
            threadId,
            messageId: MessageId.make(messageId),
            cwd: root,
            recordCurrent: true,
          });
        }
        const shared = yield* remember(id, "folder-shared", "SCOPE_CANARY GLOBAL_SHARED", "global");
        yield* memory.reconcile(id);
        const rootMatches = decode(
          yield* memory.invoke(
            { projectId: id, action: "search", query: "ROOT_KNOWLEDGE_SCOPE" },
            { threadId: rootThread },
          ),
        );
        expect(encode(rootMatches)).toContain("확인된 프로젝트 자료");
        const nestedMatches = decode(
          yield* memory.invoke(
            { projectId: id, action: "search", query: "ROOT_KNOWLEDGE_SCOPE" },
            { threadId },
          ),
        );
        expect(encode(nestedMatches)).not.toContain("확인된 프로젝트 자료");
        const rootKnowledgeId = memoryHash(`knowledge:${id}:root-knowledge`);
        const rootRead = decode(
          yield* memory.invoke(
            { projectId: id, action: "read", id: rootKnowledgeId },
            { threadId: rootThread },
          ),
        );
        expect(encode(rootRead)).toContain("확인된 프로젝트 자료");
        const nestedRead = yield* memory
          .invoke({ projectId: id, action: "read", id: rootKnowledgeId }, { threadId })
          .pipe(Effect.flip);
        expect(nestedRead.message).toContain("폴더 범위");
        const context = yield* memory.context(id, "SCOPE_CANARY 계속해", false, {
          threadId,
          messageId: MessageId.make("folder-web-current"),
        });
        expect(context).toContain("WEB_ONLY");
        expect(context).toContain("WEB_ANSWER");
        expect(context).not.toContain("SERVER_ONLY");
        expect(context).not.toContain("SERVER_ANSWER");
        expect(context).not.toContain("OLD_UNCLASSIFIED");
        expect(context).toContain("<t3_folder_history_unclassified>");
        expect(context).not.toContain("<t3_folder_memory_unavailable>");
        const matches = decode(
          yield* memory.invoke(
            { projectId: id, action: "search", query: "SCOPE_CANARY" },
            { threadId },
          ),
        );
        expect(encode(matches)).toContain("WEB_ONLY");
        expect(encode(matches)).not.toContain("SERVER_ONLY");
        expect(encode(matches)).not.toContain("OLD_UNCLASSIFIED");
        expect(encode(matches)).toContain("GLOBAL_SHARED");
        const sharedId = (yield* decodeId(shared)).id;
        const sharedRead = decode(
          yield* memory.invoke({ projectId: id, action: "read", id: sharedId }, { threadId }),
        );
        expect(encode(sharedRead)).toContain("GLOBAL_SHARED");
        const scoped = decode(
          yield* memory.invoke(
            {
              projectId: id,
              action: "remember",
              requestId: "scoped-note",
              topic: "folder note",
              text: "SCOPED_NOTE WEB_PRIVATE",
            },
            { threadId },
          ),
        );
        const scopedId = (yield* decodeId(scoped)).id;
        expect(
          encode(
            decode(
              yield* memory.invoke(
                { projectId: id, action: "search", query: "SCOPED_NOTE" },
                { threadId },
              ),
            ),
          ),
        ).toContain("WEB_PRIVATE");
        const serverThread = ThreadId.make(`server-${id}`);
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES (${serverThread},${id},'Server',${at},${at})`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('folder-server-second',${serverThread},'user','[server](apps/server) 검색',0,${at},${at})`;
        yield* memory.contextPaths({
          projectId: id,
          threadId: serverThread,
          messageId: MessageId.make("folder-server-second"),
          cwd: root,
          recordCurrent: true,
        });
        const serverMatches = decode(
          yield* memory.invoke(
            { projectId: id, action: "search", query: "SCOPED_NOTE" },
            { threadId: serverThread },
          ),
        );
        expect(encode(serverMatches)).not.toContain("WEB_PRIVATE");
        const serverRead = yield* memory
          .invoke({ projectId: id, action: "read", id: scopedId }, { threadId: serverThread })
          .pipe(Effect.flip);
        expect(serverRead.message).toContain("폴더 범위");
        const denied = yield* memory
          .invoke({ projectId: id, action: "read", id: "message:folder-server-user" }, { threadId })
          .pipe(Effect.flip);
        expect(denied.message).toContain("폴더 범위");
        const legacy = yield* memory
          .invoke({ projectId: id, action: "read", id: "message:folder-old" }, { threadId })
          .pipe(Effect.flip);
        expect(legacy.message).toContain("폴더 범위");
        const original = yield* decodePart(
          decode(yield* memory.invoke({ projectId: id, action: "read", id: "message:folder-old" })),
        );
        expect(original.text).toContain("OLD_UNCLASSIFIED");
        const handoff = yield* memory.handoff(
          id,
          threadId,
          MessageId.make("folder-web-current"),
          true,
        );
        expect(handoff).toContain("WEB_ONLY");
        expect(handoff).not.toContain("SERVER_ONLY");
        expect(handoff).not.toContain("OLD_UNCLASSIFIED");
        expect(handoff).toContain("다른 폴더 또는 폴더 미확인");
        expect(handoff).not.toContain("원문 스냅샷:");
        yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<23)
          INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
          SELECT 'folder-page-'||x,${threadId},'assistant','same folder page '||x,0,${at},${at} FROM n`;
        const firstHistoryRaw = decode(
          yield* memory.invoke({ projectId: id, action: "history", threadId }, { threadId }),
        );
        const firstHistory = yield* decodePage(firstHistoryRaw);
        expect(firstHistory.entries).toHaveLength(20);
        expect(firstHistory.complete).toBe(false);
        expect(encode(firstHistoryRaw)).toContain("폴더가 기록되지 않은 과거 기록은 제외");
        expect(encode(firstHistoryRaw)).not.toContain("SERVER_ONLY");
        expect(encode(firstHistoryRaw)).not.toContain("OLD_UNCLASSIFIED");
        const secondHistoryRaw = decode(
          yield* memory.invoke(
            { projectId: id, action: "history", threadId, after: firstHistory.next! },
            { threadId },
          ),
        );
        const secondHistory = yield* decodePage(secondHistoryRaw);
        expect(secondHistory.complete).toBe(true);
        expect(secondHistory.entries.length).toBeGreaterThan(0);
        expect(encode(secondHistoryRaw)).not.toContain("SERVER_ONLY");
        const filteredHistory = decode(
          yield* memory.invoke(
            { projectId: id, action: "history", threadId, query: "WEB_ONLY" },
            { threadId },
          ),
        );
        expect(encode(filteredHistory)).toContain("folder-web-user");
        expect(encode(filteredHistory)).not.toContain("folder-server-user");
        const deniedExport = yield* memory
          .invoke({ projectId: id, action: "export", threadId }, { threadId })
          .pipe(Effect.flip);
        expect(deniedExport.message).toContain("내보내지 않았습니다");
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
          VALUES ('folder-auto',${threadId},'user','자동으로 이어서 SCOPE_CANARY',0,${at},${at})`;
        const automated = yield* memory.context(id, "SCOPE_CANARY", false, {
          threadId,
          messageId: MessageId.make("folder-auto"),
          inheritFolder: true,
        });
        expect(automated).toContain("WEB_ONLY");
        expect(automated).not.toContain("SERVER_ONLY");
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
          VALUES ('folder-unknown',${threadId},'user','UNKNOWN_SCOPE',0,${at},${at}),('folder-auto-unknown',${threadId},'user','자동으로 이어서',0,${at},${at})`;
        const uncertain = yield* memory.context(id, "SCOPE_CANARY", false, {
          threadId,
          messageId: MessageId.make("folder-auto-unknown"),
          inheritFolder: true,
        });
        expect(uncertain).toContain("<t3_folder_memory_unavailable>");
        expect(uncertain).not.toContain("WEB_ONLY");
        yield* memory.invoke({ projectId: id, action: "forget", id: sharedId });
      }),
  );

  it.effect("lets a new keyword from one result find the next relevant source", () =>
    Effect.gen(function* () {
      const id = yield* seed("keyword-chain");
      yield* remember(id, "bridge", "INITIAL_CONCEPT points to WORKSPACE_BRIDGE.");
      yield* remember(id, "detail", "WORKSPACE_BRIDGE contains the needed decision.");
      yield* remember(id, "unrelated", "UNRELATED_ONLY is a different subject.");
      const first = yield* invoke({ projectId: id, action: "search", query: "INITIAL_CONCEPT" });
      expect(first).toEqual([
        expect.objectContaining({ text: expect.stringContaining("WORKSPACE_BRIDGE") }),
      ]);
      const second = yield* invoke({ projectId: id, action: "search", query: "WORKSPACE_BRIDGE" });
      expect(second).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("needed decision") }),
        ]),
      );
      expect(second).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("UNRELATED_ONLY") }),
        ]),
      );
    }),
  );

  it.effect("backfills old long messages and keeps forgotten chunks excluded", () =>
    Effect.gen(function* () {
      const id = yield* seed("long-backfill"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      const body = `${"prefix ".repeat(1400)}LATEUSERFACTOMEGA ${"more ".repeat(1900)}FARTHERFACTZETA`;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('long-backfill-message',${`t-${id}`},'user',${body},0,${at},${at})`;
      yield* memory.reconcile(id);
      const memoryId = memoryHash("message:long-backfill-message");
      yield* sql`DELETE FROM workspace_memory_v2_chunks WHERE memory_id=${memoryId}`;
      yield* sql`DELETE FROM workspace_memory_v2_chunk_state WHERE memory_id=${memoryId}`;
      yield* sql`DELETE FROM workspace_memory_v2_progress WHERE stream_key=${`long-messages:${id}`}`;
      expect(
        yield* invoke({ projectId: id, action: "search", query: "LATEUSERFACTOMEGA" }),
      ).toEqual([]);
      yield* memory.reconcile(id);
      const found = yield* invoke({ projectId: id, action: "search", query: "LATEUSERFACTOMEGA" });
      expect(found).toEqual([
        expect.objectContaining({
          id: memoryId,
          text: expect.stringContaining("LATEUSERFACTOMEGA"),
        }),
      ]);
      expect(yield* memory.context(id, "FARTHERFACTZETA")).toContain("FARTHERFACTZETA");
      yield* invoke({ projectId: id, action: "forget", id: memoryId });
      yield* memory.reconcile(id);
      expect(
        yield* invoke({ projectId: id, action: "search", query: "LATEUSERFACTOMEGA" }),
      ).toEqual([]);
      expect(
        yield* invoke({ projectId: id, action: "read", id: "message:long-backfill-message" }),
      ).toMatchObject({
        text: expect.stringContaining("LATEUSERFACTOMEGA"),
      });
    }),
  );

  it.effect("does not let repeated chunks from one source hide another source", () =>
    Effect.gen(function* () {
      const id = yield* seed("chunk-diversity"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      const prefix = "prefix ".repeat(1200);
      const first = `${prefix}${"routecanary ".repeat(6000)}`;
      const second = `${prefix}routecanary second source`;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('diverse-first',${`t-${id}`},'user',${first},0,${at},${at}),
        ('diverse-second',${`t-${id}`},'user',${second},0,${at},${at})`;
      yield* memory.reconcile(id);
      const found = yield* invoke({ projectId: id, action: "search", query: "routecanary" });
      expect(found).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: memoryHash("message:diverse-first") }),
          expect.objectContaining({ id: memoryHash("message:diverse-second") }),
        ]),
      );
      expect(found).toHaveLength(2);
    }),
  );

  it.effect("repairs old truncated Unicode excerpts without discarding their sources", () =>
    Effect.gen(function* () {
      const id = yield* seed("unicode-backfill"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      const body = `${"😀".repeat(4500)}UNICODETAILMARKER`;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('unicode-backfill-message',${`t-${id}`},'user',${body},0,${at},${at})`;
      yield* memory.reconcile(id);
      const memoryId = memoryHash("message:unicode-backfill-message");
      const oldExcerpt = body.slice(0, 8000);
      yield* sql`UPDATE workspace_memory_v2 SET text=${oldExcerpt} WHERE id=${memoryId}`;
      yield* sql`UPDATE workspace_memory_v2_fts SET content=${analyzeSearchText(oldExcerpt)} WHERE id=${memoryId}`;
      yield* sql`DELETE FROM workspace_memory_v2_progress WHERE stream_key=${`long-messages:${id}`}`;
      expect(
        yield* invoke({ projectId: id, action: "search", query: "UNICODETAILMARKER" }),
      ).toEqual([]);
      yield* memory.reconcile(id);
      expect(
        yield* invoke({ projectId: id, action: "search", query: "UNICODETAILMARKER" }),
      ).toEqual([expect.objectContaining({ text: expect.stringContaining("UNICODETAILMARKER") })]);
    }),
  );

  it.effect("refreshes long knowledge sources when their scope or contents change", () =>
    Effect.gen(function* () {
      const owner = yield* seed("long-knowledge-owner"),
        other = yield* seed("long-knowledge-other");
      const sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      const body = `${"prefix ".repeat(1300)}LONGKNOWLEDGEFACT`;
      yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at,scope) VALUES (${owner},'long-note','long-term-memory','Long note',${body},'active','user',${at},${at},'project')`;
      yield* memory.reconcile(owner);
      expect(
        yield* invoke({ projectId: owner, action: "search", query: "LONGKNOWLEDGEFACT" }),
      ).toEqual([expect.objectContaining({ text: expect.stringContaining("LONGKNOWLEDGEFACT") })]);
      expect(
        yield* invoke({ projectId: other, action: "search", query: "LONGKNOWLEDGEFACT" }),
      ).toEqual([]);
      yield* sql`UPDATE projection_workspace_knowledge_items SET content='short revised note',updated_at='2026-10-20T00:00:00.000Z' WHERE project_id=${owner} AND item_id='long-note'`;
      yield* memory.reconcile(owner);
      expect(
        yield* invoke({ projectId: owner, action: "search", query: "LONGKNOWLEDGEFACT" }),
      ).toEqual([]);
    }),
  );
  it.effect(
    "always includes explicit shared user directives without retrieving other projects' history",
    () =>
      Effect.gen(function* () {
        const a = yield* seed("directive-owner"),
          b = yield* seed("directive-recipient"),
          sql = yield* SqlClient.SqlClient,
          memory = yield* WorkspaceMemory;
        yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at,scope) VALUES
        (${a},'shared-rule','directive','사용자 필수 지침','화면 탈취 절대 금지. 백그라운드 검증만 허용.','active','user',${at},${at},'environment'),
        (${a},'private-rule','directive','비공개 지침','PRIVATE_DIRECTIVE','active','user',${at},${at},'project'),
        (${a},'agent-rule','directive','에이전트 보고','AGENT_DIRECTIVE','active','agent',${at},${at},'environment'),
        (${a},'archived-rule','directive','폐기된 지침','ARCHIVED_DIRECTIVE','archived','user',${at},${at},'environment')`;
        yield* sql`UPDATE projection_projects SET workspace_control_json='{"conversationRag":{"enabled":false},"contextOptimization":{"autoChatMemory":false}}' WHERE project_id=${b}`;
        const context = yield* memory.context(b, "아무 관계 없는 산술 질문");
        expect(context).toContain("화면 탈취 절대 금지");
        expect(context).not.toContain("PRIVATE_DIRECTIVE");
        expect(context).not.toContain("AGENT_DIRECTIVE");
        expect(context).not.toContain("ARCHIVED_DIRECTIVE");
        expect(context).not.toContain("<t3_memory_v2>");
        expect(yield* memory.context(b, "자동화 요청", true)).toBe(context);
        yield* sql`UPDATE projection_workspace_knowledge_items SET status='archived' WHERE project_id=${a} AND item_id='shared-rule'`;
        expect(yield* memory.context(b, "다음 요청")).toBe("");
      }),
  );

  it.effect(
    "reads complete scoped source pages when the runtime adapter does not support streams",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("paged-source"),
          sql = yield* SqlClient.SqlClient;
        yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<31) INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) SELECT 'paged-source-'||x,${`t-${id}`},'user','한글 😀 source '||x,0,${at},${at} FROM n`;
        const records = yield* sql.withTransaction(
          Effect.gen(function* () {
            const iterable = yield* readHistorySource(
              sql,
              `t-${id}`,
              { record_type: "header", projectId: id },
              false,
            );
            return yield* Effect.promise(async () => {
              const result: Readonly<Record<string, unknown>>[] = [];
              for await (const row of iterable) result.push(row);
              return result;
            });
          }),
        );
        expect(records).toHaveLength(32);
        expect(records[0]).toMatchObject({ ordering: "source-rowid" });
        expect(records.slice(1).map((row) => row.text)).toEqual(
          Array.from({ length: 31 }, (_, index) => `한글 😀 source ${index + 1}`),
        );
        expect(records.every((row) => !("__archiveRowId" in row))).toBe(true);
      }),
  );
  it.effect(
    "resolves shared knowledge to its owning source and withdraws old topic pages after scope changes",
    () =>
      Effect.gen(function* () {
        const a = yield* seed("source-a"),
          b = yield* seed("source-b"),
          sql = yield* SqlClient.SqlClient,
          memory = yield* WorkspaceMemory;
        yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at,scope) VALUES (${a},'same-id','long-term-memory','Shared policy','SHAREDONLYCANARY source A','active','user',${at},${at},'environment'),(${b},'same-id','long-term-memory','Private policy','PRIVATEONLYCANARY source B','active','user',${at},${at},'project')`;
        yield* memory.reconcile(a);
        yield* memory.reconcile(b);
        const memoryId = memoryHash(`knowledge:${a}:same-id`);
        expect(yield* invoke({ projectId: b, action: "read", id: memoryId })).toMatchObject({
          text: "SHAREDONLYCANARY source A",
        });
        yield* sql`UPDATE projection_workspace_knowledge_items SET scope='project' WHERE project_id=${a} AND item_id='same-id'`;
        yield* memory.reconcile(a);
        expect(
          yield* invoke({ projectId: b, action: "search", query: "SHAREDONLYCANARY" }),
        ).toEqual([]);
        const config = yield* ServerConfig,
          fs = yield* FileSystem.FileSystem;
        const oldPage = yield* fs.readFileString(
          `${memoryScopeDirectory(config.stateDir, a, "global")}/topics/${memoryHash("Shared policy").slice(0, 24)}-0000.md`,
        );
        expect(oldPage).toContain("비활성화된 기억");
        expect(oldPage).not.toContain("SHAREDONLYCANARY");
        yield* sql`UPDATE projection_workspace_knowledge_items SET status='archived' WHERE project_id=${a}`;
        yield* memory.reconcile(a);
        expect(
          yield* invoke({ projectId: a, action: "search", query: "SHAREDONLYCANARY" }),
        ).toEqual([]);
        yield* sql`UPDATE projection_workspace_knowledge_items SET status='active' WHERE project_id=${a}`;
        yield* memory.reconcile(a);
        expect(
          yield* invoke({ projectId: a, action: "search", query: "SHAREDONLYCANARY" }),
        ).toEqual([expect.objectContaining({ text: "SHAREDONLYCANARY source A" })]);
      }),
  );
  it.effect("enforces changed knowledge scopes before memory reconciliation finishes", () =>
    Effect.gen(function* () {
      const owner = yield* seed("scope-change-owner"),
        other = yield* seed("scope-change-other"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      const longText = `${"prefix ".repeat(1400)}SCOPELONGTAILCANARY`;
      yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at,scope) VALUES
        (${owner},'scope-short','long-term-memory','Short scope','SCOPESHORTCANARY','active','user',${at},${at},'environment'),
        (${owner},'scope-long','long-term-memory','Long scope',${longText},'active','user',${at},${at},'environment')`;
      yield* memory.reconcile(owner);
      const shortId = memoryHash(`knowledge:${owner}:scope-short`);
      expect(
        yield* invoke({ projectId: other, action: "search", query: "SCOPESHORTCANARY" }),
      ).toHaveLength(1);
      expect(
        yield* invoke({ projectId: other, action: "search", query: "SCOPELONGTAILCANARY" }),
      ).toHaveLength(1);

      yield* sql`UPDATE projection_workspace_knowledge_items SET scope='project' WHERE project_id=${owner} AND item_id IN ('scope-short','scope-long')`;
      expect(
        yield* invoke({ projectId: other, action: "search", query: "SCOPESHORTCANARY" }),
      ).toEqual([]);
      expect(
        yield* invoke({ projectId: other, action: "search", query: "SCOPELONGTAILCANARY" }),
      ).toEqual([]);
      expect(yield* memory.context(other, "SCOPESHORTCANARY")).not.toContain("SCOPESHORTCANARY");
      yield* memory.reconcile(owner);
      expect(
        yield* invoke({ projectId: owner, action: "search", query: "SCOPESHORTCANARY" }),
      ).toHaveLength(1);

      yield* sql`UPDATE projection_workspace_knowledge_items SET scope='folder',applies_to_folder='private' WHERE project_id=${owner} AND item_id IN ('scope-short','scope-long')`;
      expect(
        yield* invoke({ projectId: owner, action: "search", query: "SCOPESHORTCANARY" }),
      ).toEqual([]);
      expect(
        yield* invoke({ projectId: owner, action: "search", query: "SCOPELONGTAILCANARY" }),
      ).toEqual([]);
      expect(yield* memory.context(owner, "SCOPESHORTCANARY")).not.toContain("SCOPESHORTCANARY");
      const error = yield* memory
        .invoke({ projectId: owner, action: "read", id: shortId })
        .pipe(Effect.flip);
      expect(error.message).toContain("기억");
    }),
  );
  it.effect("prepares a bounded provider handoff with a verified complete source reference", () =>
    Effect.gen(function* () {
      const id = yield* seed("handoff"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<200) INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) SELECT 'handoff-'||x,${`t-${id}`},'user',printf('%04000d',x),0,${at},${at} FROM n`;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('current-handoff',${`t-${id}`},'user','CURRENT_REQUEST_MARKER',0,${at},${at})`;
      yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
        SELECT message_id,${id},thread_id,'' FROM projection_thread_messages WHERE thread_id=${`t-${id}`} AND role='user'`;
      const text = yield* memory.handoff(
        id,
        ThreadId.make(`t-${id}`),
        MessageId.make("current-handoff"),
        true,
      );
      expect(text?.length).toBeLessThan(18000);
      expect(text).toContain("SHA-256");
      expect(text).not.toContain("CURRENT_REQUEST_MARKER");
      const [archive] = yield* sql<{
        records: number;
      }>`SELECT records FROM workspace_memory_source_archives WHERE project_id=${id}`;
      expect(archive?.records).toBe(202);
    }),
  );
  it.effect("isolates projects and exposes only explicitly shared global notes", () =>
    Effect.gen(function* () {
      const a = yield* seed("scope-a"),
        b = yield* seed("scope-b");
      yield* remember(a, "private", "PRIVATE_A convention");
      const shared = yield* remember(a, "global", "SHARED_RULE convention", "global");
      expect(yield* invoke({ projectId: b, action: "search", query: "PRIVATE_A" })).toEqual([]);
      expect(yield* invoke({ projectId: b, action: "search", query: "SHARED_RULE" })).toEqual([
        expect.objectContaining({ text: "SHARED_RULE convention" }),
      ]);
      const id = (yield* decodeId(shared)).id;
      expect(yield* invoke({ projectId: b, action: "read", id })).toMatchObject({
        text: "SHARED_RULE convention",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id=${a}`;
      expect(yield* invoke({ projectId: b, action: "search", query: "SHARED_RULE" })).toEqual([]);
    }),
  );
  it.effect(
    "deduplicates retries, rejects changed retries and keeps forgotten records excluded after replay",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("forget");
        const first = yield* remember(id, "one", "기억할 UNIQUE_POLICY");
        expect(yield* remember(id, "one", "기억할 UNIQUE_POLICY")).toEqual(first);
        const memory = yield* WorkspaceMemory;
        const error = yield* memory
          .invoke({
            projectId: id,
            action: "remember",
            requestId: "one",
            topic: "규칙",
            text: "다른 내용",
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("WorkspaceMemoryError");
        const noteId = (yield* decodeId(first)).id;
        yield* invoke({ projectId: id, action: "forget", id: noteId });
        yield* memory.reconcile(id);
        expect(yield* invoke({ projectId: id, action: "search", query: "UNIQUE_POLICY" })).toEqual(
          [],
        );
        const config = yield* ServerConfig,
          fs = yield* FileSystem.FileSystem;
        const root = memoryScopeDirectory(config.stateDir, id, "project");
        const withdrawn = yield* fs.readFileString(
          `${root}/topics/${memoryHash("규칙").slice(0, 24)}-0000.md`,
        );
        expect(withdrawn).toContain("비활성화된 기억");
        expect(withdrawn).not.toContain("UNIQUE_POLICY");
        expect(yield* fs.exists(`${root}/topics/.history`)).toBe(false);
      }),
  );
  it.effect(
    "revisits in-flight messages after the cursor advances and preserves Unicode source offsets",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("pending"),
          sql = yield* SqlClient.SqlClient,
          memory = yield* WorkspaceMemory;
        const text = "😀".repeat(12001) + " 항상 지켜야 할 LATE_DECISION";
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('pending-message',${`t-${id}`},'user',${text},1,${at},${at})`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('later-message',${`t-${id}`},'assistant','unverified REPORT_MARKER',0,${at},${at})`;
        yield* memory.reconcile(id);
        yield* sql`UPDATE projection_thread_messages SET is_streaming=0 WHERE message_id='pending-message'`;
        yield* memory.reconcile(id);
        const [record] = yield* sql<{
          total: number;
        }>`SELECT count(*) AS total FROM workspace_memory_v2 WHERE id=${memoryHash("message:pending-message")}`;
        expect(record?.total).toBe(1);
        const first = yield* decodePart(
          yield* invoke({ projectId: id, action: "read", id: "message:pending-message" }),
        );
        expect(first.next).toBe(12000);
        const second = yield* decodePart(
          yield* invoke({
            projectId: id,
            action: "read",
            id: "message:pending-message",
            offset: first.next!,
          }),
        );
        expect(first.text + second.text).toBe(text);
        expect(yield* invoke({ projectId: id, action: "search", query: "REPORT_MARKER" })).toEqual([
          expect.objectContaining({ verification: "unverified-report" }),
        ]);
        const denied = yield* memory
          .invoke({ projectId: id, action: "history", threadId: ThreadId.make("t-scope-b") })
          .pipe(Effect.flip);
        expect(denied._tag).toBe("WorkspaceMemoryError");
      }),
  );
  it.effect(
    "exports all source kinds to a consistent gzip archive without modifying originals",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("export"),
          sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('export-message',${`t-${id}`},'user','Original user request',0,${at},${at})`;
        const payload = '{"toolName":"Read","text":"FULL_TOOL_RESULT"}';
        yield* sql`INSERT INTO projection_thread_activities(activity_id,thread_id,tone,kind,summary,payload_json,created_at,sequence) VALUES ('export-activity',${`t-${id}`},'info','tool.completed','Read',${payload},${at},12)`;
        yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES ('export-event','thread',${`t-${id}`},1,'thread.reverted',${at},'user','{"originalDecision":"CANONICAL_REVERTED_SOURCE"}','{}')`;
        const archive = yield* decodeArchive(
          yield* invoke({ projectId: id, action: "export", threadId: ThreadId.make(`t-${id}`) }),
        );
        const fs = yield* FileSystem.FileSystem;
        const source = NodeZlib.gunzipSync(yield* fs.readFile(archive.path)).toString("utf8");
        expect(NodeCrypto.createHash("sha256").update(source).digest("hex")).toBe(archive.sha256);
        expect(archive.records).toBe(4);
        expect(source).toContain("CANONICAL_REVERTED_SOURCE");
        expect(source).toContain("FULL_TOOL_RESULT");
        expect(source).toContain("Original user request");
        const [row] = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM projection_thread_activities WHERE activity_id='export-activity'`;
        expect(row?.payload_json).toBe(payload);
      }),
  );
  it.effect(
    "pages the entire history with explicit completion and bounds the injected memory context",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("pages"),
          sql = yield* SqlClient.SqlClient,
          memory = yield* WorkspaceMemory;
        yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<73) INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) SELECT 'page-'||x,${`t-${id}`},'user','항상 PAGE_CONVENTION '||x,0,${at},${at} FROM n`;
        yield* memory.reconcile(id);
        const all = new Set<string>();
        let after = 0,
          complete = false;
        while (!complete) {
          const page = yield* decodePage(
            yield* invoke({
              projectId: id,
              action: "history",
              threadId: ThreadId.make(`t-${id}`),
              after,
            }),
          );
          for (const row of page.entries) all.add(row.message_id);
          after = page.next ?? 0;
          complete = page.complete;
          expect(page.entries.length).toBeLessThanOrEqual(20);
        }
        expect(all.size).toBe(73);
        expect(Buffer.byteLength(yield* memory.context(id, "PAGE_CONVENTION"))).toBeLessThanOrEqual(
          14030,
        );
      }),
  );
});
