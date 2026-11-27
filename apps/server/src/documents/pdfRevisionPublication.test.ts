import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { attachmentRelativePath } from "../attachmentStore.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { knowledgeSourceKey } from "../orchestration/workspaceKnowledgeSelection.ts";
import { ProjectionWorkspaceRagRepository } from "../persistence/Services/ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceRagRepositoryLive } from "../persistence/Layers/ProjectionWorkspaceRag.ts";
import * as Liveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as Plans from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as Identity from "../project/RepositoryIdentityResolver.ts";
import { pdfFixture } from "./documentFixtures.ts";
import { indexPdfJob, purgePdfJobsForThread } from "./pdfIndexJob.ts";
import { readPdfDocumentRange } from "./pdfDocumentReader.ts";
import {
  getPdfRevisionStatus,
  startPdfRevision,
  runPdfRevision,
  retryPdfRevision,
  publishedPdfSource,
} from "./pdfRevision.ts";
import { revisionDigest } from "./pdfRevisionPaths.ts";
import { labelPdfRevisionHits } from "./pdfRevisionStore.ts";

const indexedPdf = (root: string, paths: { stateDir: string; attachmentsDir: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient,
      engine = yield* OrchestrationEngineService,
      queries = yield* ProjectionSnapshotQuery;
    const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem | Path.Path>());
    const ctx = { ...paths, engine },
      s = {
        projectId: ProjectId.make("p"),
        threadId: ThreadId.make("t"),
        messageId: MessageId.make("m"),
        attachmentId: "a",
      };
    const modelSelection = { instanceId: ProviderInstanceId.make("unused"), model: "unused" };
    const createdAt = "2026-01-01T00:00:00Z",
      { projectId, threadId, messageId } = s;
    const edition = (value: string, pages: number) =>
      pdfFixture(
        Array.from({ length: pages }, (_, i) =>
          i === pages - 1 ? "COURSEPOLICY " + value : "page " + (i + 1),
        ),
      );
    const first = edition("twenty", 65),
      second = edition("thirty", 65);
    const a = {
      type: "file" as const,
      id: s.attachmentId,
      name: "policy.pdf",
      mimeType: "application/pdf",
      sizeBytes: first.length,
    };
    yield* engine.dispatch({
      type: "project.create",
      projectId,
      title: "P",
      workspaceRoot: root,
      defaultModelSelection: modelSelection,
      commandId: CommandId.make("project"),
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      projectId,
      threadId,
      title: "T",
      modelSelection,
      branch: null,
      worktreePath: null,
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt,
      commandId: CommandId.make("room"),
    });
    yield* engine.dispatch({
      type: "thread.turn.start",
      threadId,
      commandId: CommandId.make("message"),
      createdAt,
      message: { messageId, role: "user", text: "fixture", attachments: [a] },
      runtimeMode: "approval-required",
      interactionMode: "default",
      modelSelection,
    });
    const original = path.join(paths.attachmentsDir, attachmentRelativePath(a));
    yield* fs.writeFile(original, first);
    yield* Effect.promise(() =>
      indexPdfJob({
        ...s,
        ...paths,
        createdAt,
        attachment: a,
        bytes: first,
        ocrEnabled: false,
        dispatch: (c) => run(engine.dispatch(c)),
        writeAtomic: (filePath, contents) => run(writeFileStringAtomically({ filePath, contents })),
      }),
    );
    const search = () =>
      queries.searchWorkspaceRag!({
        projectId,
        query: "COURSEPOLICY",
        attachmentsOnly: true,
        includeShared: false,
        limit: 12,
      });
    return {
      ctx,
      s,
      engine,
      sql,
      queries,
      rag: yield* ProjectionWorkspaceRagRepository,
      createdAt,
      original,
      edition,
      first,
      second,
      search,
      paths,
      threadId,
      root,
      fs,
    };
  });

function withPdf<E, R>(
  check: (fixture: Effect.Success<ReturnType<typeof indexedPdf>>) => Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pdf-publication-" });
    const paths = { stateDir: root, attachmentsDir: path.join(root, "attachments") };
    yield* fs.makeDirectory(paths.attachmentsDir, { recursive: true });
    const layers = Layer.mergeAll(
      ProjectionWorkspaceRagRepositoryLive,
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
      ),
      OrchestrationProjectionSnapshotQueryLive,
    ).pipe(
      Layer.provide(Liveness.layer),
      Layer.provide(Plans.layer),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(Identity.layer),
      Layer.provideMerge(makeSqlitePersistenceLive(path.join(root, "state.sqlite"))),
      Layer.provideMerge(ServerConfig.layerTest(root, root)),
    );
    yield* indexedPdf(root, paths).pipe(Effect.flatMap(check), Effect.provide(layers));
  }).pipe(Effect.scoped);
}

