// @effect-diagnostics nodeBuiltinImport:off
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vite-plus/test";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { layerTest } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { WorkspaceKnowledgeFileStoreLive } from "../orchestration/Layers/WorkspaceKnowledgeFileStore.ts";
import { makeWorkspaceKnowledgeReactor } from "../orchestration/Layers/WorkspaceKnowledgeReactor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { pdfFixture } from "./documentFixtures.ts";
import { readPdfDocumentRange } from "./pdfDocumentReader.ts";
import { indexPdfJob } from "./pdfIndexJob.ts";
import {
  getPdfRevisionStatus,
  publishedPdfSource,
  resumePdfRevisions,
  retryPdfRevision,
  runPdfRevision,
  startPdfRevision,
} from "./pdfRevision.ts";
import { resolvePdfRevisionItem } from "./pdfRevisionRpc.ts";

const name = "관측소 인계표.pdf";
const editions = [
  { version: 1, code: "유리나침반", time: "18:00" },
  { version: 2, code: "호박등불", time: "19:30" },
  { version: 3, code: "은빛망원경", time: "21:00" },
] as const;
const sample = (version: number) =>
  Fs.readFile(
    new URL(`../../../../docs/user/samples/pdf-revisions/v${version}/${name}`, import.meta.url),
  );
const projectId = ProjectId.make("observatory");
const source = {
  projectId,
  threadId: ThreadId.make("shift"),
  messageId: MessageId.make("handover"),
  attachmentId: "source",
};
const createdAt = "2026-11-19T00:00:00.000Z";

function openSystem(baseDir: string) {
  const stateDir = Path.join(baseDir, "userdata");
  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(Path.join(stateDir, "state.sqlite"))),
    Layer.provideMerge(layerTest(baseDir, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const attachmentsDir = Path.join(stateDir, "attachments");
  const ctx = Effect.map(OrchestrationEngineService, (engine) => ({
    engine,
    stateDir,
    attachmentsDir,
  }));
  const status = (scope = source) =>
    runtime.runPromise(Effect.flatMap(ctx, (c) => getPdfRevisionStatus(c, scope)));
  const search = (query: string) =>
    runtime.runPromise(
      Effect.flatMap(ProjectionSnapshotQuery, (service) =>
        service.searchWorkspaceRag!({ projectId, query, attachmentsOnly: true }),
      ),
    );
  const start = async (version: number) => {
    const bytes = await sample(version);
    return runtime.runPromise(
      Effect.flatMap(ctx, (c) =>
        startPdfRevision(c, source, {
          bytes,
          expectedVersion: version - 1,
          requestId: `edition-${version}`,
        }),
      ),
    );
  };
  const publish = () => runtime.runPromise(Effect.flatMap(ctx, (c) => runPdfRevision(c, source)));
  const page = () =>
    readPdfDocumentRange({
      stateDir,
      attachmentsDir,
      ...source,
      page: 2,
      offset: 0,
      maxBytes: 8192,
    });
  const original = (version: number) =>
    runtime
      .runPromise(Effect.flatMap(ctx, (c) => publishedPdfSource(c, source, version)))
      .then((result) => Fs.readFile(result.path));
  const recoverAtStartup = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const published = yield* engine.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "project.knowledge-item-upserted" &&
              event.commandId?.startsWith("server:pdf-publish:") === true,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const reactor = yield* makeWorkspaceKnowledgeReactor;
        yield* reactor.start();
        yield* Fiber.join(published);
      }).pipe(Effect.provide(WorkspaceKnowledgeFileStoreLive), Effect.scoped),
    );
  return {
    runtime,
    ctx,
    stateDir,
    attachmentsDir,
    status,
    search,
    start,
    publish,
    page,
    original,
    recoverAtStartup,
  };
}
type System = ReturnType<typeof openSystem>;

