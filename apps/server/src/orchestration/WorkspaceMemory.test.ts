// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, MessageId, type WorkspaceMemoryAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { layerConfig as sqlite } from "../persistence/Layers/Sqlite.ts";
import { ServerConfig, layerTest } from "../config.ts";
import {
  WorkspaceMemory,
  extractDeterministicEntitySlot,
  resolveTemporalSlotConflict,
  slotFallbackTopic,
} from "./WorkspaceMemory.ts";
import { memoryHash, memoryScopeDirectory, PROCEDURAL_LESSONS_MAX_BYTES } from "./memoryFiles.ts";
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

it("reads a slot fact only from a whole keyword followed by a real assignment", () => {
  for (const text of [
    "Portfolio/MultiServer/로 옮겼어",
    "db_broker.vbs로 실행",
    "model_failed로 표시",
    "runtime.vbs로 시작",
    "dBlockIndex",
    "경로는 fail-closed로",
    "경로는 fail-closed로 남겨 둔다",
    "포트폴리오 8080으로 변경",
    "리포트를 3개로 변경",
    "apps/server/src/model.ts로 변경",
    "path: C:\\Users\\me",
    "경로:\n- src/a.ts",
    "gpt 모델 gpt 사용자에게 안내",
  ])
    expect(extractDeterministicEntitySlot(text, "주제"), text).toBeNull();

  expect(extractDeterministicEntitySlot("서버 포트를 8000에서 8080으로 변경", "주제")).toEqual({
    entityKey: "주제",
    predicateSlot: "port",
    normalizedValue: "8080",
    isNegationOrRollback: false,
  });
  expect(
    extractDeterministicEntitySlot("auth-service의 포트는 9000으로 고정", "주제"),
  ).toMatchObject({ entityKey: "auth-service", predicateSlot: "port", normalizedValue: "9000" });
  expect(extractDeterministicEntitySlot("패키지 매니저는 pnpm 사용", "주제")).toMatchObject({
    entityKey: "주제",
    predicateSlot: "package_manager",
    normalizedValue: "pnpm",
  });
  expect(extractDeterministicEntitySlot("auth-api의 포트 8000 → 8080", "")).toMatchObject({
    entityKey: "auth-api",
    predicateSlot: "port",
    normalizedValue: "8080",
  });
  expect(extractDeterministicEntitySlot("auth-api의 port: 8080.", "")).toMatchObject({
    entityKey: "auth-api",
    normalizedValue: "8080",
  });
  expect(extractDeterministicEntitySlot("- auth-api의 포트: 8080", "")).toMatchObject({
    entityKey: "auth-api",
    predicateSlot: "port",
    normalizedValue: "8080",
  });
  expect(extractDeterministicEntitySlot("Fixed auth-api의 포트: 8080", "")).toMatchObject({
    entityKey: "auth-api",
    predicateSlot: "port",
    normalizedValue: "8080",
  });
  // Without a topic the text has to name the entity; a bare noun is not a name.
  expect(extractDeterministicEntitySlot("서버 포트를 8000에서 8080으로 변경", "")).toBeNull();
  expect(extractDeterministicEntitySlot("서버의 포트를 8080으로 변경", "")).toBeNull();
});

it("rejects prohibitions, questions, negations, loose note syntax and rejected explicit entities", () => {
  // Follow-up 1: prohibition / question / negation / proposal / hypothetical -> null
  for (const text of [
    "auth-api의 포트를 9000으로 변경하지 마",
    "t3의 포트를 8080으로 변경할까요?",
    "node의 버전은 v18 사용하지 않는다",
    "node의 버전은 v18 사용 금지",
    "node의 버전은 v18 사용 중단",
    "node의 버전은 v18 사용 불가",
    "auth-api의 포트를 9000으로 변경하면 안 된다",
    "auth-api의 포트를 9000으로 변경할지 검토",
    "don't set auth-api의 port: 9000",
    "Should we change auth-api의 port to 9000?",
  ]) {
    expect(extractDeterministicEntitySlot(text, "주제"), text).toBeNull();
    expect(extractDeterministicEntitySlot(text, ""), text).toBeNull();
  }

  // Follow-up 2: code / inline literals / timestamps / trailing notes / fenced code blocks -> null
  for (const text of [
    "model: string;",
    "const path = require('path')",
    "```python\npath = os.path.join(a, b)\n```",
    "```yaml\nmodel: claude-opus\n```",
    "PORT=3000 node server.js",
    "{ model: selection.model, foo: 1 }",
    "버전: 2026-11-20 17:35",
    "model: gpt-5 (요약용)",
    // Rejected explicit `...의` entities must not fall back to the topic.
    "서버의 포트: 3000",
    "최신 버전의 모델: gpt-5",
    "`foo.ts`의 path: `a/b`",
    "PR #12의 버전: 2",
    "I think that 설정의 model: x",
    "auth 서비스의 포트는 9000으로 고정",
  ]) {
    expect(extractDeterministicEntitySlot(text, "주제"), text).toBeNull();
  }

  // Positive note-line key: value forms outside fenced code blocks still parse with topic fallback.
  expect(extractDeterministicEntitySlot("model: claude-opus", "주제")).toMatchObject({
    entityKey: "주제",
    predicateSlot: "model",
    normalizedValue: "claude-opus",
  });
  expect(extractDeterministicEntitySlot("- model: gpt-5", "주제")).toMatchObject({
    entityKey: "주제",
    predicateSlot: "model",
    normalizedValue: "gpt-5",
  });
});

it("lends a topic to slot facts only for a user's own note", () => {
  expect(slotFallbackTopic("배포 설정", "user-requested")).toBe("배포 설정");
  expect(slotFallbackTopic("배포 설정", "user")).toBe("배포 설정");
  expect(slotFallbackTopic("배포 설정", "assistant")).toBe("");
  expect(slotFallbackTopic("배포 설정", "agent")).toBe("");
  expect(slotFallbackTopic("사용자 결정과 정정", "user")).toBe("");
  expect(slotFallbackTopic("이전 작업 보고", "assistant")).toBe("");
});

it("never closes a memory because a later one restates the same value at greater length", () => {
  const earlier = {
    id: "earlier",
    content: "auth-api의 포트를 9100으로 고정",
    topic: "",
    role: "assistant" as const,
    validFrom: 1,
    validTo: null,
  };
  const later = {
    id: "later",
    content: `auth-api의 포트를 9100으로 고정했습니다. ${"자세한 설명 ".repeat(40)}`,
    topic: "",
    role: "assistant" as const,
    validFrom: 2,
  };
  expect(
    resolveTemporalSlotConflict(
      later,
      extractDeterministicEntitySlot(later.content, later.topic)!,
      [earlier],
    ),
  ).toEqual({ action: "NOOP", supersededRecordIds: [], newRecordValidTo: null });
});

