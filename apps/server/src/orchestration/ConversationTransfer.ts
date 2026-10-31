// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ConversationTransferError,
  ImportedConversation,
  ThreadId,
  type ConversationSourceFormat,
  type ConversationImportInput,
  type ConversationExportInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeImportedConversation = Schema.decodeUnknownSync(ImportedConversation);
const isTransferError = Schema.is(ConversationTransferError);
const encodeExport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const string = (value: unknown) => (typeof value === "string" ? value : null);
const contentText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((part) => {
            const item = record(part);
            return item &&
              (item.type === "text" || item.type === "input_text" || item.type === "output_text")
              ? (string(item.text) ?? "")
              : "";
          })
          .filter(Boolean)
          .join("\n")
      : "";
const timestamp = (value: unknown) =>
  typeof value === "string"
    ? Option.match(DateTime.make(value), { onNone: () => null, onSome: DateTime.formatIso })
    : null;

/** Reads only spoken messages; the exact source retains native tool, todo and session records. */
export function parseConversation(
  format: ConversationSourceFormat,
  source: string,
): ImportedConversation {
  if (source.length > 8_000_000) throw new Error("원본은 8 MB 이내여야 합니다.");
  const content = source.replace(/^\uFEFF/, "");
  const messages: ImportedConversation["messages"][number][] = [];
  let sourceSessionId: string | null = null;
  const add = (role: unknown, text: string, at?: unknown) => {
    if ((role === "user" || role === "assistant" || role === "system") && text.trim())
      messages.push({ role, text, createdAt: timestamp(at) });
  };
  if (format === "grok" && !content.trimStart().startsWith("{")) {
    let role: "user" | "assistant" | "system" | null = null;
    let lines: string[] = [];
    let inFence = false;
    for (const line of content.split(/\r?\n/)) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) inFence = !inFence;
      if (!inFence && /^#{1,4}\s+Tools\s*$/i.test(line)) {
        if (role) add(role, lines.join("\n").trim());
        role = null;
        lines = [];
        continue;
      }
      const heading = !inFence
        ? /^#{1,4}\s+(?:\*\*)?(User|You|Assistant|Grok|System)(?:\*\*)?(?:\s*[:·—-].*)?\s*$/i.exec(
            line,
          )
        : null;
      if (heading) {
        if (role) add(role, lines.join("\n").trim());
        role = /user|you/i.test(heading[1]!)
          ? "user"
          : /system/i.test(heading[1]!)
            ? "system"
            : "assistant";
        lines = [];
      } else if (role) lines.push(line);
    }
    if (role) add(role, lines.join("\n").trim());
  } else if (format === "t3" || format === "grok") {
    const top = record(parseJson(content));
    const thread = record(top?.thread) ?? top;
    sourceSessionId = string(thread?.id) ?? string(top?.sessionId);
    if (format === "t3" && top?.format !== "t3-conversation" && !Array.isArray(thread?.messages))
      throw new Error("T3 대화 내보내기 파일을 선택하세요.");
    for (const row of Array.isArray(thread?.messages) ? thread.messages : []) {
      const item = record(row);
      if (item)
        add(item.role, contentText(item.text ?? item.content), item.createdAt ?? item.timestamp);
    }
  } else {
    const rows = content
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return record(parseJson(line));
        } catch {
          throw new Error(`JSONL ${index + 1}번째 줄을 읽을 수 없습니다.`);
        }
      });
    const hasResponseMessages =
      format === "codex" &&
      rows.some(
        (item) => item?.type === "response_item" && record(item.payload)?.type === "message",
      );
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row) continue;
      if (row.type === "session_meta")
        sourceSessionId = string(record(row.payload)?.id) ?? sourceSessionId;
      sourceSessionId = string(row.sessionId) ?? sourceSessionId;
      if (format === "codex") {
        const payload = record(row.payload);
        if (row.type === "response_item" && payload?.type === "message")
          add(payload.role, contentText(payload.content), row.timestamp);
        else if (!hasResponseMessages && row.type === "event_msg" && payload)
          add(
            payload.type === "user_message"
              ? "user"
              : payload.type === "agent_message"
                ? "assistant"
                : null,
            string(payload.message) ?? "",
            row.timestamp,
          );
      } else if (row.type === "user" || row.type === "assistant") {
        const message = record(row.message);
        const text = contentText(message?.content);
        const key = `${string(row.uuid) ?? string(message?.id) ?? messages.length}:${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        add(message?.role ?? row.type, text, row.timestamp);
      }
    }
  }
  if (!messages.length)
    throw new Error(
      "읽을 수 있는 대화가 없습니다. Codex/Claude JSONL, Grok Markdown 내보내기 또는 T3 JSON을 선택하세요.",
    );
  return decodeImportedConversation({
    format,
    sourceHash: NodeCrypto.createHash("sha256").update(source).digest("hex"),
    sourceSessionId,
    messages,
  });
}

export const previewConversation = (input: { format: ConversationSourceFormat; content: string }) =>
  Effect.try({
    try: () => {
      const parsed = parseConversation(input.format, input.content);
      return {
        format: parsed.format,
        sourceHash: parsed.sourceHash,
        sourceSessionId: parsed.sourceSessionId,
        messageCount: parsed.messages.length,
        sample: (parsed.messages.length === 1
          ? parsed.messages
          : [parsed.messages[0]!, parsed.messages.at(-1)!]
        ).map((message) => ({
          role: message.role,
          text: message.text.slice(0, 300),
        })),
      };
    },
    catch: (cause) =>
      new ConversationTransferError({
        message: cause instanceof Error ? cause.message : "대화 형식을 확인하세요.",
      }),
  });

export const importConversation = Effect.fn("ConversationTransfer.import")(
  function* (input: typeof ConversationImportInput.Type) {
    const imported = yield* Effect.try({
      try: () => parseConversation(input.format, input.content),
      catch: (cause) =>
        new ConversationTransferError({
          message: cause instanceof Error ? cause.message : "대화 형식을 확인하세요.",
        }),
    });
    const query = yield* ProjectionSnapshotQuery;
    if (Option.isNone(yield* query.getProjectShellById(input.projectId)))
      return yield* new ConversationTransferError({ message: "프로젝트를 찾을 수 없습니다." });
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const sourcePath = path.join(
      config.stateDir,
      "conversation-imports",
      `${imported.sourceHash}.txt`,
    );
    yield* writeFileStringAtomically({
      filePath: sourcePath,
      contents: input.content,
      mode: 0o600,
    });
    const threadId = ThreadId.make(`import-${NodeCrypto.randomUUID()}`);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* (yield* OrchestrationEngineService).dispatch({
      type: "thread.create",
      commandId: CommandId.make(`conversation-import:${threadId}`),
      projectId: input.projectId,
      threadId,
      title: input.title.trim(),
      modelSelection: input.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      orchestraRunThreadId: null,
      importedConversation: imported,
      createdAt,
    });
    return { threadId };
  },
  Effect.mapError((cause) =>
    isTransferError(cause)
      ? cause
      : new ConversationTransferError({
          message: "대화를 가져오지 못했습니다. 연결·프로젝트 상태를 확인하세요.",
        }),
  ),
);

export const exportConversation = Effect.fn("ConversationTransfer.export")(
  function* (input: typeof ConversationExportInput.Type) {
    const thread = Option.getOrNull(
      yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(input.threadId),
    );
    if (!thread)
      return yield* new ConversationTransferError({ message: "대화를 찾을 수 없습니다." });
    if (input.original) {
      const metadata = record(
        thread.activities.find((item) => item.kind === "conversation.imported")?.payload,
      );
      const hash = string(metadata?.sourceHash);
      if (!hash || !/^[a-f0-9]{64}$/.test(hash))
        return yield* new ConversationTransferError({ message: "보관된 CLI 원본이 없습니다." });
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const content = yield* (yield* FileSystem.FileSystem).readFileString(
        path.join(config.stateDir, "conversation-imports", `${hash}.txt`),
      );
      if (NodeCrypto.createHash("sha256").update(content).digest("hex") !== hash)
        return yield* new ConversationTransferError({ message: "보관 원본의 해시가 다릅니다." });
      const format = string(metadata?.format) ?? "t3";
      return {
        fileName: `${thread.id}-original.${format === "grok" ? "md" : format === "t3" ? "json" : "jsonl"}`,
        content,
        format,
      };
    }
    const metadata = record(
      thread.activities.find((item) => item.kind === "conversation.imported")?.payload,
    );
    const sourceHash = string(metadata?.sourceHash);
    let originalSource: { format: string; content: string } | undefined;
    if (sourceHash && /^[a-f0-9]{64}$/.test(sourceHash)) {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const raw = yield* (yield* FileSystem.FileSystem)
        .readFileString(path.join(config.stateDir, "conversation-imports", `${sourceHash}.txt`))
        .pipe(Effect.orElseSucceed(() => null));
      if (raw !== null && NodeCrypto.createHash("sha256").update(raw).digest("hex") === sourceHash)
        originalSource = { format: string(metadata?.format) ?? "t3", content: raw };
    }
    const content = yield* encodeExport({
      format: "t3-conversation",
      version: 1,
      thread,
      ...(originalSource ? { originalSource } : {}),
    });
    if (content.length > 8_000_000)
      return yield* new ConversationTransferError({
        message: "대화가 8 MB를 초과합니다. CLI 원본 내보내기를 사용하세요.",
      });
    return { fileName: `${thread.id}.t3.json`, content, format: "t3" };
  },
  Effect.mapError((cause) =>
    isTransferError(cause)
      ? cause
      : new ConversationTransferError({ message: "대화 내보내기에 실패했습니다." }),
  ),
);
