// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { MessageId, ProjectId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionWorkspaceKnowledgeRepositoryLive } from "../persistence/Layers/ProjectionWorkspaceKnowledge.ts";
import { ProjectionWorkspaceRagRepositoryLive } from "../persistence/Layers/ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceKnowledgeRepository } from "../persistence/Services/ProjectionWorkspaceKnowledge.ts";
import { ProjectionWorkspaceRagRepository } from "../persistence/Services/ProjectionWorkspaceRag.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";
import { docxFixture, pdfFixture, xlsxFixture } from "./documentFixtures.ts";
import { prepareAttachmentDocumentRag } from "./attachmentDocumentRag.ts";
import { ReadOnlyResultCache } from "./ReadOnlyResultCache.ts";

it.layer(
  Layer.mergeAll(
    ProjectionWorkspaceKnowledgeRepositoryLive,
    ProjectionWorkspaceRagRepositoryLive,
    ReadOnlyResultCache.layer,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer)),
)("attachment document RAG", (it) => {
  it.effect(
    "extracts, indexes, retrieves positioned evidence, reuses cache and removes obsolete search results",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-document-rag-" });
        const knowledge = yield* ProjectionWorkspaceKnowledgeRepository;
        const rag = yield* ProjectionWorkspaceRagRepository;
        const projectId = ProjectId.make("document-project");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Documents', 'D:/document-test', '[]', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z')`;
        const threadId = ThreadId.make("document-thread");
        let sequence = 0;
        const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
          Effect.gen(function* () {
            if (command.type === "project.knowledge.item.upsert") {
              const item = {
                id: command.itemId,
                projectId: command.projectId,
                kind: command.kind,
                title: command.title,
                content: command.content,
                status: command.status,
                origin: command.origin,
                relativeFolder: command.relativeFolder,
                scope: command.scope ?? ("project" as const),
                appliesToFolder: null,
                tags: command.tags,
                research: command.research ?? null,
                originalChars: command.originalChars ?? null,
                storedChars: command.storedChars ?? null,
                promptUses: 0,
                lastUsedAt: null,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              };
              yield* knowledge.upsert(item);
              yield* rag.replaceItem(item);
            } else if (command.type === "project.knowledge.item.archive") {
              yield* knowledge.archive({
                projectId: command.projectId,
                itemId: command.itemId,
                archivedAt: command.createdAt,
              });
              yield* rag.removeItem({ projectId: command.projectId, itemId: command.itemId });
            }
            return { sequence: ++sequence };
          });
        const attachments: ChatAttachment[] = [
          {
            id: "pdf-evidence",
            type: "file",
            name: "launch.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1,
          },
          {
            id: "word-evidence",
            type: "file",
            name: "terms.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 1,
          },
          {
            id: "excel-evidence",
            type: "file",
            name: "sales.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            sizeBytes: 1,
          },
        ];
        for (const [index, bytes] of [pdfFixture(), docxFixture(), xlsxFixture()].entries())
          yield* fs.writeFile(
            NodePath.join(directory, attachmentRelativePath(attachments[index]!)),
            bytes,
          );
        const prepare = (files: readonly ChatAttachment[], query: string) =>
          prepareAttachmentDocumentRag({
            projectId,
            threadId,
            messageId: MessageId.make(`input-${sequence}`),
            createdAt: "2026-10-12T00:00:00Z",
            stateDir: directory,
            attachmentsDir: directory,
            attachments: files,
            query,
            engine: { dispatch },
            queries: { searchWorkspaceRag: rag.search },
          });
        const first = yield* prepare(attachments, "Orchid 해지 해오름");
        expect(first.reports.map((report) => [report.status, report.message])).toEqual([
          ["indexed", null],
          ["indexed", null],
          ["indexed", null],
        ]);
        expect(first.prompt).toContain("7329");
        expect(first.prompt).toContain("17일");
        expect(first.prompt).toContain("381");
        expect(first.prompt).toContain("페이지 1");
        expect(first.prompt).toContain("문단 1");
        expect(first.prompt).toContain("매출");
        const reused = yield* prepare([attachments[1]!], "해지");
        expect(reused.reports[0]?.reused).toBe(true);
        const large: ChatAttachment = {
          type: "file",
          id: "large-text",
          name: "large.txt",
          mimeType: "text/plain",
          sizeBytes: 12 * 1024 * 1024,
        };
        yield* fs.writeFile(
          NodePath.join(directory, attachmentRelativePath(large)),
          Buffer.from("LARGE_DOCUMENT_EVIDENCE\n" + "bounded source text ".repeat(700_000)),
        );
        const largeResult = yield* prepare([large], "LARGE_DOCUMENT_EVIDENCE");
        expect(largeResult.reports[0]?.status).toBe("partial");
        expect(largeResult.reports[0]?.chars).toBeLessThanOrEqual(500_000);
        expect(largeResult.extracted.has(large.id)).toBe(true);
        expect(largeResult.prompt).toContain("LARGE_DOCUMENT_EVIDENCE");
        const later = yield* prepare([], "Cedar");
        expect(later.prompt).toContain("23 days");
        expect(later.prompt).toContain("페이지 2");
        expect(
          (yield* rag.search({
            projectId: ProjectId.make("other-project"),
            query: "Orchid",
            attachmentsOnly: true,
          })).matches,
        ).toHaveLength(0);
        yield* fs.writeFile(
          NodePath.join(directory, attachmentRelativePath(attachments[1]!)),
          docxFixture("한빛 반품 유효기간은 41일이다"),
        );
        const revised = yield* prepare([attachments[1]!], "반품");
        expect(revised.reports[0]?.contentHash).not.toBe(first.reports[1]?.contentHash);
        expect(revised.prompt).toContain("41일");
        expect(
          (yield* rag.search({ projectId, query: "해지", attachmentsOnly: true })).matches,
        ).toHaveLength(0);
        yield* fs.writeFile(
          NodePath.join(directory, attachmentRelativePath(attachments[1]!)),
          new Uint8Array(),
        );
        expect((yield* prepare([attachments[1]!], "반품")).reports[0]?.status).toBe("failed");
        expect(
          (yield* rag.search({ projectId, query: "반품", attachmentsOnly: true })).matches,
        ).toHaveLength(0);
        yield* knowledge.removeAttachmentDocuments({ projectId, threadId });
        expect(
          (yield* rag.search({ projectId, query: "Orchid 해오름", attachmentsOnly: true })).matches,
        ).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
});