it.layer(layer)("WorkspaceMemory v2", (it) => {
  it.effect("measures memory search hits and misses without recording the query", () =>
    Effect.gen(function* () {
      const id = yield* seed("memory-metrics-test");
      yield* remember(id, "metrics-note", "MEMORYMETRICCANARYALPHA local evidence");
      expect(
        yield* invoke({ projectId: id, action: "search", query: "MEMORYMETRICCANARYALPHA" }),
      ).not.toEqual([]);
      expect(
        yield* invoke({ projectId: id, action: "search", query: "MEMORYMETRICCANARYMISSING" }),
      ).toEqual([]);
      const snapshots = (yield* Metric.snapshot).filter((item) =>
        item.id.startsWith("t3_memory_search"),
      );
      expect(
        snapshots.some(
          (item) =>
            item.id === "t3_memory_searches_total" && item.attributes?.outcome === "success",
        ),
      ).toBe(true);
      expect(snapshots.some((item) => item.id === "t3_memory_search_duration")).toBe(true);
      expect(
        snapshots.some(
          (item) =>
            item.id === "t3_memory_search_results_total" && item.attributes?.result === "hit",
        ),
      ).toBe(true);
      expect(
        snapshots.some(
          (item) =>
            item.id === "t3_memory_search_results_total" && item.attributes?.result === "miss",
        ),
      ).toBe(true);
      expect(encode(snapshots)).not.toContain("MEMORYMETRICCANARY");
      expect(encode(snapshots)).not.toContain("memory-metrics-test");
    }),
  );

  it.effect(
    "selects durable decisions and sourced reports while retaining ordinary dialogue as searchable",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("selective-memory");
        const sql = yield* SqlClient.SqlClient;
        const thread = ThreadId.make(`t-${id}`);
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('signal-user',${thread},'user','배포 예산은 5달러로 제한한다',0,${at},${at}),
        ('signal-agent',${thread},'assistant','apps/server/src/check.ts:12에서 테스트 실패 원인을 확인했으며 실제 작업 근거는 해당 파일에 기록했습니다.',0,${at},${at}),
        ('signal-chat',${thread},'assistant','네 알겠습니다',0,${at},${at})`;
        yield* invoke({ projectId: id, action: "backfill" });
        const rows = yield* sql<{
          id: string;
          status: string;
          verification: string;
        }>`SELECT id,status,verification FROM workspace_memory_v2 WHERE project_id=${id}`;
        expect(rows.find((r) => r.id === memoryHash("message:signal-user"))?.status).toBe(
          "pending",
        );
        expect(rows.find((r) => r.id === memoryHash("message:signal-agent"))).toMatchObject({
          status: "pending",
          verification: "unverified-report",
        });
        expect(rows.find((r) => r.id === memoryHash("message:signal-chat"))?.status).toBe(
          "observed",
        );
        const found = yield* invoke({
          projectId: id,
          action: "search",
          query: "check.ts 테스트 실패",
        });
        expect(encode(found)).toContain("apps/server/src/check.ts:12");
      }),
  );
  it.effect(
    "saves an explicitly requested project-root note without classifying old messages",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("explicit-root-note");
        const memory = yield* WorkspaceMemory;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make(`t-${id}`);
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('old-unclassified-root',${threadId},'user','old message',0,${at},${at})`;
        const saved = decode(
          yield* memory.invoke(
            {
              projectId: id,
              action: "remember",
              requestId: "root-decision",
              topic: "root decision",
              text: "ROOT_DECISION_CANARY",
              scope: "project",
            },
            { threadId, projectRoot: true },
          ),
        );
        expect(saved).toMatchObject({ saved: true });
        const rows = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM workspace_memory_v2_message_folders WHERE message_id='old-unclassified-root'`;
        expect(rows[0]?.count).toBe(0);
        const noteId = (yield* decodeId(saved)).id;
        const notes = yield* sql<{
          folder: string;
        }>`SELECT json_extract(source_json,'$.folder') AS folder FROM workspace_memory_v2 WHERE id=${noteId}`;
        expect(notes[0]?.folder).toBe("");
        yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
        VALUES ('old-unclassified-root',${id},${threadId},'')`;
        expect(
          encode(
            decode(
              yield* memory.invoke(
                { projectId: id, action: "search", query: "ROOT_DECISION_CANARY" },
                { threadId },
              ),
            ),
          ),
        ).toContain("ROOT_DECISION_CANARY");
      }),
  );
  it.effect("stores a supervisor progress report in the conversation folder as unverified", () =>
    Effect.gen(function* () {
      const id = yield* seed("agent-progress-note");
      const memory = yield* WorkspaceMemory;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make(`t-${id}`);
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('agent-progress-message',${threadId},'user','work in web',0,${at},${at})`;
      yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
        VALUES ('agent-progress-message',${id},${threadId},'apps/web')`;
      const saved = decode(
        yield* memory.invoke(
          {
            projectId: id,
            action: "remember",
            requestId: "run-progress",
            topic: "work progress",
            text: "AGENT_PROGRESS_CANARY",
            scope: "project",
          },
          { threadId, agentReported: true },
        ),
      );
      const noteId = (yield* decodeId(saved)).id;
      const rows = yield* sql<{ folder: string; origin: string; verification: string }>`SELECT
        json_extract(source_json,'$.folder') AS folder, origin, verification
        FROM workspace_memory_v2 WHERE id=${noteId}`;
      expect(rows[0]).toMatchObject({
        folder: "apps/web",
        origin: "assistant",
        verification: "unverified-report",
      });
      expect(
        encode(
          decode(
            yield* memory.invoke(
              { projectId: id, action: "search", query: "AGENT_PROGRESS_CANARY" },
              { threadId },
            ),
          ),
        ),
      ).toContain("AGENT_PROGRESS_CANARY");
    }),
  );
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

  for (const fallback of [false, true]) {
    it.effect(
      `marks an incomplete recent user message and preserves its source (fallback=${fallback})`,
      () =>
        Effect.gen(function* () {
          const id = yield* seed(`truncated-context-${fallback}`),
            sql = yield* SqlClient.SqlClient,
            memory = yield* WorkspaceMemory;
          const threadId = ThreadId.make(`t-${id}`);
          const prior = `truncated-prior-${fallback}`;
          const exact = `exact-emoji-${fallback}`;
          const current = `truncated-current-${fallback}`;
          const original = `${"A".repeat(2_000)}LATE_USER_CONDITION`;
          yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
          (${prior},${threadId},'user',${original},0,${at},${at}),
          (${exact},${threadId},'assistant',${"😀".repeat(2_000)},0,${at},${at})`;
          if (fallback) {
            yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<35)
            INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
            SELECT 'truncated-filler-'||x,${threadId},'assistant','progress',0,${at},${at} FROM n`;
          }
          yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
          VALUES (${current},${threadId},'user','계속해',0,${at},${at})`;
          yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
          VALUES (${prior},${id},${threadId},''),(${current},${id},${threadId},'')`;
          const context = yield* memory.context(id, "계속해", false, {
            threadId,
            messageId: MessageId.make(current),
          });
          const recent = context
            .split("<t3_recent_conversation>")[1]
            ?.split("</t3_recent_conversation>")[0];
          expect(recent).toContain(`[message:${prior}]`);
          expect(recent).toContain(
            `원문의 앞부분만 발췌했습니다. 조건과 정정을 확인하려면 workspace_memory read에서 message:${prior}`,
          );
          expect(recent).not.toContain("LATE_USER_CONDITION");
          if (!fallback) {
            const exactExcerpt = recent?.split(`[message:${exact}]`)[1];
            expect(exactExcerpt).not.toContain("원문의 앞부분만 발췌했습니다");
          }
          const source = yield* decodePart(
            decode(
              yield* memory.invoke(
                { projectId: id, action: "read", id: `message:${prior}` },
                { threadId },
              ),
            ),
          );
          expect(source.text).toBe(original);
          if (!fallback) {
            const handoff = yield* memory.handoff(id, threadId, MessageId.make(current), false);
            expect(handoff).toContain(`[message:${prior}]`);
            expect(handoff).toContain(`workspace_memory read에서 message:${prior}`);
            expect(handoff).toContain("LATE_USER_CONDITION");
          }
        }),
    );
  }

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
      const handoff = yield* memory.handoff(
        id,
        ThreadId.make(`t-${id}`),
        MessageId.make("missing-message"),
        false,
      );
      expect(handoff).toContain("대화 위치를 확인하지 못해 이전 대화 인계를 생략했습니다");
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

  it.effect(
    "hands off the same conversation across folders when automatic chat memory is disabled",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("handoff-without-automatic-memory");
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const memory = yield* WorkspaceMemory;
        const threadId = ThreadId.make(`t-${id}`);
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "memory-handoff-disabled-" });
        yield* fs.makeDirectory(`${root}/apps/web`, { recursive: true });
        yield* fs.makeDirectory(`${root}/apps/server`, { recursive: true });
        yield* sql`UPDATE projection_projects SET workspace_control_json='{"conversationRag":{"enabled":true},"contextOptimization":{"autoChatMemory":false}}' WHERE project_id=${id}`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('handoff-noauto-web',${threadId},'user','[web](apps/web) KEEP_WEB',0,${at},${at}),
        ('handoff-noauto-server',${threadId},'user','[server](apps/server) HIDE_SERVER',0,${at},${at}),
        ('handoff-noauto-current',${threadId},'user','[web](apps/web) continue',0,${at},${at})`;
        for (const message of [
          "handoff-noauto-web",
          "handoff-noauto-server",
          "handoff-noauto-current",
        ]) {
          yield* memory.contextPaths({
            projectId: id,
            threadId,
            messageId: MessageId.make(message),
            cwd: root,
            recordCurrent: true,
          });
        }
        const handoff = yield* memory.handoff(
          id,
          threadId,
          MessageId.make("handoff-noauto-current"),
          false,
        );
        expect(handoff).toContain("KEEP_WEB");
        expect(handoff).toContain("HIDE_SERVER");
        expect(
          yield* memory.context(id, "KEEP_WEB", false, {
            threadId,
            messageId: MessageId.make("handoff-noauto-current"),
          }),
        ).not.toContain("KEEP_WEB");
      }),
  );

  it.effect("hands off the current conversation when no message has a folder classification", () =>
    Effect.gen(function* () {
      const id = yield* seed("handoff-unclassified-conversation");
      const sql = yield* SqlClient.SqlClient;
      const memory = yield* WorkspaceMemory;
      const threadId = ThreadId.make(`t-${id}`);
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('unclassified-handoff-prior',${threadId},'user','KEEP_UNCLASSIFIED_HISTORY',0,${at},${at}),
        ('unclassified-handoff-current',${threadId},'user','continue',0,${at},${at})`;
      const handoff = yield* memory.handoff(
        id,
        threadId,
        MessageId.make("unclassified-handoff-current"),
        false,
      );
      expect(handoff).toContain("KEEP_UNCLASSIFIED_HISTORY");
      expect(handoff).not.toContain("인계를 생략했습니다");
      const original = yield* memory.invoke(
        { projectId: id, action: "read", id: "message:unclassified-handoff-prior" },
        { threadId },
      );
      expect(encode(decode(original))).toContain("KEEP_UNCLASSIFIED_HISTORY");
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
        const sameConversationRead = yield* memory.invoke(
          { projectId: id, action: "read", id: "message:folder-server-user" },
          { threadId },
        );
        expect(encode(decode(sameConversationRead))).toContain("SERVER_ONLY");
        const denied = yield* memory
          .invoke(
            { projectId: id, action: "read", id: "message:folder-server-second" },
            { threadId },
          )
          .pipe(Effect.flip);
        expect(denied.message).toContain("폴더 범위");
        const deniedForget = yield* memory
          .invoke(
            {
              projectId: id,
              action: "forget-message",
              id: memoryHash("message:folder-server-user"),
            },
            { threadId },
          )
          .pipe(Effect.flip);
        expect(deniedForget.message).toContain("폴더 범위");
        const legacy = yield* memory.invoke(
          { projectId: id, action: "read", id: "message:folder-old" },
          { threadId },
        );
        expect(encode(decode(legacy))).toContain("OLD_UNCLASSIFIED");
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
        expect(handoff).toContain("SERVER_ONLY");
        expect(handoff).toContain("OLD_UNCLASSIFIED");
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
      yield* invoke({ projectId: id, action: "forget-message", id: memoryId });
      const [forgotten] = yield* sql<{
        text: string;
        status: string;
      }>`SELECT text,status FROM workspace_memory_v2 WHERE id=${memoryId}`;
      expect(forgotten).toEqual({ text: "", status: "forgotten" });
      yield* memory.reconcile(id);
      const [original] = yield* sql<{
        text: string;
      }>`SELECT text FROM projection_thread_messages WHERE message_id='long-backfill-message'`;
      expect(original?.text).toBe(body);
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

  it.effect("does not auto-inject a forgotten message but preserves its original history", () =>
    Effect.gen(function* () {
      const id = yield* seed("forgotten-recent"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      const threadId = ThreadId.make(`t-${id}`);
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('keep-prior',${threadId},'user','KEEP_CURRENT_DIRECTION',0,${at},${at})`;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<35)
        INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        SELECT 'forgotten-assistant-'||x,${threadId},'assistant','Routine progress',0,${at},${at} FROM n`;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('forgotten-policy',${threadId},'user','STALE_MAIN_POLICY_CANARY',0,${at},${at}),
               ('forgotten-current',${threadId},'user','계속해',0,${at},${at})`;
      yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
        SELECT message_id,${id},thread_id,'' FROM projection_thread_messages
        WHERE thread_id=${threadId} AND role='user'`;
      yield* memory.reconcile(id);
      const memoryId = memoryHash("message:forgotten-policy");
      expect(
        yield* invoke({ projectId: id, action: "search", query: "STALE_MAIN_POLICY_CANARY" }),
      ).not.toEqual([]);
      expect(
        yield* invoke({ projectId: id, action: "forget-message", id: memoryId }),
      ).toMatchObject({
        forgotten: true,
        sourceHistoryPreserved: true,
      });
      yield* memory.reconcile(id);
      expect(
        yield* invoke({ projectId: id, action: "search", query: "STALE_MAIN_POLICY_CANARY" }),
      ).toEqual([]);
      const context = yield* memory.context(id, "계속해", false, {
        threadId,
        messageId: MessageId.make("forgotten-current"),
      });
      expect(context).not.toContain("STALE_MAIN_POLICY_CANARY");
      expect(context).toContain("KEEP_CURRENT_DIRECTION");
      const forgottenRead = yield* memory
        .invoke({ projectId: id, action: "read", id: "message:forgotten-policy" }, { threadId })
        .pipe(Effect.flip);
      expect(forgottenRead.message).toContain("기억에서 제외");
      const handoff = yield* memory.handoff(
        id,
        threadId,
        MessageId.make("forgotten-current"),
        true,
      );
      expect(handoff).not.toContain("STALE_MAIN_POLICY_CANARY");
      expect(handoff).not.toContain("원문 스냅샷:");
      expect(handoff).toContain("기억에서 제외한 발언");
      expect(
        yield* invoke({ projectId: id, action: "read", id: "message:forgotten-policy" }),
      ).toMatchObject({
        text: "STALE_MAIN_POLICY_CANARY",
      });
      const [original] = yield* sql<{
        text: string;
      }>`SELECT text FROM projection_thread_messages WHERE message_id='forgotten-policy'`;
      expect(original?.text).toBe("STALE_MAIN_POLICY_CANARY");
    }),
  );

  it.effect("reports the exclusion when every prior handoff message was forgotten", () =>
    Effect.gen(function* () {
      const id = yield* seed("forgotten-all-handoff");
      const sql = yield* SqlClient.SqlClient;
      const memory = yield* WorkspaceMemory;
      const threadId = ThreadId.make(`t-${id}`);
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        VALUES ('forgotten-all-prior',${threadId},'user','PRIVATE_PREVIOUS',0,${at},${at}),
               ('forgotten-all-current',${threadId},'user','continue',0,${at},${at})`;
      yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
        SELECT message_id,${id},thread_id,'' FROM projection_thread_messages WHERE thread_id=${threadId} AND role='user'`;
      yield* memory.reconcile(id);
      yield* invoke({
        projectId: id,
        action: "forget-message",
        id: memoryHash("message:forgotten-all-prior"),
      });
      const handoff = yield* memory.handoff(
        id,
        threadId,
        MessageId.make("forgotten-all-current"),
        true,
      );
      expect(handoff).toContain("기억에서 제외한 발언");
      expect(handoff).not.toContain("PRIVATE_PREVIOUS");
      expect(handoff).not.toContain("원문 스냅샷:");
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
        (${b},'recipient-rule','directive','현재 프로젝트 지침','RECIPIENT_DIRECTIVE','active','user',${at},${at},'project'),
        (${b},'recipient-shared-rule','directive','현재 프로젝트의 공용 지침','RECIPIENT_SHARED_DIRECTIVE','active','user',${at},${at},'environment'),
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
        const composedContext = yield* memory.context(b, "요청", false, {
          threadId: ThreadId.make(`t-${b}`),
          messageId: MessageId.make("current-message"),
          excludeDirectiveReferences: [
            { projectId: b, itemId: "recipient-rule" },
            { projectId: b, itemId: "recipient-shared-rule" },
          ],
        });
        expect(composedContext).toContain("화면 탈취 절대 금지");
        expect(composedContext).not.toContain("RECIPIENT_DIRECTIVE");
        expect(composedContext).not.toContain("RECIPIENT_SHARED_DIRECTIVE");
        expect(composedContext).not.toContain("PRIVATE_DIRECTIVE");
        expect(composedContext).not.toContain("AGENT_DIRECTIVE");
        yield* sql`UPDATE projection_workspace_knowledge_items SET status='archived' WHERE project_id=${a} AND item_id='shared-rule'`;
        expect(yield* memory.context(b, "다음 요청")).not.toContain("화면 탈취 절대 금지");
      }),
  );

  it.effect(
    "applies folder answer guides to their folder even when automatic chat memory is off",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("folder-guide"),
          sql = yield* SqlClient.SqlClient,
          memory = yield* WorkspaceMemory;
        const thread = ThreadId.make(`t-${id}`);
        yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at,scope,applies_to_folder) VALUES
        (${id},'web-guide','directive','웹 답변 가이드','WEB_FOLDER_GUIDE','active','user',${at},${at},'folder','apps/web'),
        (${id},'sibling-guide','directive','형제 폴더 가이드','SIBLING_FOLDER_GUIDE','active','user',${at},${at},'folder','apps/web-extra'),
        (${id},'project-rule','directive','프로젝트 지침','PROJECT_RULE','active','user','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','project',NULL)`;
        yield* sql`UPDATE projection_projects SET workspace_control_json='{"conversationRag":{"enabled":true},"contextOptimization":{"autoChatMemory":false}}' WHERE project_id=${id}`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
        ('guide-web',${thread},'user','apps/web/src 고쳐줘',0,${at},${at}),
        ('guide-root',${thread},'user','전체 점검',0,${at},${at}),
        ('guide-auto',${thread},'user','자동 후속',0,${at},${at})`;
        yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder) VALUES
        ('guide-web',${id},${thread},'apps/web/src'),
        ('guide-root',${id},${thread},'')`;

        const inFolder = yield* memory.context(id, "요청", false, {
          threadId: thread,
          messageId: MessageId.make("guide-web"),
        });
        expect(inFolder).toContain("WEB_FOLDER_GUIDE");
        expect(inFolder).toContain("폴더 답변 가이드");
        expect(inFolder).not.toContain("SIBLING_FOLDER_GUIDE");
        // Broad rules stay ahead of the folder guide so the prefix is stable.
        expect(inFolder.indexOf("PROJECT_RULE")).toBeLessThan(inFolder.indexOf("WEB_FOLDER_GUIDE"));

        const atRoot = yield* memory.context(id, "요청", false, {
          threadId: thread,
          messageId: MessageId.make("guide-root"),
        });
        expect(atRoot).toContain("PROJECT_RULE");
        expect(atRoot).not.toContain("WEB_FOLDER_GUIDE");
        expect(atRoot).not.toContain("폴더 답변 가이드");

        // Automation follow-ups inherit the folder of the previous user message.
        const inherited = yield* memory.context(id, "요청", false, {
          threadId: thread,
          messageId: MessageId.make("guide-auto"),
          inheritFolder: true,
        });
        expect(inherited).not.toContain("WEB_FOLDER_GUIDE");

        expect(yield* memory.context(id, "요청")).not.toContain("WEB_FOLDER_GUIDE");
        expect(
          yield* memory.context(id, "요청", true, undefined, { folderPaths: ["apps/web"] }),
        ).toContain("WEB_FOLDER_GUIDE");
        expect(
          yield* memory.context(id, "요청", false, {
            threadId: thread,
            messageId: MessageId.make("guide-web"),
            excludeDirectives: true,
          }),
        ).not.toContain("WEB_FOLDER_GUIDE");
      }),
  );

  it.effect("does not repeat directives that the prompt already carries", () =>
    Effect.gen(function* () {
      const id = yield* seed("directive-dedupe"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at,scope,applies_to_folder) VALUES
        (${id},'kept','directive','유지','KEPT_DIRECTIVE','active','user',${at},${at},'project',NULL),
        (${id},'present','directive','이미 포함','PRESENT_DIRECTIVE 본문','active','user',${at},${at},'project',NULL),
        (${id},'folder-present','directive','폴더','FOLDER_PRESENT','active','user',${at},${at},'folder','pkg')`;
      const prompt = "작업\n\n[지속 사용자 지침]\nPRESENT_DIRECTIVE 본문\n\nFOLDER_PRESENT";
      const context = yield* memory.context(id, "요청", true, undefined, {
        presentIn: prompt,
        folderPaths: ["pkg"],
      });
      expect(context).toContain("KEPT_DIRECTIVE");
      expect(context).not.toContain("PRESENT_DIRECTIVE");
      expect(context).not.toContain("FOLDER_PRESENT");
      // Other tests share this database, so only this project's rules are checked.
      const allPresent = yield* memory.context(id, "요청", true, undefined, {
        presentIn: "KEPT_DIRECTIVE\nPRESENT_DIRECTIVE 본문",
      });
      expect(allPresent).not.toContain(`${id}/kept`);
      expect(allPresent).not.toContain(`${id}/present`);
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
  it.effect(
    "carries scoped working evidence, pending requests and the latest user correction",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("working-handoff");
        const thread = ThreadId.make(`t-${id}`);
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* WorkspaceMemory;
        const current = MessageId.make("working-current");
        const later = "2026-10-20T00:00:00.000Z";
        for (const [turn, folder] of [
          ["old", "private"],
          ["work", "src"],
        ] as const) {
          yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
          VALUES (${turn},${thread},'user',${turn === "work" ? "previous ".repeat(500) + "USE_THE_REVISED_TARGET" : "Earlier folder discussion"},0,${at},${at})`;
          yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder) VALUES (${turn},${id},${thread},${folder})`;
          yield* sql`INSERT INTO projection_turns(thread_id,turn_id,pending_message_id,state,requested_at,checkpoint_files_json)
          VALUES (${thread},${turn},${turn},'completed',${at},'[]')`;
        }
        yield* sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<35)
        INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        SELECT 'progress-'||x,${thread},'assistant','Still reviewing',0,${at},${at} FROM n`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        VALUES (${current},${thread},'user','continue',0,${later},${later})`;
        yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
        VALUES (${current},${id},${thread},'src')`;
        yield* sql`UPDATE projection_thread_messages SET attachments_json=
        '[{"id":"format-report","name":"report.txt","dataUrl":"UNSENT_BYTES"}]' WHERE message_id='work'`;
        yield* sql`INSERT INTO projection_pending_approvals(request_id,thread_id,turn_id,status,created_at) VALUES
        ('open-review',${thread},'work','pending',${at}), ('closed-review',${thread},'work','resolved',${at})`;
        for (const [ref, turn, kind, detail, time] of [
          [
            "failed-check",
            "work",
            "tool.completed",
            {
              data: {
                item: {
                  exitCode: 1,
                  path: "src/format.ts",
                  aggregatedOutput: "log ".repeat(100) + "2 failures",
                },
              },
              detail: "format check failed",
            },
            at,
          ],
          [
            "next-step",
            "work",
            "turn.plan.updated",
            {
              plan: [
                { step: "Completed ".repeat(50), status: "completed" },
                { step: "Repair the formatter", status: "inProgress" },
              ],
            },
            at,
          ],
          [
            "choice",
            "work",
            "user-input.requested",
            { requestId: "choice", questions: [{ question: "Which target?" }] },
            at,
          ],
          [
            "retry-choice",
            "work",
            "provider.user-input.respond.failed",
            { requestId: "choice", detail: "Retry pending request after reconnection" },
            at,
          ],
          [
            "old-choice",
            "work",
            "user-input.requested",
            { requestId: "old-choice", questions: [{ question: "Resolved question?" }] },
            at,
          ],
          ["close-choice", "work", "user-input.resolved", { requestId: "old-choice" }, at],
          ["open-review", "work", "approval.requested", { requestId: "open-review" }, at],
          ["closed-review", "work", "approval.requested", { requestId: "closed-review" }, at],
          ["private-tool", "old", "tool.completed", { detail: "PRIVATE_TOOL_OUTPUT" }, at],
          [
            "future-tool",
            "work",
            "tool.completed",
            { detail: "FUTURE_TOOL_OUTPUT" },
            "2026-10-21T00:00:00.000Z",
          ],
        ] as const) {
          yield* sql`INSERT INTO projection_thread_activities(activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at)
          VALUES (${ref},${thread},${turn},'info',${kind},${kind},${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(detail)},${time})`;
        }
        const read = memory.handoff(id, thread, current, false);
        const handoff = yield* read;
        expect(handoff).toContain("USE_THE_REVISED_TARGET");
        expect(handoff).toContain("activity:failed-check");
        expect(handoff).toContain("format check failed");
        expect(handoff).toContain("Repair the formatter");
        expect(handoff).toContain("Which target?");
        expect(handoff).toContain("src/format.ts");
        expect(handoff).toContain('"exitCode":1');
        expect(handoff).toContain("2 failures");
        expect(handoff).toContain("format-report");
        expect(handoff).toContain("report.txt");
        expect(handoff).not.toContain("UNSENT_BYTES");
        expect(handoff).toContain("activity:open-review");
        expect(handoff).not.toContain("closed-review");
        expect(handoff).not.toContain("Resolved question?");
        expect(handoff).not.toContain("PRIVATE_TOOL_OUTPUT");
        expect(handoff).not.toContain("FUTURE_TOOL_OUTPUT");
        const unscoped = yield* memory.handoff(id, thread, current, false, false);
        expect(unscoped).toContain("USE_THE_REVISED_TARGET");
        expect(unscoped).not.toContain("activity:failed-check");
        expect(unscoped).not.toContain("format-report");
        const compact = yield* memory.handoff(id, thread, current, true);
        expect(compact).toContain("activity:failed-check");
        expect(compact).not.toContain("SHA-256");
        const [archives] = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM workspace_memory_source_archives WHERE project_id=${id}`;
        expect(archives?.count).toBe(0);
        yield* sql`INSERT INTO workspace_memory_v2(id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,created_at,updated_at)
        VALUES ('forgotten-tool',${id},'project','tool','','{"kind":"activity","id":"failed-check"}','x','agent','unverified','forgotten',${at},${at})`;
        const forgottenTool = yield* read;
        expect(forgottenTool).toContain("USE_THE_REVISED_TARGET");
        expect(forgottenTool).not.toContain("format check failed");
        yield* sql`INSERT INTO workspace_memory_v2(id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,created_at,updated_at)
        VALUES ('forgotten-working',${id},'project','forgotten','','{"kind":"message","id":"work"}','x','user','user-statement','forgotten',${at},${at})`;
        const afterForget = yield* read;
        expect(afterForget).not.toContain("message:work]");
        expect(afterForget).not.toContain("USE_THE_REVISED_TARGET");
        expect(afterForget).not.toContain("activity:failed-check");
        expect(afterForget).not.toContain("format-report");
        expect(afterForget).not.toContain("activity:open-review");
      }),
  );
  for (const scenario of [
    "revert",
    "forgotten-before-revert",
    "missing-projection",
    "reused-id",
  ] as const) {
    it.effect(`withholds the raw handoff archive for discarded history (${scenario})`, () =>
      Effect.gen(function* () {
        const projectId = yield* seed(`discarded-archive-${scenario}`);
        const threadId = ThreadId.make(`t-${projectId}`);
        const removed = `${projectId}-removed`;
        const kept = `${projectId}-kept`;
        const current = MessageId.make(`${projectId}-current`);
        const marker = "REMOVED_TURN_PRIVATE_TEXT";
        const memory = yield* WorkspaceMemory;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
          VALUES (${kept},${threadId},'user','KEEP_THIS_REQUEST',0,${at},${at}),
                 (${removed},${threadId},'user',${marker},0,${at},${at}),
                 (${current},${threadId},'user','continue',0,${at},${at})`;
        yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
          SELECT message_id,${projectId},thread_id,'src' FROM projection_thread_messages WHERE thread_id=${threadId}`;
        const sent = encode({
          threadId,
          messageId: removed,
          role: "user",
          text: marker,
          turnId: null,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        });
        yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
          VALUES (${removed + "-event"},'thread',${threadId},1,'thread.message-sent',${at},'user',${sent},'{}')`;
        if (scenario === "forgotten-before-revert") {
          yield* memory.reconcile(projectId);
          yield* memory.invoke({
            projectId,
            action: "forget-message",
            id: memoryHash(`message:${removed}`),
          });
        }
        if (scenario !== "missing-projection") {
          yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
            VALUES (${removed + "-revert"},'thread',${threadId},2,'thread.reverted',${at},'server',${encode({ threadId, turnCount: 1 })},'{}')`;
        }
        const readById = {
          projectId,
          action: "read",
          id: `message:${removed}`,
          offset: 1,
        } as const;
        if (scenario === "reused-id") {
          yield* sql`UPDATE projection_thread_messages SET text='REPLACEMENT' WHERE thread_id=${threadId} AND message_id=${removed}`;
          const part = yield* decodePart(decode(yield* memory.invoke(readById, { threadId })));
          expect(part.text).toBe("EPLACEMENT");
        } else {
          yield* sql`DELETE FROM projection_thread_messages WHERE thread_id=${threadId} AND message_id=${removed}`;
          expect((yield* memory.invoke(readById, { threadId }).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect((yield* memory.invoke(readById).pipe(Effect.result))._tag).toBe("Failure");
        }
        expect(
          yield* memory.invoke({ projectId, action: "read", id: `message:${kept}` }, { threadId }),
        ).toContain("KEEP_THIS_REQUEST");

        const handoff = yield* memory.handoff(projectId, threadId, current, true);
        expect(handoff).toContain("KEEP_THIS_REQUEST");
        expect(handoff).not.toContain(marker);
        expect(handoff).not.toContain("SHA-256");
        expect(
          yield* sql`SELECT path FROM workspace_memory_source_archives WHERE thread_id=${threadId}`,
        ).toHaveLength(0);

        const exportRequest = { projectId, threadId, action: "export" } as const;
        expect((yield* memory.invoke(exportRequest, { threadId }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const archive = yield* decodeArchive(decode(yield* memory.invoke(exportRequest)));
        const fs = yield* FileSystem.FileSystem;
        expect(NodeZlib.gunzipSync(yield* fs.readFile(archive.path)).toString("utf8")).toContain(
          marker,
        );
      }),
    );
  }

  it.effect("prepares a bounded provider handoff with a verified complete source reference", () =>
    Effect.gen(function* () {
      const id = yield* seed("handoff"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory;
      // A revert only disqualifies the stream that will be exported.
      yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
        VALUES ('unrelated-handoff-revert','thread','another-handoff-thread',1,'thread.reverted',${at},'server','{"turnCount":0}','{}')`;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<200) INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) SELECT 'handoff-'||x,${`t-${id}`},'user',printf('%04000d',x),0,${at},${at} FROM n`;
      yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('current-handoff',${`t-${id}`},'user','CURRENT_REQUEST_MARKER',0,${at},${at})`;
      yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
        SELECT message_id,${id},thread_id,'' FROM projection_thread_messages WHERE thread_id=${`t-${id}`} AND role='user'`;
      let attached = false;
      const text = yield* memory.handoff(
        id,
        ThreadId.make(`t-${id}`),
        MessageId.make("current-handoff"),
        true,
        true,
        () => {
          attached = true;
        },
      );
      expect(attached).toBe(true);
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
        const nonMessage = yield* memory
          .invoke({ projectId: id, action: "forget-message", id: noteId })
          .pipe(Effect.flip);
        expect(nonMessage.message).toContain("대화에서 생성된 검색 기록만");
        expect(
          yield* invoke({ projectId: id, action: "search", query: "UNIQUE_POLICY" }),
        ).not.toEqual([]);
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

  it.effect(
    "resolves bi-temporal slot conflicts in dream without false cross-slot invalidation and reinforces access counts on context retrieval",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("bitemporal-dream-slot"),
          sql = yield* SqlClient.SqlClient,
          memory = yield* WorkspaceMemory,
          config = yield* ServerConfig,
          fs = yield* FileSystem.FileSystem;

        const oldPortMsg = "slot-port-old";
        const newPortMsg = "slot-port-new";
        const packageManagerMsg = "slot-pkg-manager";
        const proceduralMsg = "slot-procedural-runbook";
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
          (${oldPortMsg},${`t-${id}`},'user','server.http의 포트를 8000으로 설정',0,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z'),
          (${newPortMsg},${`t-${id}`},'user','server.http의 포트를 8080으로 변경',0,'2026-10-15T00:00:00.000Z','2026-10-15T00:00:00.000Z'),
          (${packageManagerMsg},${`t-${id}`},'user','server.http의 패키지 매니저는 pnpm으로 고정',0,'2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z'),
          (${proceduralMsg},${`t-${id}`},'user','배포 절차 런북: 순서대로 테스트 통과 후 예약 작업으로 재시작한다',0,'2026-10-18T00:00:00.000Z','2026-10-18T00:00:00.000Z')`;

        yield* memory.reconcile(id);

        const oldPortId = memoryHash(`message:${oldPortMsg}`);
        const newPortId = memoryHash(`message:${newPortMsg}`);
        const pkgId = memoryHash(`message:${packageManagerMsg}`);

        const rows = yield* sql<{
          id: string;
          entity_key: string | null;
          predicate_slot: string | null;
          valid_to: number | null;
          expired_at: number | null;
          superseded_by_id: string | null;
          memory_tier: string;
          access_count: number;
        }>`SELECT id,entity_key,predicate_slot,valid_to,expired_at,superseded_by_id,memory_tier,access_count
           FROM workspace_memory_v2 WHERE project_id=${id}`;

        const oldPortRow = rows.find((r) => r.id === oldPortId);
        const newPortRow = rows.find((r) => r.id === newPortId);
        const pkgRow = rows.find((r) => r.id === pkgId);

        // Old port interval is closed non-destructively and demoted to cold
        expect(oldPortRow?.entity_key).toBe("server.http");
        expect(oldPortRow?.predicate_slot).toBe("port");
        expect(oldPortRow?.superseded_by_id).toBe(newPortId);
        expect(oldPortRow?.expired_at).not.toBeNull();
        expect(oldPortRow?.valid_to).not.toBeNull();
        expect(oldPortRow?.memory_tier).toBe("cold");

        // New port remains open and active
        expect(newPortRow?.superseded_by_id).toBeNull();
        expect(newPortRow?.valid_to).toBeNull();

        // Different predicate_slot on same entity_key is NOT invalidated (Graphiti Issue #1728 defense)
        expect(pkgRow?.entity_key).toBe("server.http");
        expect(pkgRow?.predicate_slot).toBe("package_manager");
        expect(pkgRow?.superseded_by_id).toBeNull();
        expect(pkgRow?.expired_at).toBeNull();

        // Non-historical search returns only 8080, excluding superseded 8000
        const currentSearch = encode(
          yield* invoke({ projectId: id, action: "search", query: "server.http 포트" }),
        );
        expect(currentSearch).toContain("8080");
        expect(currentSearch).not.toContain("8000");

        // Historical search includes both 8000 and 8080
        const historicalSearch = encode(
          yield* invoke({
            projectId: id,
            action: "search",
            query: "과거 server.http 포트 변경 이력",
          }),
        );
        expect(historicalSearch).toContain("8080");
        expect(historicalSearch).toContain("8000");

        // Context retrieval reinforces access_count on injected records
        const ctx = yield* memory.context(id, "server.http 포트 설정 확인");
        expect(ctx).toContain("8080");
        const [reinforced] = yield* sql<{
          access_count: number;
          last_accessed_at: number | null;
        }>`SELECT access_count,last_accessed_at FROM workspace_memory_v2 WHERE id=${newPortId}`;
        expect(reinforced?.access_count).toBeGreaterThanOrEqual(1);
        expect(reinforced?.last_accessed_at).not.toBeNull();

        // Procedural memory file procedural/LESSONS.md is published
        const lessonsPath = `${memoryScopeDirectory(config.stateDir, id, "project")}/procedural/LESSONS.md`;
        expect(yield* fs.exists(lessonsPath)).toBe(true);
        const lessonsContent = yield* fs.readFileString(lessonsPath);
        expect(lessonsContent).toContain("절차적 기억 (Procedural Memory & Runbooks)");
        expect(lessonsContent).toContain("예약 작업으로 재시작");
      }),
  );

  it.effect(
    "keeps conversation reports visible, supersedes only a named entity's changed value, and writes nothing on an unchanged dream",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("slot-false-positive"),
          sql = yield* SqlClient.SqlClient,
          memory = yield* WorkspaceMemory;
        const thread = `t-${id}`;
        const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`;
        const messages = [
          [
            "fp-report-1",
            "assistant",
            "Portfolio/MultiServer/로 옮겼어. apps/server/src/check.ts 테스트 통과를 확인했습니다.",
          ],
          [
            "fp-report-2",
            "assistant",
            "Portfolio/MultiServer/로 옮겼어. db_broker.vbs로 실행하고 model_failed로 표시했으며 runtime.vbs로 시작했습니다. dBlockIndex 경로는 fail-closed로 두었고 apps/server/src/check.ts 테스트 통과를 다시 확인했습니다.",
          ],
          ["fp-user-topic", "user", "서버 포트를 8000으로 설정"],
          ["fp-report-topic", "assistant", "서버 포트를 9000으로 변경했습니다"],
          ["fp-user-entity", "user", "auth-api의 포트를 8000으로 설정"],
          ["fp-report-entity", "assistant", "auth-api의 포트를 9000으로 변경"],
          ["fp-report-change", "assistant", "auth-api의 포트 9000 → 9100"],
          [
            "fp-report-restated",
            "assistant",
            "auth-api의 포트를 9100으로 고정했습니다. 같은 값을 훨씬 길게 다시 설명하는 보고이며 apps/server/src/check.ts 테스트 통과도 함께 확인했습니다.",
          ],
        ] as const;
        for (const [index, [messageId, role, text]] of messages.entries())
          yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
            VALUES (${messageId},${thread},${role},${text},0,${day(index + 1)},${day(index + 1)})`;
        const idOf = (messageId: string) => memoryHash(`message:${messageId}`);
        const state = () =>
          sql<{
            id: string;
            entity_key: string | null;
            expired_at: number | null;
            valid_to: number | null;
            superseded_by_id: string | null;
            supersedes_ids: string;
          }>`SELECT id,entity_key,expired_at,valid_to,superseded_by_id,supersedes_ids
             FROM workspace_memory_v2 WHERE project_id=${id}`.pipe(
            Effect.map((rows) => new Map(rows.map((row) => [row.id, row]))),
          );
        const expectOnlyTheOldValueClosed = Effect.gen(function* () {
          const rows = yield* state();
          for (const [messageId] of messages) {
            const row = rows.get(idOf(messageId));
            if (messageId === "fp-report-entity") {
              expect(row?.superseded_by_id).toBe(idOf("fp-report-change"));
              expect(row?.expired_at).not.toBeNull();
              continue;
            }
            expect(row, messageId).toMatchObject({
              expired_at: null,
              valid_to: null,
              superseded_by_id: null,
            });
          }
          expect(rows.get(idOf("fp-report-1"))?.entity_key).toBeNull();
          expect(rows.get(idOf("fp-report-topic"))?.entity_key).toBeNull();
          expect(rows.get(idOf("fp-user-entity"))?.entity_key).toBe("auth-api");
          expect(decode(rows.get(idOf("fp-report-change"))!.supersedes_ids)).toEqual([
            idOf("fp-report-entity"),
          ]);
        });

        yield* memory.reconcile(id);
        yield* expectOnlyTheOldValueClosed;

        // Values an earlier version stored are recomputed, not trusted.
        yield* sql`UPDATE workspace_memory_v2 SET entity_key='이전 작업 보고',predicate_slot='port'
          WHERE id IN (${idOf("fp-report-1")},${idOf("fp-report-2")})`;
        yield* invoke({ projectId: id, action: "dream" });
        yield* invoke({ projectId: id, action: "dream" });
        yield* expectOnlyTheOldValueClosed;

        yield* sql`CREATE TABLE memory_update_log(id TEXT NOT NULL)`;
        yield* sql`CREATE TRIGGER memory_update_log_trigger AFTER UPDATE ON workspace_memory_v2
          BEGIN INSERT INTO memory_update_log(id) VALUES (new.id); END`;
        yield* invoke({ projectId: id, action: "dream" });
        expect(yield* sql`SELECT id FROM memory_update_log`).toEqual([]);
        yield* sql`UPDATE workspace_memory_v2 SET heat_score=heat_score+1 WHERE id=${idOf("fp-report-1")}`;
        yield* sql`DELETE FROM memory_update_log`;
        yield* invoke({ projectId: id, action: "dream" });
        expect(yield* sql`SELECT id FROM memory_update_log`).toEqual([{ id: idOf("fp-report-1") }]);
        yield* sql`DROP TRIGGER memory_update_log_trigger`;
        yield* sql`DROP TABLE memory_update_log`;
        yield* expectOnlyTheOldValueClosed;
      }),
  );

  it.effect("bounds procedural/LESSONS.md and leaves agent-authored candidates out of it", () =>
    Effect.gen(function* () {
      const id = yield* seed("lessons-cap"),
        sql = yield* SqlClient.SqlClient,
        memory = yield* WorkspaceMemory,
        config = yield* ServerConfig,
        fs = yield* FileSystem.FileSystem;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<300)
        INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        SELECT 'lesson-'||x,${`t-${id}`},'user',
          '배포 절차 런북 LESSONCAP-'||printf('%04d',x)||' '||${"순서대로 테스트를 통과시킨 뒤 예약 작업으로 재시작한다 ".repeat(8)},0,
          strftime('%Y-%m-%dT%H:%M:%fZ','2026-10-01','+'||x||' minutes'),
          strftime('%Y-%m-%dT%H:%M:%fZ','2026-10-01','+'||x||' minutes') FROM n`;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5)
        INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
        SELECT 'agent-lesson-'||x,${`t-${id}`},'assistant','AGENTLESSONCANARY 런북 절차 '||x||': 순서대로 실행했습니다',0,${at},${at} FROM n`;
      yield* memory.reconcile(id);
      const lessons = yield* fs.readFileString(
        `${memoryScopeDirectory(config.stateDir, id, "project")}/procedural/LESSONS.md`,
      );
      expect(Buffer.byteLength(lessons)).toBeLessThanOrEqual(PROCEDURAL_LESSONS_MAX_BYTES);
      expect(Buffer.byteLength(lessons)).toBeGreaterThan(PROCEDURAL_LESSONS_MAX_BYTES / 2);
      expect(lessons).toContain("LESSONCAP-0300");
      expect(lessons).not.toContain("LESSONCAP-0001");
      expect(lessons).toMatch(/용량 한도로 이전 절차 \d+개 생략/);
      expect(lessons).not.toContain("AGENTLESSONCANARY");
      expect(lessons).toContain("검증 대기 후보 5개");
      expect(lessons.split("\n").filter((line) => line.includes("LESSONCAP-0300"))).toHaveLength(1);
    }),
  );

  it.effect(
    "does not supersede existing settings on prohibition/question lines and caches derived row text across warm dreams",
    () =>
      Effect.gen(function* () {
        const id = yield* seed("followup-cache"),
          sql = yield* SqlClient.SqlClient,
          memory = yield* WorkspaceMemory;
        const thread = `t-${id}`;
        const seedMsgs = [
          ["f-1", "user", "auth-api의 포트를 8080으로 설정", "2026-10-01T00:00:00.000Z"],
          ["f-2", "user", "auth-api의 포트를 9000으로 변경하지 마", "2026-10-02T00:00:00.000Z"],
          ["f-3", "user", "auth-api의 포트를 9090으로 변경할까요?", "2026-10-03T00:00:00.000Z"],
          ["f-4", "user", "node의 버전은 v20 사용", "2026-10-04T00:00:00.000Z"],
          ["f-5", "user", "node의 버전은 v18 사용 금지", "2026-10-05T00:00:00.000Z"],
          ["f-6", "user", "node의 버전은 v18 사용하지 않는다", "2026-10-06T00:00:00.000Z"],
        ] as const;
        for (const [mid, role, text, ts] of seedMsgs) {
          yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
            VALUES (${mid},${thread},${role},${text},0,${ts},${ts})`;
        }
        yield* memory.reconcile(id);
        const rows = yield* sql<{
          id: string;
          entity_key: string | null;
          expired_at: number | null;
          superseded_by_id: string | null;
        }>`SELECT id,entity_key,expired_at,superseded_by_id FROM workspace_memory_v2 WHERE project_id=${id}`;
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(memoryHash("message:f-1"))).toMatchObject({
          entity_key: "auth-api",
          expired_at: null,
          superseded_by_id: null,
        });
        expect(byId.get(memoryHash("message:f-4"))).toMatchObject({
          entity_key: "node",
          expired_at: null,
          superseded_by_id: null,
        });
        for (const mid of ["f-2", "f-3", "f-5", "f-6"]) {
          expect(byId.get(memoryHash(`message:${mid}`))?.entity_key, mid).toBeNull();
        }
      }),
  );
});

it.effect(
  "warm dream avoids reading workspace_memory_v2.text for unchanged rows and matches an uncached run",
  () =>
    Effect.gen(function* () {
      const textSelectCalls: Array<string> = [];
      const baseLayer = Layer.provideMerge(
        sqlite,
        layerTest("/tmp", { prefix: "memory-v2-cache-spy-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer));

      const spySqlLayer = Layer.effect(
        SqlClient.SqlClient,
        Effect.gen(function* () {
          const inner = yield* SqlClient.SqlClient;
          const wrapped = new Proxy(inner, {
            apply(target, thisArg, argArray) {
              const strings = argArray[0];
              if (Array.isArray(strings)) {
                const raw = strings.join("?");
                if (raw.includes("FROM workspace_memory_v2") && /\btext\b/.test(raw)) {
                  textSelectCalls.push(raw);
                }
              }
              return Reflect.apply(
                target as unknown as (...args: unknown[]) => unknown,
                thisArg,
                argArray,
              );
            },
          });
          return wrapped;
        }),
      ).pipe(Layer.provideMerge(baseLayer));

      const fullLayer = WorkspaceMemory.layer.pipe(Layer.provideMerge(spySqlLayer));

      const snapshotColumns = (sql: SqlClient.SqlClient, projectId: string) =>
        sql<{
          id: string;
          entity_key: string | null;
          predicate_slot: string | null;
          cognitive_type: string | null;
          memory_tier: string | null;
          valid_from: number | null;
          valid_to: number | null;
          expired_at: number | null;
          superseded_by_id: string | null;
          supersedes_ids: string | null;
        }>`SELECT id,entity_key,predicate_slot,cognitive_type,memory_tier,valid_from,valid_to,expired_at,superseded_by_id,supersedes_ids
           FROM workspace_memory_v2 WHERE project_id=${projectId} ORDER BY id ASC`;

      const runWithMemory = (extraEdit: boolean) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const memory = yield* WorkspaceMemory;
          const id = ProjectId.make("cache-proj");
          yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,workspace_control_json) VALUES (${id},${id},'/tmp','[]',${at},${at},'{"conversationRag":{"enabled":true},"contextOptimization":{"autoChatMemory":true}}')`;
          yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES ('t-cache',${id},'Test',${at},${at})`;
          const msgs = [
            ["m1", "user", "auth-api의 포트를 8000으로 설정", "2026-10-01T00:00:00.000Z"],
            ["m2", "user", "일반 대화 메모입니다", "2026-10-02T00:00:00.000Z"],
            ["m3", "user", "배포 절차 런북: 테스트 후 재시작한다", "2026-10-03T00:00:00.000Z"],
          ] as const;
          for (const [mid, role, text, ts] of msgs) {
            yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
              VALUES (${mid},'t-cache',${role},${text},0,${ts},${ts})`;
          }
          // Backfill without dream so we can cleanly count cold vs warm dream reads.
          yield* memory.invoke({ projectId: id, action: "backfill" });
          textSelectCalls.length = 0;

          // 1st dream (cold cache)
          yield* memory.invoke({ projectId: id, action: "dream" });
          const coldTextReads = textSelectCalls.filter((q) => q.includes("SELECT id, text")).length;
          expect(coldTextReads).toBeGreaterThanOrEqual(1);
          const afterCold = yield* snapshotColumns(sql, id);

          // 2nd dream (warm cache, no changes) -> must NOT read workspace_memory_v2.text
          textSelectCalls.length = 0;
          yield* memory.invoke({ projectId: id, action: "dream" });
          const warmTextReads = textSelectCalls.filter((q) => q.includes("SELECT id, text")).length;
          expect(warmTextReads).toBe(0);
          const afterWarm = yield* snapshotColumns(sql, id);
          expect(afterWarm).toEqual(afterCold);

          if (extraEdit) {
            // Edit one row's text + updated_at (as persistCapture does) -> 3rd dream fetches only changed row
            const m2Id = memoryHash("message:m2");
            yield* sql`UPDATE workspace_memory_v2
              SET text='auth-api의 포트를 9000으로 변경',
                  source_hash=${memoryHash("edited-m2")},
                  updated_at='2026-10-10T00:00:00.000Z'
              WHERE id=${m2Id}`;
            textSelectCalls.length = 0;
            yield* memory.invoke({ projectId: id, action: "dream" });
            const editedTextReads = textSelectCalls.filter((q) =>
              q.includes("SELECT id, text"),
            ).length;
            expect(editedTextReads).toBe(1);
            const afterEdit = yield* snapshotColumns(sql, id);
            const m1Row = afterEdit.find((r) => r.id === memoryHash("message:m1"));
            const m2Row = afterEdit.find((r) => r.id === m2Id);
            expect(m2Row?.entity_key).toBe("auth-api");
            expect(m1Row?.superseded_by_id).toBe(m2Id);
            return afterEdit;
          }
          return afterWarm;
        }).pipe(Effect.provide(fullLayer));

      const cachedResult = yield* runWithMemory(true);

      // Build a brand-new uncached instance with the exact post-edit rows and compare columns
      const uncachedResult = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* WorkspaceMemory;
        const id = ProjectId.make("cache-proj");
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,workspace_control_json) VALUES (${id},${id},'/tmp','[]',${at},${at},'{"conversationRag":{"enabled":true},"contextOptimization":{"autoChatMemory":true}}')`;
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES ('t-cache',${id},'Test',${at},${at})`;
        const msgs = [
          ["m1", "user", "auth-api의 포트를 8000으로 설정", "2026-10-01T00:00:00.000Z"],
          ["m2", "user", "auth-api의 포트를 9000으로 변경", "2026-10-02T00:00:00.000Z"],
          ["m3", "user", "배포 절차 런북: 테스트 후 재시작한다", "2026-10-03T00:00:00.000Z"],
        ] as const;
        for (const [mid, role, text, ts] of msgs) {
          yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
            VALUES (${mid},'t-cache',${role},${text},0,${ts},${ts})`;
        }
        yield* memory.invoke({ projectId: id, action: "backfill" });
        yield* memory.invoke({ projectId: id, action: "dream" });
        return yield* snapshotColumns(sql, id);
      }).pipe(Effect.provide(layer));

      // Compare every derived column except expired_at wall-clock millisecond difference
      const stripExpiredMs = (rows: typeof cachedResult) =>
        rows.map(({ expired_at, ...rest }) => ({ ...rest, expired: expired_at !== null }));
      expect(stripExpiredMs(cachedResult)).toEqual(stripExpiredMs(uncachedResult));
    }),
);

it.effect(
  "separates user utterances & speech style files from AI outputs while allowing AI full visibility and speaker filtering",
  () =>
    Effect.gen(function* () {
      const id = yield* seed("sep-voice");
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const memory = yield* WorkspaceMemory;

      const threadId = ThreadId.make("t-sep-voice");
      const msgs = [
        [
          "u-voice-1",
          "user",
          "진단: 매우 긴 위원회 보고서 본문\n1. 항목 A\n2. 항목 B\n3. 항목 C\n4. 항목 D -> 이런 에러 뜬다.. 뭐야 이겡 (내 말투도 따로 저장했으면 해서)",
          "2026-11-24T01:00:00.000Z",
        ],
        [
          "u-voice-2",
          "user",
          "내가 다른 방 갔다 오면 과거를 자꾸 보여줘, 다 되었으면 결과만 보여주면 되는데 말이야",
          "2026-11-24T01:02:00.000Z",
        ],
        [
          "a-report-1",
          "assistant",
          "조사 결과: 언락 숏 C1 전략의 핵심 원인은 Checker 자기 승인 거절이었습니다.",
          "2026-11-24T01:03:00.000Z",
        ],
        [
          "u-voice-3",
          "user",
          "재시작 전에 내 대화와 AI가 작성한 결과를 분리해서 저장해줘",
          "2026-11-24T01:05:00.000Z",
        ],
      ] as const;

      for (const [mid, role, text, ts] of msgs) {
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
          VALUES (${mid},${threadId},${role},${text},0,${ts},${ts})`;
        if (role === "user") {
          yield* sql`INSERT INTO workspace_memory_v2_message_folders(project_id,message_id,thread_id,folder)
            VALUES (${id},${mid},${threadId},'')`;
        }
      }
      yield* sql`INSERT INTO projection_workspace_knowledge_items(
        item_id,project_id,kind,title,content,status,origin,scope,tags_json,created_at,updated_at
      ) VALUES (
        'k-agent-1',${id},'run-memory','6인 위원회 분석','위원회 합의 원문 보고서입니다.','active','agent','project','[]','2026-11-24T01:04:00.000Z','2026-11-24T01:04:00.000Z'
      )`;

      yield* invoke({ projectId: id, action: "backfill" });
      yield* invoke({ projectId: id, action: "dream" });

      const projectDir = memoryScopeDirectory(config.stateDir, id, "project");
      const styleMd = yield* fs.readFileString(
        `${projectDir}/user-utterances/USER_STYLE_PROFILE.md`,
      );
      const utterancesMd = yield* fs.readFileString(
        `${projectDir}/user-utterances/utterances-0000.md`,
      );
      const aiOutputsMd = yield* fs.readFileString(`${projectDir}/ai-outputs/outputs-0000.md`);
      const manifestMd = yield* fs.readFileString(`${projectDir}/MEMORY.md`);

      expect(styleMd).toContain("사용자 발화·말투 프로파일");
      expect(styleMd).toContain("화살표");
      expect(utterancesMd).toContain("뭐야 이겡");
      expect(utterancesMd).toContain("결과만 보여주면 되는데 말이야");
      expect(utterancesMd).not.toContain("Checker 자기 승인 거절이었습니다");

      expect(aiOutputsMd).toContain("Checker 자기 승인 거절이었습니다");
      expect(aiOutputsMd).toContain("위원회 합의 원문 보고서입니다");
      expect(aiOutputsMd).not.toContain("결과만 보여주면 되는데 말이야");
      expect(manifestMd).toContain("user-utterances/USER_STYLE_PROFILE.md");

      // AI speaker filtering on search
      const allHits = (yield* invoke({
        projectId: id,
        action: "search",
        query: "결과",
        speaker: "all",
      })) as ReadonlyArray<{ speaker?: string; text: string }>;
      const userHits = (yield* invoke({
        projectId: id,
        action: "search",
        query: "결과",
        speaker: "user",
      })) as ReadonlyArray<{ speaker?: string; text: string }>;
      const aiHits = (yield* invoke({
        projectId: id,
        action: "search",
        query: "결과",
        speaker: "ai",
      })) as ReadonlyArray<{ speaker?: string; text: string }>;

      expect(allHits.length).toBeGreaterThanOrEqual(2);
      expect(userHits.length).toBeGreaterThanOrEqual(1);
      expect(userHits.every((h) => h.speaker === "user")).toBe(true);
      expect(aiHits.length).toBeGreaterThanOrEqual(1);
      expect(aiHits.every((h) => h.speaker === "ai")).toBe(true);

      // AI speaker filtering on history
      const userHistory = (yield* invoke({
        projectId: id,
        action: "history",
        threadId,
        speaker: "user",
      })) as { entries: ReadonlyArray<{ role: string }> };
      const aiHistory = (yield* invoke({
        projectId: id,
        action: "history",
        threadId,
        speaker: "ai",
      })) as { entries: ReadonlyArray<{ role: string }> };
      expect(userHistory.entries.length).toBe(3);
      expect(userHistory.entries.every((e) => e.role === "user")).toBe(true);
      expect(aiHistory.entries.length).toBe(1);
      expect(aiHistory.entries.every((e) => e.role === "assistant")).toBe(true);

      // Dedicated user_style action
      const styleRes = (yield* invoke({
        projectId: id,
        action: "user_style",
      })) as { scope: string; profile: { totalUserMessages: number }; markdown: string };
      expect(styleRes.scope).toBe("project");
      expect(styleRes.profile.totalUserMessages).toBe(3);
      expect(styleRes.markdown).toContain("사용자 발화·말투 프로파일");

      // Context injection exposes both corpora + <t3_user_speech_profile>
      const ctx = yield* memory.context(id, "분리 저장 확인", false, {
        threadId,
        messageId: MessageId.make("u-voice-3"),
      });
      expect(ctx).toContain("<t3_recent_conversation>");
      expect(ctx).toContain("<t3_user_speech_profile>");
      expect(ctx).toContain("<t3_memory_v2>");
    }).pipe(Effect.provide(layer)),
);