it.layer(NodeServices.layer)("explicit PDF revision publication", (it) => {
  it.effect(
    "rolls back both projected batches and source pointer if the second write fails, retries once and preserves source aliases",
    () =>
      withPdf(
        ({
          ctx,
          s,
          engine,
          sql,
          original,
          edition,
          first,
          second,
          search,
          paths,
          threadId,
          root,
          fs,
        }) =>
          Effect.gen(function* () {
            const old = (yield* search()).matches[0]!;
            const request = { requestId: "v2", expectedVersion: 1, bytes: second };
            yield* Effect.all(
              [startPdfRevision(ctx, s, request), startPdfRevision(ctx, s, request)],
              { concurrency: 2 },
            );
            yield* fs.remove(original);
            const savedSource = (yield* publishedPdfSource(ctx, s, 1)).path;
            yield* fs.remove(savedSource);
            expect(
              revisionDigest(yield* fs.readFile((yield* publishedPdfSource(ctx, s, 1)).path)),
            ).toBe(revisionDigest(first));
            yield* sql`CREATE TRIGGER stop_second BEFORE UPDATE ON projection_workspace_knowledge_items
          WHEN NEW.item_id LIKE 'pdf-%-65' BEGIN SELECT RAISE(ABORT,'forced second item failure'); END`;
            expect((yield* Effect.result(runPdfRevision(ctx, s)))._tag).toBe("Failure");
            expect(yield* getPdfRevisionStatus(ctx, s)).toMatchObject({
              published: { version: 1 },
              pending: { version: 2, status: "failed" },
            });
            expect((yield* search()).matches).toEqual([
              {
                ...old,
                pdfRevision: { publishedVersion: 1, pending: { version: 2, status: "failed" } },
              },
            ]);
            expect(
              (yield* Effect.promise(() =>
                readPdfDocumentRange({ ...paths, ...s, page: 65, offset: 0, maxBytes: 128 }),
              )).contentHash,
            ).toBe(revisionDigest(first));
            yield* sql`DROP TRIGGER stop_second`;
            yield* retryPdfRevision(ctx, s);
            yield* Effect.all([runPdfRevision(ctx, s), runPdfRevision(ctx, s)], { concurrency: 2 });
            const latest = (yield* search()).matches;
            expect(latest).toHaveLength(1);
            expect(latest[0]).toMatchObject({
              itemId: old.itemId,
              pdfRevision: { publishedVersion: 2, pending: null },
              research: {
                attachment: { location: "페이지 65", contentHash: revisionDigest(second) },
              },
            });
            const publications = () =>
              sql<{
                n: number;
              }>`SELECT COUNT(*) n FROM orchestration_command_receipts WHERE command_id LIKE 'server:pdf-publish:%'`;
            expect((yield* publications())[0]!.n).toBe(1);
            yield* startPdfRevision(ctx, s, request);
            yield* runPdfRevision(ctx, s);
            expect((yield* publications())[0]!.n).toBe(1);
            expect(
              (yield* Effect.result(startPdfRevision(ctx, s, { ...request, bytes: first })))._tag,
            ).toBe("Failure");
            expect(
              (yield* Effect.result(
                getPdfRevisionStatus(ctx, { ...s, projectId: ProjectId.make("foreign") }),
              ))._tag,
            ).toBe("Failure");
            yield* startPdfRevision(ctx, s, {
              expectedVersion: 2,
              requestId: "shrink",
              bytes: edition("forty", 1),
            });
            const whilePending = (yield* search()).matches;
            expect(whilePending).toHaveLength(1);
            expect(whilePending[0]).toMatchObject({
              content: latest[0]!.content,
              research: { attachment: { contentHash: revisionDigest(second) } },
              pdfRevision: { publishedVersion: 2, pending: { version: 3, status: "indexing" } },
            });
            expect((yield* labelPdfRevisionHits(sql, [old]))[0]).not.toHaveProperty("pdfRevision");
            yield* runPdfRevision(ctx, s);
            expect(
              (yield* sql<{ item_id: string }>`SELECT item_id FROM pdf_revision_item_aliases`).map(
                (x) => x.item_id,
              ),
            ).toEqual([old.itemId]);
            expect((yield* search()).matches).toMatchObject([
              { pdfRevision: { publishedVersion: 3, pending: null } },
            ]);
            expect((yield* Effect.result(publishedPdfSource(ctx, s, 4)))._tag).toBe("Failure");
            yield* engine.dispatch({
              type: "thread.delete",
              commandId: CommandId.make("delete"),
              threadId,
            });
            expect(yield* sql`SELECT 1 FROM pdf_revision_versions`).toHaveLength(0);
            yield* Effect.promise(() => purgePdfJobsForThread(root, threadId));
            expect(yield* fs.exists(savedSource)).toBe(false);
          }),
      ),
  );

  it.effect(
    "rebuilds both batches when the same bytes are explicitly uploaded after a failed attempt is cleared",
    () =>
      withPdf(({ ctx, s, sql, first, second, search }) =>
        Effect.gen(function* () {
          const upload = { bytes: second, expectedVersion: 1, requestId: "A" };
          yield* startPdfRevision(ctx, s, upload);
          // A pending job registered on 099 has no attempt number and uses the old directory.
          yield* sql`UPDATE pdf_revision_versions SET source_attempt=NULL WHERE version=2`;
          yield* sql`CREATE TRIGGER interrupt_publication BEFORE UPDATE ON projection_workspace_knowledge_items
        WHEN NEW.item_id LIKE 'pdf-%-65' BEGIN SELECT RAISE(ABORT,'second item'); END`;
          expect((yield* Effect.result(runPdfRevision(ctx, s)))._tag).toBe("Failure");
          expect((yield* getPdfRevisionStatus(ctx, s)).pending).toMatchObject({
            status: "failed",
            lastPage: 65,
            totalPages: 65,
          });
          expect(yield* sql`SELECT first_page FROM pdf_revision_parts`).toHaveLength(2);
          yield* sql`DROP TRIGGER interrupt_publication`;
          expect(
            yield* startPdfRevision(ctx, s, {
              bytes: first,
              expectedVersion: 1,
              requestId: "clear",
            }),
          ).toMatchObject({ published: { version: 1 }, pending: null });
          expect(yield* sql`SELECT first_page FROM pdf_revision_parts`).toHaveLength(0);
          expect((yield* Effect.result(startPdfRevision(ctx, s, upload)))._tag).toBe("Failure");
          yield* startPdfRevision(ctx, s, { ...upload, requestId: "A-again" });
          yield* runPdfRevision(ctx, s);
          expect((yield* search()).matches).toMatchObject([
            { pdfRevision: { publishedVersion: 2, pending: null } },
          ]);
          expect((yield* publishedPdfSource(ctx, s, 2)).contentHash).toBe(revisionDigest(second));
        }),
      ),
  );

  it.effect(
    "keeps archived batches hidden when an already accepted revision tries to publish",
    () =>
      withPdf(({ ctx, s, engine, createdAt, edition, search }) =>
        Effect.gen(function* () {
          const original = (yield* search()).matches[0]!;
          yield* startPdfRevision(ctx, s, {
            bytes: edition("replacement", 65),
            expectedVersion: 1,
            requestId: "archive-review",
          });
          yield* engine.dispatch({
            type: "project.knowledge.item.archive",
            projectId: s.projectId,
            itemId: original.itemId,
            commandId: CommandId.make("manual-archive"),
            createdAt,
          });
          expect((yield* search()).matches).toHaveLength(0);
          expect((yield* Effect.result(runPdfRevision(ctx, s)))._tag).toBe("Failure");
          expect((yield* search()).matches).toHaveLength(0);
          expect(yield* getPdfRevisionStatus(ctx, s)).toMatchObject({
            published: { version: 1 },
            pending: { status: "failed" },
          });
        }),
      ),
  );

  it.effect(
    "keeps failed originals and accepts an explicit correction of the same unpublished edition",
    () =>
      withPdf(({ ctx, s, rag, sql, fs, first, second, paths, search }) =>
        Effect.gen(function* () {
          const broken = {
            bytes: Buffer.from("%PDF-1.7 incomplete"),
            expectedVersion: 1,
            requestId: "broken",
          };
          const correction = { bytes: second, expectedVersion: 1, requestId: "corrected" };
          yield* startPdfRevision(ctx, s, broken);
          expect((yield* Effect.result(runPdfRevision(ctx, s)))._tag).toBe("Failure");
          yield* retryPdfRevision(ctx, s);
          expect((yield* Effect.result(runPdfRevision(ctx, s)))._tag).toBe("Failure");
          expect(yield* startPdfRevision(ctx, s, correction)).toMatchObject({
            published: { version: 1 },
            pending: { version: 2, status: "indexing", contentHash: revisionDigest(second) },
          });
          expect((yield* Effect.result(startPdfRevision(ctx, s, broken)))._tag).toBe("Failure");
          const prior = (yield* search()).matches[0]!;
          expect(prior.research?.attachment?.contentHash).toBe(revisionDigest(first));
          yield* runPdfRevision(ctx, s);
          expect((yield* search()).matches).toMatchObject([
            { itemId: prior.itemId, pdfRevision: { publishedVersion: 2, pending: null } },
          ]);
          const excluded = yield* rag.search({
            projectId: s.projectId,
            query: "COURSEPOLICY",
            excludedSourceKeys: [knowledgeSourceKey(prior)],
            attachmentsOnly: true,
            includeShared: false,
          });
          expect(excluded.matches).toHaveLength(0);
          expect(
            revisionDigest(yield* fs.readFile((yield* publishedPdfSource(ctx, s, 2)).path)),
          ).toBe(revisionDigest(second));
          expect(
            (yield* Effect.promise(() =>
              readPdfDocumentRange({ ...paths, ...s, page: 65, offset: 0, maxBytes: 128 }),
            )).contentHash,
          ).toBe(revisionDigest(second));
          const [rejected] = yield* sql<{
            bytes: Uint8Array;
            error: string;
          }>`SELECT bytes,error FROM pdf_revision_failed_attempts`;
          expect(Buffer.from(rejected!.bytes)).toEqual(broken.bytes);
          expect(rejected!.error).toBeTruthy();
          expect((yield* Effect.result(startPdfRevision(ctx, s, broken)))._tag).toBe("Failure");
        }),
      ),
  );
});