async function addOrdinaryPdf(system: System, scope = source) {
  const bytes = await sample(1);
  const attachment = {
    type: "file" as const,
    id: scope.attachmentId,
    name,
    mimeType: "application/pdf",
    sizeBytes: bytes.length,
  };
  const { engine } = await system.runtime.runPromise(system.ctx);
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture" };
  await system.runtime.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("create-project"),
      projectId,
      title: "연습",
      workspaceRoot: system.stateDir,
      defaultModelSelection: null,
      createdAt,
    }),
  );
  await system.runtime.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${scope.threadId}`),
      projectId,
      threadId: scope.threadId,
      title: name,
      modelSelection,
      interactionMode: "default",
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );
  // Persist the ordinary attachment with the production command. No provider reactor is installed.
  await system.runtime.runPromise(
    engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`attach-${scope.threadId}`),
      threadId: scope.threadId,
      message: { messageId: scope.messageId, role: "user", text: name, attachments: [attachment] },
      modelSelection,
      interactionMode: "default",
      runtimeMode: "full-access",
      createdAt,
    }),
  );
  await Fs.mkdir(system.attachmentsDir, { recursive: true });
  await Fs.writeFile(Path.join(system.attachmentsDir, `${attachment.id}.bin`), bytes);
  await indexPdfJob({
    ...scope,
    stateDir: system.stateDir,
    attachmentsDir: system.attachmentsDir,
    bytes,
    attachment,
    createdAt,
    ocrEnabled: false,
    dispatch: (command) => system.runtime.runPromise(engine.dispatch(command)),
    writeAtomic: (filePath, contents) =>
      system.runtime.runPromise(writeFileStringAtomically({ filePath, contents })),
  });
}

async function expectVisible(system: System, version: number) {
  for (const edition of editions) {
    const result = await system.search(edition.code);
    const hits = result.matches.filter(
      (match) => match.research?.attachment?.attachmentId === source.attachmentId,
    );
    if (edition.version === version) {
      expect(hits).toHaveLength(1);
      expect(hits[0]?.content).toContain(edition.time);
    } else {
      expect(hits).toHaveLength(0);
    }
  }
  expect((await system.page()).text).toContain(editions[version - 1]!.code);
  expect(await system.original(version)).toEqual(await sample(version));
}

it("keeps v2 searchable during v3 indexing, then resumes on a reopened database without another upload", async () => {
  const dir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "pdf-exercise-restart-"));
  let system = openSystem(dir);
  try {
    await addOrdinaryPdf(system);
    const other = {
      ...source,
      threadId: ThreadId.make("other-room"),
      messageId: MessageId.make("other-message"),
      attachmentId: "independent",
    };
    await addOrdinaryPdf(system, other);
    await expectVisible(system, 1);
    const first = (await system.search(editions[0].code)).matches;
    const itemId = first.find(
      (m) => m.research?.attachment?.attachmentId === source.attachmentId,
    )!.itemId;
    expect(new Set(first.map((m) => m.itemId)).size).toBe(2);
    expect(
      await system.runtime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          resolvePdfRevisionItem(sql, { projectId, itemId }),
        ),
      ),
    ).toEqual(source);
    await system.start(2);
    await system.publish();
    await expectVisible(system, 2);
    expect(await system.start(3)).toMatchObject({
      published: { version: 2 },
      pending: { status: "indexing", version: 3 },
    });
    const stop = new AbortController();
    const interrupted = await system.runtime.runPromiseExit(
      Effect.flatMap(system.ctx, (c) =>
        runPdfRevision(c, source, {
          afterBatch: async () => {
            stop.abort();
          },
        }),
      ),
      { signal: stop.signal },
    );
    expect(interrupted._tag).toBe("Failure");
    expect(await system.status()).toMatchObject({
      published: { version: 2 },
      pending: { status: "indexing", lastPage: 2, totalPages: 2 },
    });
    await expectVisible(system, 2);
    await expect(system.original(3)).rejects.toThrow();
    await system.runtime.dispose();
    system = openSystem(dir);
    await expectVisible(system, 2);
    await system.recoverAtStartup();
    expect(await system.status()).toMatchObject({ published: { version: 3 }, pending: null });
    await expectVisible(system, 3);
    expect(await system.original(2)).toEqual(await sample(2));
    expect(await system.status(other)).toMatchObject({ published: { version: 1 }, pending: null });
    expect(
      (await system.search(editions[0].code)).matches.map(
        (m) => m.research?.attachment?.attachmentId,
      ),
    ).toEqual([other.attachmentId]);
  } finally {
    try {
      await system.runtime.dispose();
    } finally {
      await Fs.rm(dir, { recursive: true, force: true });
    }
  }
});

it("rolls back a failure during publication and publishes the indexed edition on explicit retry", async () => {
  const dir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "pdf-exercise-publish-"));
  const system = openSystem(dir);
  try {
    await addOrdinaryPdf(system);
    await system.start(2);
    await system.publish();
    await system.start(3);
    const sql = await system.runtime.runPromise(Effect.service(SqlClient.SqlClient));
    // Reject the receipt after projections have run, while the publication transaction is still open.
    await system.runtime
      .runPromise(sql`CREATE TRIGGER fail_exercise_publish BEFORE INSERT ON orchestration_command_receipts
      WHEN NEW.status='accepted' AND NEW.command_id LIKE 'server:pdf-publish:%'
      BEGIN SELECT RAISE(ABORT, 'fixture publication fault'); END`);
    await expect(system.publish()).rejects.toThrow();
    expect(await system.status()).toMatchObject({
      published: { version: 2 },
      pending: { version: 3, status: "failed", lastPage: 2, totalPages: 2 },
    });
    await expectVisible(system, 2);
    await expect(system.original(3)).rejects.toThrow();
    await system.runtime.runPromise(sql`DROP TRIGGER fail_exercise_publish`);
    await system.runtime.runPromise(Effect.flatMap(system.ctx, resumePdfRevisions));
    expect((await system.status()).pending?.status).toBe("failed");
    await system.runtime.runPromise(Effect.flatMap(system.ctx, (c) => retryPdfRevision(c, source)));
    await system.publish();
    expect(await system.status()).toMatchObject({ published: { version: 3 }, pending: null });
    await expectVisible(system, 3);
  } finally {
    try {
      await system.runtime.dispose();
    } finally {
      await Fs.rm(dir, { recursive: true, force: true });
    }
  }
});

it("resumes with one of two batches staged and makes both ends searchable together", async () => {
  const dir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "pdf-exercise-batches-"));
  let system = openSystem(dir);
  try {
    await addOrdinaryPdf(system);
    const pages = Array.from({ length: 65 }, (_, index) => `Observation page ${index + 1}`);
    pages[0] = "morningcompass";
    pages[64] = "eveningcompass";
    await system.runtime.runPromise(
      Effect.flatMap(system.ctx, (c) =>
        startPdfRevision(c, source, {
          bytes: pdfFixture(pages),
          expectedVersion: 1,
          requestId: "long-revision",
        }),
      ),
    );
    const stop = new AbortController();
    const interrupted = await system.runtime.runPromiseExit(
      Effect.flatMap(system.ctx, (c) =>
        runPdfRevision(c, source, {
          afterBatch: async () => {
            stop.abort();
          },
        }),
      ),
      { signal: stop.signal },
    );
    expect(interrupted._tag).toBe("Failure");
    await system.runtime.dispose();
    system = openSystem(dir);
    expect(await system.status()).toMatchObject({
      published: { version: 1 },
      pending: { version: 2, status: "indexing", lastPage: 64, totalPages: 65 },
    });
    expect((await system.search(pages[0]!)).matches).toHaveLength(0);
    expect((await system.search(pages[64]!)).matches).toHaveLength(0);
    await expectVisible(system, 1);
    await system.runtime.runPromise(Effect.flatMap(system.ctx, resumePdfRevisions));
    expect(await system.status()).toMatchObject({
      published: { version: 2, totalPages: 65 },
      pending: null,
    });
    for (const word of [pages[0]!, pages[64]!]) {
      const { matches } = await system.search(word);
      expect(matches[0]?.content).toContain(word);
      expect(matches[0]?.research?.attachment?.attachmentId).toBe(source.attachmentId);
    }
    expect((await system.search(editions[0].code)).matches).toHaveLength(0);
  } finally {
    try {
      await system.runtime.dispose();
    } finally {
      await Fs.rm(dir, { recursive: true, force: true });
    }
  }
});
