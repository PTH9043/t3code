import { expect, it } from "@effect/vitest";
import { OrchestrationRpcSchemas, ProjectId, WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { decodePdfRevisionFile, resolvePdfRevisionItem } from "./pdfRevisionRpc.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const key = { projectId: ProjectId.make("one"), itemId: WorkspaceKnowledgeItemId.make("batch") };
const content = Buffer.from("%PDF-1.7\n");
const file = {
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: content.length,
  dataUrl: "data:application/pdf;base64," + content.toString("base64"),
} as const;

it("requires an existing item, expected version and request identity for replacement", () => {
  const accepts = Schema.is(OrchestrationRpcSchemas.startPdfRevision.input);
  const start = { ...key, file, expectedVersion: 1, requestId: "first" };
  expect(accepts(start)).toBe(true);
  expect(accepts({ projectId: key.projectId, file })).toBe(false);
  expect(accepts({ ...start, expectedVersion: 0 })).toBe(false);
  expect(accepts({ ...start, file: { ...file, mimeType: "text/plain" } })).toBe(false);
});

it("rejects forged MIME, size, signature and malformed base64 before registration", () => {
  expect(decodePdfRevisionFile(file)).toEqual(content);
  for (const altered of [
    { ...file, dataUrl: file.dataUrl.replace("application/pdf", "image/png") },
    { ...file, sizeBytes: file.sizeBytes + 1 },
    { ...file, sizeBytes: 3, dataUrl: "data:application/pdf;base64,YmFk" },
    { ...file, dataUrl: file.dataUrl + "!" },
  ])
    expect(() => decodePdfRevisionFile(altered)).toThrow();
});

it.effect("resolves only a visible PDF item and its owning project's durable attachment", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('one','First','/one','[]','t','t'),('two','Second','/two','[]','t','t')`;
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at)
      VALUES ('owner','one','Room','t','t')`;
    const attachment = {
      id: "original",
      type: "file",
      name: "report.pdf",
      mimeType: "application/pdf",
    };
    yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at,attachments_json)
      VALUES ('message','owner','user','',0,'t','t',${encodeJson([attachment])})`;
    const research = encodeJson({
      attachment: { threadId: "owner", messageId: "message", attachmentId: "original" },
    });
    for (const project of ["one", "two"])
      yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,tags_json,research_json,created_at,updated_at)
        VALUES (${project},'batch','rag-source','report.pdf','','active','imported','["pdf-page-batch"]',${research},'t','t')`;
    expect(yield* resolvePdfRevisionItem(sql, key)).toEqual({
      projectId: "one",
      threadId: "owner",
      messageId: "message",
      attachmentId: "original",
    });
    const denied = (input: typeof key) => resolvePdfRevisionItem(sql, input).pipe(Effect.flip);
    expect((yield* denied({ ...key, projectId: ProjectId.make("two") }))._tag).toBe(
      "OrchestrationWorkspaceKnowledgeError",
    );
    yield* sql`UPDATE projection_workspace_knowledge_items SET status='archived' WHERE project_id='one'`;
    expect((yield* denied(key))._tag).toBe("OrchestrationWorkspaceKnowledgeError");
    yield* sql`INSERT INTO pdf_revision_documents(doc,project_id,thread_id,message_id,attachment_id,name,batch_prefix,ocr,published)
      VALUES ('doc','one','owner','message','original','report.pdf','prefix',0,2)`;
    yield* sql`INSERT INTO pdf_revision_item_aliases(project_id,item_id,doc) VALUES ('one','batch','doc')`;
    expect((yield* resolvePdfRevisionItem(sql, key)).attachmentId).toBe("original");
    yield* sql`UPDATE projection_thread_messages SET attachments_json='[]' WHERE message_id='message'`;
    expect((yield* denied(key))._tag).toBe("OrchestrationWorkspaceKnowledgeError");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
