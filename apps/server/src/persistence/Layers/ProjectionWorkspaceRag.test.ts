import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeItem,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  ProjectionWorkspaceRagRepositoryLive,
  chunkWorkspaceKnowledgeContent,
} from "./ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceRagRepository } from "../Services/ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceKnowledgeRepository } from "../Services/ProjectionWorkspaceKnowledge.ts";
import { ProjectionWorkspaceKnowledgeRepositoryLive } from "./ProjectionWorkspaceKnowledge.ts";

const layer = it.layer(
  Layer.merge(
    ProjectionWorkspaceRagRepositoryLive,
    ProjectionWorkspaceKnowledgeRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const decodeEmbeddingInput = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ input: Schema.Array(Schema.String) })),
);
const semanticLayer = ProjectionWorkspaceRagRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSettingsService.layerTest({ aiSearch: { semanticEnabled: true } })),
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body._tag !== "Uint8Array") throw new Error("Expected embedding JSON");
          const texts = decodeEmbeddingInput(new TextDecoder().decode(request.body.body)).input;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              embeddings: texts.map((text) =>
                text.includes("task: search") || text.includes("historic cancellation")
                  ? [1, 0]
                  : [0, 1],
              ),
            }),
          );
        }),
      ),
    ),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "rag-full-coverage-" })),
  Layer.provide(NodeServices.layer),
);
it.effect(
  "retrieves an old semantic-only decision beyond 1000 recent chunks while prefiltering scope and exclusions",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient,
        rag = yield* ProjectionWorkspaceRagRepository;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1201)
    INSERT INTO projection_workspace_rag_chunks(project_id,item_id,kind,chunk_index,title,content,updated_at,tags_text,search_title,search_tags,search_body,scope)
    SELECT 'semantic-pages','source-'||x,'rag-source','0','Evidence',CASE WHEN x=1 THEN 'historic cancellation rule' ELSE 'unrelated source '||x END,CASE WHEN x=1 THEN '2020-01-01' ELSE '2026-10-19' END,'','','','','project' FROM n`;
      for (const [project, item, scope, folder] of [
        ["foreign", "hidden", "project", null],
        ["semantic-pages", "folder-hidden", "folder", "private"],
        ["semantic-pages", "excluded", "project", null],
      ] as const) {
        yield* sql`INSERT INTO projection_workspace_rag_chunks(project_id,item_id,kind,chunk_index,title,content,updated_at,tags_text,search_title,search_tags,search_body,scope,applies_to_folder) VALUES (${project},${item},'rag-source','0','Evidence','historic cancellation rule','2026-10-19','','','','',${scope},${folder})`;
      }
      const request = {
        projectId: ProjectId.make("semantic-pages"),
        query: "취소 기한",
        limit: 3,
        excludedSourceKeys: ['["semantic-pages","excluded"]'],
      };
      yield* rag.search(request);
      if (!rag.drainSemanticIndex) throw new Error("Expected background semantic indexing");
      yield* rag.drainSemanticIndex;
      const result = yield* rag.search(request);
      expect(result.matches.map((row) => row.itemId)).toEqual(["source-1"]);
      expect(result.matches[0]?.semanticSimilarity).toBe(1);
      expect(result.retrieval).toMatchObject({
        method: "hybrid",
        indexedChunks: 1201,
        totalChunks: 1201,
      });
      const transactional = yield* sql.withTransaction(
        rag.search({
          projectId: ProjectId.make("semantic-pages"),
          query: "취소 기한",
          excludedSourceKeys: ['["semantic-pages","excluded"]'],
        }),
      );
      expect(transactional.matches.map((row) => row.itemId)).toEqual(["source-1"]);
    }).pipe(Effect.provide(semanticLayer)),
);

it.effect(
  "keeps scoped keyword evidence and explains a missing model through the async embedding boundary",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rag = yield* ProjectionWorkspaceRagRepository;
      for (const project of ["model-fallback", "foreign-fallback"]) {
        yield* sql`INSERT INTO projection_workspace_rag_chunks(project_id,item_id,kind,chunk_index,title,content,updated_at,tags_text,search_title,search_tags,search_body,scope)
        VALUES (${project},'source','rag-source',0,'한국어 근거','모델 설치 전에도 한국어 검색 근거를 보존한다.','2026-10-23','','한국어 근거','','한국어 검색 근거','project')`;
      }
      const request = {
        projectId: ProjectId.make("model-fallback"),
        query: "한국어 근거",
      };
      expect((yield* rag.search(request)).retrieval?.method).toBe("keyword");
      if (!rag.drainSemanticIndex) throw new Error("Expected semantic indexing worker");
      yield* rag.drainSemanticIndex;
      const result = yield* rag.search(request);
      expect(result.matches.map((match) => match.projectId)).toEqual(["model-fallback"]);
      expect(result.retrieval).toMatchObject({ method: "keyword" });
      expect(result.retrieval?.message).toContain("bge-m3:latest");
      expect(result.retrieval?.message).toContain("설치되어 있지 않습니다");
      if (rag.drainSemanticIndex) yield* rag.drainSemanticIndex;
    }).pipe(
      Effect.provide(
        ProjectionWorkspaceRagRepositoryLive.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(
            ServerSettingsService.layerTest({
              aiSearch: { semanticEnabled: true, embeddingModel: "bge-m3:latest" },
            }),
          ),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json({ error: "model 'bge-m3:latest' not found" }, { status: 404 }),
                  ),
                ),
              ),
            ),
          ),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "rag-model-fallback-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

function item(input: {
  readonly projectId: string;
  readonly content: string;
  readonly kind?: WorkspaceKnowledgeItem["kind"];
  readonly status?: WorkspaceKnowledgeItem["status"];
}): WorkspaceKnowledgeItem {
  return {
    id: WorkspaceKnowledgeItemId.make("shared-item"),
    projectId: ProjectId.make(input.projectId),
    kind: input.kind ?? "rag-source",
    title: `${input.projectId} source`,
    content: input.content,
    status: input.status ?? "active",
    origin: "user",
    relativeFolder: null,
    tags: [],
    originalChars: null,
    storedChars: null,
    promptUses: 0,
    lastUsedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T01:00:00.000Z",
  };
}

layer("ProjectionWorkspaceRagRepository", (it) => {
  it.effect(
    "indexes design components and layout while retaining image source and version metadata",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionWorkspaceRagRepository;
        const knowledge = yield* ProjectionWorkspaceKnowledgeRepository;
        const designItem: WorkspaceKnowledgeItem = {
          ...item({ projectId: "design-project", content: "Reusable dashboard reference" }),
          research: {
            query: "dashboard",
            sources: ["https://figma.com/design/test"],
            capturedAt: "2026-10-05T00:00:00Z",
            verification: "unverified",
            design: {
              version: "v2",
              components: ["TaskCard", "StatusBadge"],
              layout: "Two-column dark dashboard",
              images: [{ url: "https://example.com/ui.png", caption: "Overview" }],
              sourceUrl: "https://figma.com/design/test",
            },
          },
        };
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,workspace_control_json,created_at,updated_at,deleted_at) VALUES (${designItem.projectId},'Design','D:/design',NULL,'[]','{"isolationMode":"strict","longTermMemoryRoot":null}','2026-10-05T00:00:00Z','2026-10-05T00:00:00Z',NULL)`;
        yield* knowledge.upsert(designItem);
        yield* repository.replaceItem(designItem);
        const result = yield* repository.search({
          projectId: designItem.projectId,
          query: "StatusBadge",
          limit: 5,
          includeLongTermMemory: true,
          includeShared: false,
        });
        expect(result.matches.length).toBeGreaterThan(0);
        expect(result.matches[0]?.research?.design?.images[0]?.url).toBe(
          "https://example.com/ui.png",
        );
        expect(result.matches[0]?.research?.design?.version).toBe("v2");
      }),
  );
  it.effect(
    "excludes only the qualified source before limits without removing its original search path",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionWorkspaceRagRepository;
        const first = {
          ...item({ projectId: "prefilter-a", content: "archive evidence ".repeat(800) }),
          scope: "environment" as const,
        };
        const second = {
          ...item({ projectId: "prefilter-b", content: "archive evidence retained current fact" }),
          scope: "environment" as const,
        };
        yield* repository.replaceItem(first);
        yield* repository.replaceItem(second);
        const request = {
          projectId: first.projectId,
          query: "archive evidence",
          includeShared: true,
          limit: 1,
          maxChunksPerItem: 3,
        };
        const result = yield* repository.search({
          ...request,
          excludedSourceKeys: ['["prefilter-a","shared-item"]'],
        });
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]?.projectId).toBe(second.projectId);
        const originals = yield* repository.search({ ...request, includeShared: false });
        expect(originals.matches[0]?.projectId).toBe(first.projectId);
        const localByDefault = yield* repository.search({
          projectId: first.projectId,
          query: "archive evidence",
          limit: 20,
        });
        expect(localByDefault.matches.length).toBeGreaterThan(0);
        expect(localByDefault.matches.every((match) => match.projectId === first.projectId)).toBe(
          true,
        );
      }),
  );
  it.effect(
    "returns separate required chunks on request while keeping the total and per-item caps",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionWorkspaceRagRepository;
        const source = {
          ...item({
            projectId: "multi-chunk",
            content:
              "latencyBefore 1.467. " + "neutral filler ".repeat(180) + "latencyAfter 5.897.",
          }),
          title: "Benchmark evidence",
        };
        yield* repository.replaceItem(source);
        const query = { projectId: source.projectId, query: "latencyBefore latencyAfter" };
        expect((yield* repository.search(query)).matches).toHaveLength(1);
        const result = yield* repository.search({ ...query, maxChunksPerItem: 2 });
        expect(result.matches).toHaveLength(2);
        expect(new Set(result.matches.map((match) => match.chunkId)).size).toBe(2);
        expect(result.matches.map((match) => match.content).join("\n")).toContain("1.467");
        expect(result.matches.map((match) => match.content).join("\n")).toContain("5.897");
        expect(
          (yield* repository.search({ ...query, maxChunksPerItem: 3, limit: 1 })).matches,
        ).toHaveLength(1);
      }),
  );
  it.effect(
    "returns stable chunk IDs and current lineage from the canonical knowledge record",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const knowledge = yield* ProjectionWorkspaceKnowledgeRepository;
        const repository = yield* ProjectionWorkspaceRagRepository;
        const projectId = ProjectId.make("lineage-roundtrip");
        yield* sql`INSERT INTO projection_projects (
        project_id,title,workspace_root,default_model_selection_json,scripts_json,
        workspace_control_json,created_at,updated_at,deleted_at
      ) VALUES (${projectId},'Lineage','D:/lineage',NULL,'[]',
        '{"isolationMode":"strict","longTermMemoryRoot":null}',
        '2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z',NULL)`;
        const source: WorkspaceKnowledgeItem = {
          ...item({ projectId, content: "Unique benchmark lineage evidence" }),
          research: {
            query: "benchmark",
            sources: ["receipt-1"],
            capturedAt: "2026-09-12T00:00:00.000Z",
            verification: "verified",
            lineage: {
              canonicalId: "benchmark",
              revision: 2,
              supersedes: [WorkspaceKnowledgeItemId.make("old")],
              evidenceRefs: ["receipt-1"],
            },
          },
        };
        yield* knowledge.upsert(source);
        yield* repository.replaceItem(source);
        expect((yield* knowledge.listByProjectId({ projectId }))[0]?.research).toEqual(
          source.research,
        );
        const initial = (yield* repository.search({ projectId, query: "Unique benchmark" }))
          .matches[0];
        expect(initial?.chunkId).toBe("0");
        expect(initial?.research).toEqual(source.research);
        const revised = {
          ...source,
          research: { ...source.research!, verification: "contradicted" as const },
        };
        yield* knowledge.upsert(revised);
        const changed = (yield* repository.search({ projectId, query: "Unique benchmark" }))
          .matches[0];
        expect(changed?.research?.verification).toBe("contradicted");
        expect(changed?.chunkId).toBe(initial?.chunkId);
        yield* repository.replaceItem({ ...revised, status: "archived" });
        expect(
          (yield* repository.search({ projectId, query: "Unique benchmark" })).matches,
        ).toEqual([]);
      }),
  );
  it.effect("shares only environment memory and preserves same-id sources", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkspaceRagRepository;
      for (const projectId of ["scope-a", "scope-b"]) {
        yield* repository.replaceItem({
          ...item({ projectId, content: "공용 오케스트라 검증 기준" }),
          scope: "environment",
        });
      }
      const projectId = ProjectId.make("scope-consumer");
      const result = yield* repository.search({
        projectId,
        query: "오케스트라",
        includeShared: true,
      });
      expect(result.matches.map((match) => match.projectId).sort()).toEqual(["scope-a", "scope-b"]);
      expect(
        (yield* repository.search({ projectId, query: "오케스트라", includeShared: false }))
          .matches,
      ).toEqual([]);
      yield* repository.replaceItem({
        ...item({ projectId: "scope-a", content: "공용 오케스트라 검증 기준" }),
        scope: "project",
      });
      expect(
        (yield* repository.search({
          projectId,
          query: "오케스트라",
          includeShared: true,
        })).matches.map((match) => match.projectId),
      ).toEqual(["scope-b"]);
      for (const source of ["scope-a", "scope-b"]) {
        yield* repository.removeItem({
          projectId: ProjectId.make(source),
          itemId: WorkspaceKnowledgeItemId.make("shared-item"),
        });
      }
    }),
  );

  it.effect("matches folder descendants without exposing siblings or other projects", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkspaceRagRepository;
      const projectId = ProjectId.make("folder-scope");
      yield* repository.replaceItem({
        ...item({ projectId, content: "블록 렌더링 성능 검증" }),
        scope: "folder",
        appliesToFolder: "apps/web",
      });
      for (const contextPaths of [[], ["apps/web-extra"], ["apps/server"]]) {
        expect(
          (yield* repository.search({ projectId, query: "렌더링", contextPaths })).matches,
        ).toEqual([]);
      }
      for (const contextPaths of [["apps/web"], ["apps/web/src/Chat.tsx"], ["apps\\web\\src"]]) {
        expect(
          (yield* repository.search({ projectId, query: "렌더링", contextPaths })).matches,
        ).toHaveLength(1);
      }
      expect(
        (yield* repository.search({
          projectId: ProjectId.make("other"),
          query: "렌더링",
          contextPaths: ["apps/web"],
        })).matches,
      ).toEqual([]);
    }),
  );
  it.effect("only returns the selected folder when sibling folders contain matching evidence", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkspaceRagRepository;
      const projectId = ProjectId.make("folder-siblings");
      for (const [id, folder] of [
        ["web", "apps/web"],
        ["server", "apps/server"],
      ] as const) {
        yield* repository.replaceItem({
          ...item({ projectId, content: `shared retrieval keyword for ${folder}` }),
          id: WorkspaceKnowledgeItemId.make(id),
          scope: "folder",
          appliesToFolder: folder,
        });
      }
      yield* repository.replaceItem({
        ...item({ projectId, content: "shared retrieval keyword root evidence" }),
        id: WorkspaceKnowledgeItemId.make("root"),
        scope: "project",
      });
      for (const [id, folder] of [
        ["web", "apps/web"],
        ["server", "apps/server"],
      ] as const) {
        const result = yield* repository.search({
          projectId,
          query: "shared retrieval keyword",
          contextPaths: [folder],
        });
        expect(result.matches.map((match) => match.itemId)).toEqual([id]);
      }
      const root = yield* repository.search({
        projectId,
        query: "shared retrieval keyword",
        contextPaths: [],
      });
      expect(root.matches.map((match) => match.itemId)).toEqual(["root"]);
    }),
  );

  it.effect("never returns another Workspace's matching chunks", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkspaceRagRepository;
      const itemA = item({
        projectId: "workspace-a",
        content: "The confidential launch code belongs only to Workspace A.",
      });
      const itemB = item({
        projectId: "workspace-b",
        content: "Workspace B contains a public release checklist.",
      });
      yield* repository.replaceItem(itemA);
      yield* repository.replaceItem(itemB);

      const searchA = yield* repository.search({
        projectId: itemA.projectId,
        query: "confidential launch",
      });
      const searchB = yield* repository.search({
        projectId: itemB.projectId,
        query: "confidential launch",
      });
      expect(searchA.matches).toHaveLength(1);
      expect(searchA.matches[0]?.title).toBe("workspace-a source");
      expect(searchB.matches).toEqual([]);

      yield* repository.removeItem({ projectId: itemA.projectId, itemId: itemA.id });
      expect(
        (yield* repository.search({
          projectId: itemA.projectId,
          query: "confidential",
        })).matches,
      ).toEqual([]);
    }),
  );

  it.effect("includes long-term memory only when requested and ignores inactive sources", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkspaceRagRepository;
      const projectId = ProjectId.make("workspace-memory");
      yield* repository.replaceItem(
        item({
          projectId,
          content: "A durable preference for cobalt interfaces.",
          kind: "long-term-memory",
        }),
      );

      expect(
        (yield* repository.search({
          projectId,
          query: "cobalt",
          includeLongTermMemory: false,
        })).matches,
      ).toEqual([]);
      expect(
        (yield* repository.search({
          projectId,
          query: "cobalt",
          includeLongTermMemory: true,
        })).matches,
      ).toHaveLength(1);

      yield* repository.replaceItem(
        item({
          projectId,
          content: "A durable preference for cobalt interfaces.",
          kind: "long-term-memory",
          status: "archived",
        }),
      );
      expect(
        (yield* repository.search({
          projectId,
          query: "cobalt",
          includeLongTermMemory: true,
        })).matches,
      ).toEqual([]);
    }),
  );

  it.effect("finds Korean words through attached particles and endings", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkspaceRagRepository;
      const projectId = ProjectId.make("workspace-korean");
      yield* repository.replaceItem({
        ...item({
          projectId,
          content: "이번 분기 수익률을 개선했고 지갑별 매수 내역을 검증했다.",
        }),
        id: WorkspaceKnowledgeItemId.make("korean-note"),
        title: "분기 운영 기록",
      });
      // Every one of these missed under the 041 index: "수익률을" was a
      // single token that neither "수익" nor "수익률" could reach.
      for (const query of ["수익", "수익률", "지갑", "매수한 내역", "검증을 다시"]) {
        const result = yield* repository.search({ projectId, query });
        expect(
          result.matches.map((match) => match.itemId),
          query,
        ).toEqual(["korean-note"]);
      }
      const [match] = (yield* repository.search({ projectId, query: "수익" })).matches;
      expect(match?.content).toContain("지갑별 매수 내역");
      expect(match?.snippet).toContain("[수익]률을");
    }),
  );

  it.effect("ranks the chunk covering more of the question first, one match per item", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkspaceRagRepository;
      const projectId = ProjectId.make("workspace-rank");
      yield* repository.replaceItem({
        ...item({ projectId, content: "대시보드 대시보드 대시보드 색상만 다룬다." }),
        id: WorkspaceKnowledgeItemId.make("repeats-one"),
        title: "색상 메모",
      });
      yield* repository.replaceItem({
        ...item({ projectId, content: "로그인 화면 대시보드의 차트 배치 가이드." }),
        id: WorkspaceKnowledgeItemId.make("covers-all"),
        title: "화면 가이드",
      });
      const result = yield* repository.search({ projectId, query: "로그인 대시보드 차트" });
      expect(result.matches[0]?.itemId).toBe("covers-all");
      expect(new Set(result.matches.map((match) => match.itemId)).size).toBe(result.matches.length);
    }),
  );

  it("chunks large sources deterministically with bounded pieces", () => {
    const chunks = chunkWorkspaceKnowledgeContent("paragraph ".repeat(500));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1_200)).toBe(true);
  });
});
