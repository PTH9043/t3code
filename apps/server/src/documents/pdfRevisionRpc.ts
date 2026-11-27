import {
  OrchestrationWorkspaceKnowledgeError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type OrchestrationRpcSchemas,
  type PdfRevisionStatus,
} from "@t3tools/contracts";
import { Effect, FileSystem, Option, Schema } from "effect";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ServerDerivedPaths } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { visibleKnowledge } from "../persistence/knowledgeVisibility.ts";
import {
  getPdfRevisionStatus,
  publishedPdfSource,
  retryPdfRevision,
  runPdfRevision,
  startPdfRevision,
} from "./pdfRevision.ts";
import { revisionDigest } from "./pdfRevisionPaths.ts";
import { PdfRevisionError, type PdfScope } from "./pdfRevisionStore.ts";

type Lookup = typeof OrchestrationRpcSchemas.getPdfRevisionStatus.input.Type;
type Upload = typeof OrchestrationRpcSchemas.startPdfRevision.input.Type;
type ReadSource = typeof OrchestrationRpcSchemas.readPdfRevisionSource.input.Type;

const isKnowledgeError = Schema.is(OrchestrationWorkspaceKnowledgeError);
const isPdfError = Schema.is(PdfRevisionError);

const unavailable = () =>
  new OrchestrationWorkspaceKnowledgeError({
    message: "이 프로젝트에서 해당 PDF 문서를 열 수 없습니다.",
  });

export const resolvePdfRevisionItem = Effect.fn("resolvePdfRevisionItem")(function* (
  sql: SqlClient.SqlClient,
  input: Lookup,
) {
  const [scope] = yield* sql<PdfScope>`
    WITH item AS (
      SELECT status, research_json FROM projection_workspace_knowledge_items
      WHERE project_id=${input.projectId} AND item_id=${input.itemId} AND ${visibleKnowledge(sql)}
        AND origin='imported' AND kind='rag-source' AND source_item_id IS NULL
        AND EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value='pdf-page-batch')
    )
    SELECT t.project_id AS projectId, t.thread_id AS threadId, m.message_id AS messageId,
           a.value->>'id' AS attachmentId
    FROM item
    JOIN projection_threads t ON t.thread_id=item.research_json->>'$.attachment.threadId'
      AND t.project_id=${input.projectId} AND t.deleted_at IS NULL
    JOIN projection_projects p ON p.project_id=t.project_id AND p.deleted_at IS NULL
    JOIN projection_thread_messages m ON m.thread_id=t.thread_id
      AND m.message_id=item.research_json->>'$.attachment.messageId'
    JOIN json_each(m.attachments_json) a ON a.value->>'type'='file'
      AND a.value->>'id'=item.research_json->>'$.attachment.attachmentId'
    WHERE (lower(a.value->>'mimeType')='application/pdf' OR lower(a.value->>'name') LIKE '%.pdf')
      AND (item.status='active' OR (item.status='archived' AND EXISTS (
        SELECT 1 FROM pdf_revision_item_aliases alias
        JOIN pdf_revision_documents d ON d.doc=alias.doc AND d.project_id=alias.project_id
        WHERE alias.project_id=t.project_id AND alias.item_id=${input.itemId}
          AND d.thread_id=t.thread_id AND d.message_id=m.message_id AND d.attachment_id=a.value->>'id'
      )))
    LIMIT 1`;
  if (!scope) return yield* unavailable();
  return scope;
});

export function decodePdfRevisionFile(file: Upload["file"]) {
  const invalid = () =>
    new OrchestrationWorkspaceKnowledgeError({
      message: "PDF 파일 형식과 크기를 확인하세요.",
    });
  const parsed = parseBase64DataUrl(file.dataUrl);
  if (
    !parsed ||
    parsed.mimeType !== "application/pdf" ||
    file.mimeType !== parsed.mimeType ||
    file.sizeBytes <= 0 ||
    file.sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES ||
    Buffer.byteLength(parsed.base64, "base64") !== file.sizeBytes
  ) {
    throw invalid();
  }
  const bytes = Buffer.from(parsed.base64, "base64");
  if (!bytes.subarray(0, 1024).includes("%PDF-")) throw invalid();
  return bytes;
}

export function makePdfRevisionRpc(
  paths: Pick<ServerDerivedPaths, "stateDir" | "attachmentsDir">,
  engine: Pick<OrchestrationEngineShape, "dispatch">,
  database: Option.Option<SqlClient.SqlClient>,
  workerScope: Scope.Scope,
) {
  const ctx = { stateDir: paths.stateDir, attachmentsDir: paths.attachmentsDir, engine };
  function withItem<A, E, R>(input: Lookup, run: (scope: PdfScope) => Effect.Effect<A, E, R>) {
    if (Option.isNone(database)) return Effect.fail(unavailable());
    const sql = database.value;
    return resolvePdfRevisionItem(sql, input).pipe(
      Effect.flatMap(run),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError((cause) => {
        if (isKnowledgeError(cause)) return cause;
        return new OrchestrationWorkspaceKnowledgeError({
          message: isPdfError(cause) ? cause.message : "PDF 문서 요청을 처리하지 못했습니다.",
        });
      }),
    );
  }

  function schedule<E, R>(scope: PdfScope, register: Effect.Effect<PdfRevisionStatus, E, R>) {
    // Once accepted, the durable registration and its wakeup outlive the requesting client.
    return register.pipe(
      Effect.tap((result) =>
        result.pending?.status === "indexing"
          ? runPdfRevision(ctx, scope).pipe(
              Effect.interruptible,
              Effect.ignoreCause({ log: true }),
              Effect.forkIn(workerScope),
            )
          : Effect.void,
      ),
      Effect.uninterruptible,
    );
  }

  return {
    getPdfRevisionStatus: (input: Lookup) =>
      withItem(input, (scope) => getPdfRevisionStatus(ctx, scope)),
    startPdfRevision: (input: Upload) =>
      withItem(input, (scope) =>
        Effect.gen(function* () {
          const bytes = yield* Effect.try({
            try: () => decodePdfRevisionFile(input.file),
            catch: (cause) => (isKnowledgeError(cause) ? cause : unavailable()),
          });
          return yield* schedule(
            scope,
            startPdfRevision(ctx, scope, {
              bytes,
              requestId: input.requestId,
              expectedVersion: input.expectedVersion,
            }),
          );
        }),
      ),
    retryPdfRevision: (input: Lookup) =>
      withItem(input, (scope) => schedule(scope, retryPdfRevision(ctx, scope))),
    readPdfRevisionSource: (input: ReadSource) =>
      withItem(input, (scope) =>
        Effect.gen(function* () {
          const source = yield* publishedPdfSource(ctx, scope, input.version);
          const fs = yield* FileSystem.FileSystem;
          const bytes = yield* fs.readFile(source.path);
          if (
            bytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES ||
            revisionDigest(bytes) !== source.contentHash
          )
            return yield* unavailable();
          return {
            dataUrl: "data:application/pdf;base64," + Buffer.from(bytes).toString("base64"),
          };
        }),
      ),
  };
}
