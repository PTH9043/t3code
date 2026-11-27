// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ProjectId, ThreadId, type WorkspaceMemoryAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { layerTest } from "../config.ts";
import { getEmbeddingModelMultilingualAdvisory } from "../documents/semanticSearch.ts";
import { layerConfig as sqlite } from "../persistence/Layers/Sqlite.ts";
import { buildStructuredWorkingCompaction } from "./BackgroundAutoCompactor.ts";
import { memoryHash } from "./memoryFiles.ts";
import { WorkspaceMemory, extractDeterministicEntitySlot } from "./WorkspaceMemory.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const layer = WorkspaceMemory.layer.pipe(
  Layer.provideMerge(sqlite),
  Layer.provideMerge(layerTest("/tmp", { prefix: "memory-v3-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const seedProject = Effect.fn(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-08-01T00:00:00.000Z";
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,workspace_control_json)
    VALUES (${id},${id},'/tmp','[]',${at},${at},'{"conversationRag":{"enabled":true},"contextOptimization":{"autoChatMemory":true}}')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at)
    VALUES (${`t-${id}`},${id},'아키텍처 의사결정',${at},${at})`;
  return ProjectId.make(id);
});

const invoke = Effect.fn(function* (input: WorkspaceMemoryAction) {
  const memory = yield* WorkspaceMemory;
  return decode(yield* memory.invoke(input));
});

it("extracts specific Korean named entity slots and strips honorifics while rejecting bare generic nouns", () => {
  expect(extractDeterministicEntitySlot("결제서버의 포트는 8080으로 변경", "")).toEqual({
    entityKey: "결제서버",
    predicateSlot: "port",
    normalizedValue: "8080",
    isNegationOrRollback: false,
  });
  expect(extractDeterministicEntitySlot("김민지님의 역할: 백엔드", "")).toEqual({
    entityKey: "김민지",
    predicateSlot: "role",
    normalizedValue: "백엔드",
    isNegationOrRollback: false,
  });
  expect(extractDeterministicEntitySlot("홍길동팀장의 모델: claude-opus", "")).toEqual({
    entityKey: "홍길동",
    predicateSlot: "model",
    normalizedValue: "claude-opus",
    isNegationOrRollback: false,
  });
  // Generic bare nouns must remain null
  expect(extractDeterministicEntitySlot("서버의 포트는 8080으로 변경", "")).toBeNull();
  expect(extractDeterministicEntitySlot("설정의 모델: gpt-5", "")).toBeNull();
});

it("preserves decisions, rationales, rejections, and open tasks in structured working compaction", () => {
  const compacted = buildStructuredWorkingCompaction([
    {
      role: "user",
      text: "비용 문제 때문에 B안으로 가기로 했어. 외부 유료 벡터DB는 절대 사용하지 마.",
    },
    ...Array.from({ length: 12 }, (_, idx) => ({
      role: idx % 2 === 0 ? "assistant" : "user",
      text: `중간 구현 로그 점검 단계 ${idx + 1}`,
    })),
    { role: "assistant", text: "마이그레이션 완료했으며 남은 작업: 통합 테스트 검증 예정" },
  ]);

  expect(compacted).toContain("[사전 압축 맥락 요약]");
  expect(compacted).toContain("[확정 결정 및 이유]");
  expect(compacted).toContain("비용 문제 때문에 B안으로 가기로 했어");
  expect(compacted).toContain("[기각된 대안 및 제약 조건]");
  expect(compacted).toContain("절대 사용하지 마");
  expect(compacted).toContain("[미해결 과제]");
});

it("flags English-only embedding models while passing multilingual models", () => {
  expect(getEmbeddingModelMultilingualAdvisory("bge-small-en-v1.5")).toContain("bge-m3");
  expect(getEmbeddingModelMultilingualAdvisory("all-minilm-l6-v2")).toContain("다국어 모델");
  expect(getEmbeddingModelMultilingualAdvisory("bge-m3")).toBeNull();
  expect(getEmbeddingModelMultilingualAdvisory("multilingual-e5-large")).toBeNull();
});

it.layer(layer)("WorkspaceMemory v3 Context Preservation", (it) => {
  it.effect(
    "protects reasoned decisions against casual A안 reconsideration, surfaces observations via 4-arm entity RRF, and preserves transition narrative on explicit override",
    () =>
      Effect.gen(function* () {
        const id = yield* seedProject("rationale-precedence");
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* WorkspaceMemory;
        const threadId = ThreadId.make(`t-${id}`);

        // 1) 3 months ago: reasoned decision for Plan B
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
          ('m-dec-1',${threadId},'user','비용 문제 때문에 결제 아키텍처는 B안으로 가기로 했어.',0,'2026-08-24T03:00:00.000Z','2026-08-24T03:00:00.000Z'),
          ('m-ask-2',${threadId},'user','그냥 A안으로 할까?',0,'2026-11-24T03:00:00.000Z','2026-11-24T03:00:00.000Z')`;
        yield* sql`INSERT INTO workspace_memory_v2_message_folders(project_id,message_id,thread_id,folder) VALUES
          (${id},'m-dec-1',${threadId},''),
          (${id},'m-ask-2',${threadId},'')`;

        yield* memory.reconcile(id);

        // Fact 1 must remain immutable and active
        const fact1Id = memoryHash("message:m-dec-1");
        const [fact1] = yield* sql<{
          memory_layer: string;
          rationale: string | null;
          superseded_by_id: string | null;
        }>`SELECT memory_layer, rationale, superseded_by_id FROM workspace_memory_v2 WHERE id=${fact1Id}`;
        expect(fact1).toMatchObject({
          memory_layer: "fact",
          rationale: "비용 문제",
          superseded_by_id: null,
        });

        // Observation must NOT be superseded by casual "그냥 A안으로 할까?" question; it must augment with reconsideration note!
        const activeObs = yield* sql<{
          id: string;
          text: string;
          rationale: string | null;
          proof_fact_ids: string;
          superseded_by_id: string | null;
        }>`SELECT id, text, rationale, proof_fact_ids, superseded_by_id
           FROM workspace_memory_v2
           WHERE project_id=${id} AND memory_layer='observation' AND superseded_by_id IS NULL`;
        expect(activeObs).toHaveLength(1);
        expect(activeObs[0]?.text).toContain("B안");
        expect(activeObs[0]?.text).toContain("재검토 질문 발생");
        expect(decode(activeObs[0]!.proof_fact_ids)).toContain(fact1Id);

        // Even when user asks only "그냥 A안으로 할까?" (no word "비용" or "B안"!), 4-arm Entity RRF ("option_plan") recalls the B안 observation!
        const ctx = yield* memory.context(id, "그냥 A안으로 할까?", false, {
          threadId,
          messageId: MessageId.make("m-ask-2"),
        });
        expect(ctx).toContain("[관찰");
        expect(ctx).toContain("B안");
        expect(ctx).toContain("비용");

        // Reflect action returns structured 3-step ladder (directives + observations + rawFacts)
        const reflected = (yield* invoke({
          projectId: id,
          action: "reflect",
          query: "결제 A안으로 바꿀까?",
        })) as {
          ladder: string;
          observations: ReadonlyArray<{
            id: string;
            rationale: string | null;
            proofFactIds: string[];
          }>;
          rawFacts: ReadonlyArray<{ id: string }>;
        };
        expect(reflected.ladder).toBe("directives -> observations -> raw_facts");
        expect(reflected.observations.length).toBeGreaterThanOrEqual(1);
        expect(reflected.observations[0]?.proofFactIds).toContain(fact1Id);

        // Read on observation ID works directly
        const readObs = (yield* invoke({
          projectId: id,
          action: "read",
          id: activeObs[0]!.id,
        })) as { text: string; proofFactIds: string[] };
        expect(readObs.text).toContain("B안");
        expect(readObs.proofFactIds).toContain(fact1Id);

        // 2) Explicit override with new reason -> closes prior observation & synthesizes transition narrative while keeping raw facts intact
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES
          ('m-dec-3',${threadId},'user','예산 증액 덕분에 이제부터 결제 아키텍처는 A안으로 전환하기로 결정했다.',0,'2026-11-24T09:00:00.000Z','2026-11-24T09:00:00.000Z')`;
        yield* sql`INSERT INTO workspace_memory_v2_message_folders(project_id,message_id,thread_id,folder) VALUES
          (${id},'m-dec-3',${threadId},'')`;

        yield* memory.reconcile(id);

        const obsAfterOverride = yield* sql<{
          id: string;
          text: string;
          superseded_by_id: string | null;
          proof_fact_ids: string;
        }>`SELECT id, text, superseded_by_id, proof_fact_ids
           FROM workspace_memory_v2
           WHERE project_id=${id} AND memory_layer='observation'
           ORDER BY valid_from ASC`;
        expect(obsAfterOverride).toHaveLength(2);
        expect(obsAfterOverride[0]?.superseded_by_id).toBe(obsAfterOverride[1]?.id);
        expect(obsAfterOverride[1]?.superseded_by_id).toBeNull();
        expect(obsAfterOverride[1]?.text).toContain("구 결정");
        expect(obsAfterOverride[1]?.text).toContain("예산 증액");
        expect(obsAfterOverride[1]?.text).toContain("전환");
        expect(decode(obsAfterOverride[1]!.proof_fact_ids)).toEqual(
          expect.arrayContaining([fact1Id, memoryHash("message:m-dec-3")]),
        );

        // Scrubs Korean RRN before persisting manual or message memory
        yield* invoke({
          projectId: id,
          action: "remember",
          requestId: "pii-test-note",
          topic: "고객 문의 메모",
          text: "고객 주민번호 900115-1234567 및 연락처 010-5555-6666 확인",
        });
        const piiHits = encode(
          yield* invoke({ projectId: id, action: "search", query: "고객 문의 메모" }),
        );
        expect(piiHits).toContain("[민감정보 제거: 주민등록번호]");
        expect(piiHits).not.toContain("900115-1234567");
        expect(piiHits).not.toContain("010-5555-6666");
      }),
  );
});
