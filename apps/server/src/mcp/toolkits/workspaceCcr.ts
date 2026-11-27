// @effect-diagnostics preferSchemaOverJson:off
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  compressToolOutputForCcr,
  gunzipCcrText,
  gzipCcrText,
  type CcrCompressionResult,
  type CcrMimeKind,
  type SmartCrusherOptions,
} from "../ccr/CcrCompressor.ts";

export const CCR_DEFAULT_TTL_DAYS = 7;
export const CCR_DEFAULT_SLICE_LENGTH = 8_000;
export const CCR_MAX_SLICE_LENGTH = 24_000;
const MEMORY_FALLBACK_MAX_ENTRIES = 128;

export const WorkspaceRetrieveOutputInput = Schema.Struct({
  /** Hash returned in a `[CCR outputHash=ccr_...]` summary handle. */
  outputHash: TrimmedNonEmptyString,
  /** Optional character start offset (default 0). */
  sliceStart: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Optional character length to return (default 8000, max 24000). */
  sliceLength: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: CCR_MAX_SLICE_LENGTH })),
  ),
  /** Optional simple JSON path for JSON outputs (e.g. "items[42]" or "results.errors"). */
  jsonPath: Schema.optionalKey(TrimmedNonEmptyString),
  /** Optional case-insensitive substring filter returning matching lines with line numbers. */
  grep: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkspaceRetrieveOutputInput = typeof WorkspaceRetrieveOutputInput.Type;

export const WorkspaceRetrieveOutputResult = Schema.Struct({
  found: Schema.Boolean,
  outputHash: Schema.String,
  toolName: Schema.NullOr(Schema.String),
  mimeKind: Schema.NullOr(Schema.String),
  rawBytes: Schema.Int,
  totalChars: Schema.Int,
  sliceStart: Schema.Int,
  returnedChars: Schema.Int,
  hasMore: Schema.Boolean,
  content: Schema.String,
  message: Schema.optionalKey(Schema.String),
});
export type WorkspaceRetrieveOutputResult = typeof WorkspaceRetrieveOutputResult.Type;

export class WorkspaceRetrieveOutputError extends Schema.TaggedErrorClass<WorkspaceRetrieveOutputError>()(
  "WorkspaceRetrieveOutputError",
  { message: Schema.String },
) {}

export interface CcrStoredRecord {
  readonly outputHash: string;
  readonly threadId: string;
  readonly toolName: string;
  readonly mimeKind: CcrMimeKind;
  readonly rawBytes: number;
  readonly compressedBytes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly rawText: string;
}

export interface CcrToolOutputStore {
  readonly compressAndStore: (input: {
    readonly threadId: string;
    readonly toolName: string;
    readonly rawText: string;
    readonly mimeHint?: CcrMimeKind | undefined;
    readonly knownSecrets?: ReadonlyArray<string> | undefined;
    readonly ttlDays?: number | undefined;
    readonly options?: SmartCrusherOptions | undefined;
  }) => Effect.Effect<CcrCompressionResult>;
  readonly get: (input: {
    readonly threadId: string;
    readonly outputHash: string;
  }) => Effect.Effect<CcrStoredRecord | null>;
  readonly retrieve: (input: {
    readonly threadId: string;
    readonly request: WorkspaceRetrieveOutputInput;
  }) => Effect.Effect<WorkspaceRetrieveOutputResult>;
}

interface SqlCcrRow {
  readonly output_hash: string;
  readonly thread_id: string;
  readonly tool_name: string;
  readonly mime_kind: string;
  readonly raw_bytes: number;
  readonly compressed_bytes: number;
  readonly payload_gzip: Uint8Array | Buffer;
  readonly created_at: string;
  readonly expires_at: string;
}

function resolveSimpleJsonPath(
  root: unknown,
  rawPath: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  const cleaned = rawPath.trim().replace(/^\$\.?/, "");
  if (!cleaned) return { ok: true, value: root };
  const tokens: string[] = [];
  const tokenRegex = /[^.[\]]+|\[(\d+|"[^"]+"|'[^']+')\]/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(cleaned)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1].replace(/^['"]|['"]$/g, ""));
    } else {
      tokens.push(match[0]);
    }
  }
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || current === undefined) {
      return { ok: false, error: `Path segment '${token}' hit null/undefined.` };
    }
    if (Array.isArray(current)) {
      const idx = Number.parseInt(token, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        return {
          ok: false,
          error: `Array index '${token}' out of bounds (length ${current.length}).`,
        };
      }
      current = current[idx];
    } else if (typeof current === "object") {
      if (!(token in (current as Record<string, unknown>))) {
        return { ok: false, error: `Object key '${token}' does not exist.` };
      }
      current = (current as Record<string, unknown>)[token];
    } else {
      return { ok: false, error: `Cannot traverse '${token}' on primitive value.` };
    }
  }
  return { ok: true, value: current };
}

export function sliceCcrOutputText(
  rawText: string,
  mimeKind: string,
  request: WorkspaceRetrieveOutputInput,
): {
  readonly content: string;
  readonly totalChars: number;
  readonly sliceStart: number;
  readonly returnedChars: number;
  readonly hasMore: boolean;
  readonly message?: string;
} {
  let working = rawText;
  let note: string | undefined;

  if (request.jsonPath) {
    if (mimeKind !== "json") {
      note = `Output mimeKind is '${mimeKind}', not JSON; ignoring jsonPath and returning raw slice.`;
    } else {
      try {
        const parsed = JSON.parse(rawText);
        const resolved = resolveSimpleJsonPath(parsed, request.jsonPath);
        if (resolved.ok) {
          working =
            typeof resolved.value === "string"
              ? resolved.value
              : JSON.stringify(resolved.value, null, 2);
        } else {
          return {
            content: "",
            totalChars: rawText.length,
            sliceStart: 0,
            returnedChars: 0,
            hasMore: false,
            message: `jsonPath '${request.jsonPath}' lookup failed: ${resolved.error}`,
          };
        }
      } catch {
        note = "Stored payload could not be parsed as JSON; falling back to text slice.";
      }
    }
  }

  if (request.grep) {
    const needle = request.grep.toLowerCase();
    const matched = working
      .split(/\r?\n/)
      .map((line, index) => ({ line, num: index + 1 }))
      .filter((entry) => entry.line.toLowerCase().includes(needle))
      .map((entry) => `L${entry.num}: ${entry.line}`);
    working = matched.join("\n");
    if (matched.length === 0) {
      note = `No lines matched grep "${request.grep}".`;
    }
  }

  const start = Math.min(request.sliceStart ?? 0, working.length);
  const length = Math.min(request.sliceLength ?? CCR_DEFAULT_SLICE_LENGTH, CCR_MAX_SLICE_LENGTH);
  const content = working.slice(start, start + length);
  const hasMore = start + content.length < working.length;

  return {
    content,
    totalChars: working.length,
    sliceStart: start,
    returnedChars: content.length,
    hasMore,
    ...(note !== undefined ? { message: note } : {}),
  };
}

export function makeCcrToolOutputStore(sql?: SqlClient.SqlClient): CcrToolOutputStore {
  const memoryFallback = new Map<string, CcrStoredRecord>();
  const keyOf = (threadId: string, outputHash: string) => `${threadId}::${outputHash}`;

  const putMemory = (record: CcrStoredRecord) => {
    const key = keyOf(record.threadId, record.outputHash);
    if (memoryFallback.has(key)) memoryFallback.delete(key);
    memoryFallback.set(key, record);
    while (memoryFallback.size > MEMORY_FALLBACK_MAX_ENTRIES) {
      const oldestKey = memoryFallback.keys().next().value;
      if (oldestKey !== undefined) memoryFallback.delete(oldestKey);
    }
  };

  const compressAndStore: CcrToolOutputStore["compressAndStore"] = (input) =>
    Effect.gen(function* () {
      const result = compressToolOutputForCcr({
        toolName: input.toolName,
        rawText: input.rawText,
        mimeHint: input.mimeHint,
        knownSecrets: input.knownSecrets,
        options: input.options,
      });

      if (!result.compressed) return result;

      const nowMs = yield* Clock.currentTimeMillis;
      const ttlDays = Math.max(1, Math.min(30, input.ttlDays ?? CCR_DEFAULT_TTL_DAYS));
      const createdAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs + ttlDays * 86_400_000));
      const gzipBytes = gzipCcrText(result.scrubbedOriginal);

      const record: CcrStoredRecord = {
        outputHash: result.outputHash,
        threadId: input.threadId,
        toolName: result.toolName,
        mimeKind: result.mimeKind,
        rawBytes: result.rawBytes,
        compressedBytes: gzipBytes.byteLength,
        createdAt,
        expiresAt,
        rawText: result.scrubbedOriginal,
      };
      putMemory(record);

      if (sql) {
        yield* Effect.gen(function* () {
          yield* sql`INSERT OR REPLACE INTO ccr_tool_outputs (
            output_hash, thread_id, tool_name, mime_kind,
            raw_bytes, compressed_bytes, payload_gzip, created_at, expires_at
          ) VALUES (
            ${record.outputHash}, ${record.threadId}, ${record.toolName}, ${record.mimeKind},
            ${record.rawBytes}, ${record.compressedBytes}, ${gzipBytes}, ${record.createdAt}, ${record.expiresAt}
          )`;
          yield* sql`DELETE FROM ccr_tool_outputs WHERE expires_at < ${createdAt}`;
        }).pipe(Effect.ignoreCause({ log: false }));
      }

      return result;
    });

  const get: CcrToolOutputStore["get"] = (input) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      const cached = memoryFallback.get(keyOf(input.threadId, input.outputHash));
      if (cached && cached.expiresAt >= nowIso) {
        return cached;
      }

      if (!sql) return null;

      const rows = yield* sql<SqlCcrRow>`
        SELECT output_hash, thread_id, tool_name, mime_kind, raw_bytes, compressed_bytes,
               payload_gzip, created_at, expires_at
        FROM ccr_tool_outputs
        WHERE thread_id = ${input.threadId}
          AND output_hash = ${input.outputHash}
          AND expires_at >= ${nowIso}
        LIMIT 1
      `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<SqlCcrRow>));

      const row = rows[0];
      if (!row) return null;

      const bytes =
        row.payload_gzip instanceof Uint8Array
          ? row.payload_gzip
          : new Uint8Array(row.payload_gzip);
      const rawText = gunzipCcrText(bytes);
      const record: CcrStoredRecord = {
        outputHash: row.output_hash,
        threadId: row.thread_id,
        toolName: row.tool_name,
        mimeKind: row.mime_kind === "json" || row.mime_kind === "log" ? row.mime_kind : "text",
        rawBytes: row.raw_bytes,
        compressedBytes: row.compressed_bytes,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        rawText,
      };
      putMemory(record);
      return record;
    });

  const retrieve: CcrToolOutputStore["retrieve"] = (input) =>
    Effect.gen(function* () {
      const record = yield* get({
        threadId: input.threadId,
        outputHash: input.request.outputHash,
      });
      if (!record) {
        return {
          found: false,
          outputHash: input.request.outputHash,
          toolName: null,
          mimeKind: null,
          rawBytes: 0,
          totalChars: 0,
          sliceStart: 0,
          returnedChars: 0,
          hasMore: false,
          content: "",
          message: `CCR output '${input.request.outputHash}' was not found in this thread or has expired.`,
        };
      }
      const sliced = sliceCcrOutputText(record.rawText, record.mimeKind, input.request);
      return {
        found: true,
        outputHash: record.outputHash,
        toolName: record.toolName,
        mimeKind: record.mimeKind,
        rawBytes: record.rawBytes,
        totalChars: sliced.totalChars,
        sliceStart: sliced.sliceStart,
        returnedChars: sliced.returnedChars,
        hasMore: sliced.hasMore,
        content: sliced.content,
        ...(sliced.message !== undefined ? { message: sliced.message } : {}),
      };
    });

  return { compressAndStore, get, retrieve };
}
