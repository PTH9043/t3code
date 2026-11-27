// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import type {
  CompactHandoffPacket,
  CompactHandoffProof,
  MissionHandoffIntent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  computeCcrOutputHash,
  gunzipCcrText,
  gzipCcrText,
  scrubCcrPayload,
} from "../../mcp/ccr/CcrCompressor.ts";
import { computeErrorFingerprint } from "./MissionBudgetGuard.ts";
import { estimateTextTokens } from "./MissionPromptCacheAssembler.ts";

/**
 * Tool Output Valve & Pass-by-Reference (CompactHandoffPacket) 미들웨어.
 *
 * - 기존 `106_CcrToolOutputs` (`ccr_tool_outputs`) + `CcrCompressor.ts`를 SSOT로 재사용한다.
 * - 성공 출력은 ~20T 1줄 JSON, 실패 출력은 에러 주변 ±15줄 + `ccr_<16hex>` 포인터,
 *   300줄 초과 diff는 `--stat` + 헝크 헤더 + `ccr_<16hex>` 포인터로 절단해 토큰 폭발을 막는다.
 * - `CompactHandoffPacket`은 비밀값 마스킹 + 3줄×80자 강제 절단 + ≤400T 규격을 보장한다.
 */

const ERROR_CONTEXT_PATTERN =
  /\b(?:error|err|fail(?:ed|ure)?|exception|fatal|traceback|assertionerror|typeerror|syntaxerror|ts\d{4})\b|×\s+|✗\s+/iu;

const CCR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DIFF_LINE_THRESHOLD = 300;
const MAX_SUMMARY_LINE_CHARS = 80;

export interface ToolOutputValveInput {
  readonly threadId: string;
  readonly toolName: string;
  readonly command?: string;
  readonly exitCode: number;
  readonly rawOutput: string;
  readonly isDiff?: boolean;
}

export interface ToolOutputValveResult {
  readonly compactText: string;
  readonly artifactId: string | null;
  readonly rawBytes: number;
  readonly compactBytes: number;
  readonly estimatedTokens: number;
  readonly errorHash: string | null;
  readonly status: "PASS" | "FAIL" | "DIFF_STAT";
}

function archiveToCcrTable(
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly toolName: string;
    readonly mimeKind: "json" | "log" | "text";
    readonly scrubbedText: string;
  },
): Effect.Effect<string, never> {
  return Effect.gen(function* () {
    const outputHash = computeCcrOutputHash(input.scrubbedText);
    const gzipped = gzipCcrText(input.scrubbedText);
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const createdAt = DateTime.formatIso(now);
    const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs + CCR_TTL_MS));
    const rawBytes = Buffer.byteLength(input.scrubbedText, "utf8");
    const compressedBytes = gzipped.byteLength;

    yield* sql`INSERT OR REPLACE INTO ccr_tool_outputs (
      output_hash, thread_id, tool_name, mime_kind,
      raw_bytes, compressed_bytes, payload_gzip, created_at, expires_at
    ) VALUES (
      ${outputHash}, ${input.threadId}, ${input.toolName}, ${input.mimeKind},
      ${rawBytes}, ${compressedBytes}, ${gzipped}, ${createdAt}, ${expiresAt}
    )`;

    return outputHash;
  }).pipe(Effect.catch(() => Effect.succeed(computeCcrOutputHash(input.scrubbedText))));
}

function extractErrorWindow(lines: ReadonlyArray<string>, radius = 15, maxOut = 32): string {
  const firstIdx = lines.findIndex((line) => ERROR_CONTEXT_PATTERN.test(line));
  if (firstIdx < 0) {
    return lines.slice(-maxOut).join("\n");
  }
  const start = Math.max(0, firstIdx - radius);
  const end = Math.min(lines.length, firstIdx + radius + 1);
  return lines.slice(start, end).slice(0, maxOut).join("\n");
}

function summarizeLargeDiff(lines: ReadonlyArray<string>): string {
  const headers: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("@@ ")
    ) {
      if (headers.length < 40) headers.push(line);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return [`[DIFF_STAT] 총 ${lines.length}줄 (+${added} / -${removed})`, ...headers].join("\n");
}

export function runToolOutputValve(
  sql: SqlClient.SqlClient,
  input: ToolOutputValveInput,
): Effect.Effect<ToolOutputValveResult, never> {
  return Effect.gen(function* () {
    const scrubbed = scrubCcrPayload(input.rawOutput ?? "");
    const rawBytes = Buffer.byteLength(scrubbed, "utf8");
    const lines = scrubbed.split(/\r?\n/);

    // 1. 300줄 초과 Diff 절단
    if (input.isDiff && lines.length > DIFF_LINE_THRESHOLD) {
      const artifactId = yield* archiveToCcrTable(sql, {
        threadId: input.threadId,
        toolName: input.toolName,
        mimeKind: "text",
        scrubbedText: scrubbed,
      });
      const statSummary = summarizeLargeDiff(lines);
      const compactText = `${statSummary}\n[artifact:${artifactId}] 전체 Diff 원문은 아티팩트 ID로 필요 시에만 부분 열람하세요.`;
      return {
        compactText,
        artifactId,
        rawBytes,
        compactBytes: Buffer.byteLength(compactText, "utf8"),
        estimatedTokens: estimateTextTokens(compactText),
        errorHash: null,
        status: "DIFF_STAT" as const,
      };
    }

    // 2. 성공 출력 (exitCode === 0): ~20T 1줄 JSON만 반환
    if (input.exitCode === 0 && !input.isDiff) {
      const artifactId =
        rawBytes > 1_024
          ? yield* archiveToCcrTable(sql, {
              threadId: input.threadId,
              toolName: input.toolName,
              mimeKind: "log",
              scrubbedText: scrubbed,
            })
          : null;
      const firstMeaningful =
        lines
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .slice(-1)[0]
          ?.slice(0, 80) ?? "PASS";
      const payload = {
        exitCode: 0,
        status: "PASS",
        summary: firstMeaningful,
        ...(artifactId ? { artifactId } : {}),
      };
      const compactText = JSON.stringify(payload);
      return {
        compactText,
        artifactId,
        rawBytes,
        compactBytes: Buffer.byteLength(compactText, "utf8"),
        estimatedTokens: estimateTextTokens(compactText),
        errorHash: null,
        status: "PASS" as const,
      };
    }

    // 3. 실패 출력 (exitCode !== 0): 에러 주변 ±15줄 + 원문 CCR 아카이브 + 에러 해시
    const artifactId = yield* archiveToCcrTable(sql, {
      threadId: input.threadId,
      toolName: input.toolName,
      mimeKind: "log",
      scrubbedText: scrubbed,
    });
    const errorExcerpt = extractErrorWindow(lines, 15, 32);
    const errorHash = computeErrorFingerprint(errorExcerpt || scrubbed);
    const compactText = [
      `[FAIL exit=${input.exitCode} artifact=${artifactId} errHash=${errorHash.slice(0, 12)}]`,
      errorExcerpt,
    ].join("\n");
    return {
      compactText,
      artifactId,
      rawBytes,
      compactBytes: Buffer.byteLength(compactText, "utf8"),
      estimatedTokens: estimateTextTokens(compactText),
      errorHash,
      status: "FAIL" as const,
    };
  });
}

export function archiveMissionRawArtifact(
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly toolName: string;
    readonly rawText: string;
    readonly mimeKind?: "json" | "log" | "text";
  },
): Effect.Effect<string, never> {
  const scrubbed = scrubCcrPayload(input.rawText);
  return archiveToCcrTable(sql, {
    threadId: input.threadId,
    toolName: input.toolName,
    mimeKind: input.mimeKind ?? "text",
    scrubbedText: scrubbed,
  });
}

export function inspectCcrArtifactById(
  sql: SqlClient.SqlClient,
  artifactId: string,
  maxChars = 16_000,
): Effect.Effect<
  {
    readonly artifactId: string;
    readonly toolName: string;
    readonly rawByteSize: number;
    readonly content: string;
    readonly truncated: boolean;
    readonly createdAt: string;
  } | null,
  never
> {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      readonly output_hash: string;
      readonly tool_name: string;
      readonly raw_bytes: number;
      readonly payload_gzip: Uint8Array;
      readonly created_at: string;
    }>`SELECT output_hash, tool_name, raw_bytes, payload_gzip, created_at
       FROM ccr_tool_outputs
       WHERE output_hash = ${artifactId}
       ORDER BY created_at DESC
       LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    const rawBuf =
      row.payload_gzip instanceof Uint8Array
        ? row.payload_gzip
        : new Uint8Array(row.payload_gzip as ArrayBufferLike);
    const text = gunzipCcrText(rawBuf);
    const clampedCap = Math.max(500, Math.min(maxChars, 64_000));
    const truncated = text.length > clampedCap;
    return {
      artifactId: row.output_hash,
      toolName: row.tool_name,
      rawByteSize: row.raw_bytes,
      content: truncated
        ? `${text.slice(0, clampedCap)}\n...[총 ${text.length}자 중 ${clampedCap}자 표시]`
        : text,
      truncated,
      createdAt: row.created_at,
    };
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

/**
 * Pass-by-Reference (포인터 교신) `CompactHandoffPacket` 생성기.
 * 비밀값 스크러빙 + 3줄×80자 강제 + ≤400T 패킷 경량화.
 */
export function buildCompactHandoffPacket(input: {
  readonly missionId: string;
  readonly hopCount: number;
  readonly reworkCycle: number;
  readonly fromRole: string;
  readonly toRole: string;
  readonly intent: MissionHandoffIntent;
  readonly summaryLines: ReadonlyArray<string>;
  readonly worktreePath?: string | null;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly artifactIds?: ReadonlyArray<string>;
  readonly failingTestCmd?: string | null;
  readonly taskId?: string | null;
  readonly verificationCriteria?: ReadonlyArray<string>;
  readonly verificationProof?: CompactHandoffProof | null;
}): CompactHandoffPacket {
  const sanitizedLines = input.summaryLines
    .map((line) => scrubCcrPayload(line).replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .map((line) =>
      line.length > MAX_SUMMARY_LINE_CHARS ? `${line.slice(0, MAX_SUMMARY_LINE_CHARS - 1)}…` : line,
    );

  const summary3Lines =
    sanitizedLines.length > 0 ? sanitizedLines : [`${input.fromRole} → ${input.toRole} 단계 인계`];

  const changedFiles = [
    ...new Set((input.changedFiles ?? []).map((f) => f.trim()).filter(Boolean)),
  ].slice(0, 12);
  const artifactIds = [
    ...new Set((input.artifactIds ?? []).map((a) => a.trim()).filter(Boolean)),
  ].slice(0, 5);
  const verificationCriteria = (input.verificationCriteria ?? [])
    .map((c) => scrubCcrPayload(c).replace(/\s+/g, " ").trim().slice(0, 90))
    .filter(Boolean)
    .slice(0, 5);

  const proof: CompactHandoffProof | null = input.verificationProof
    ? {
        command: scrubCcrPayload(input.verificationProof.command).slice(0, 120),
        exitCode: input.verificationProof.exitCode,
        artifactId: input.verificationProof.artifactId,
        summary: scrubCcrPayload(input.verificationProof.summary).slice(0, 120),
      }
    : null;

  const idempotencyKey = `hf_${NodeCrypto.createHash("sha256")
    .update(
      `${input.missionId}:${input.hopCount}:${input.reworkCycle}:${input.fromRole}:${input.toRole}:${input.intent}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 16)}`;

  const draft = {
    schemaVersion: "handoff.v2" as const,
    missionId: input.missionId,
    hopCount: input.hopCount,
    reworkCycle: input.reworkCycle,
    fromRole: input.fromRole,
    toRole: input.toRole,
    intent: input.intent,
    summary3Lines,
    pointers: {
      worktreePath: input.worktreePath ?? null,
      changedFiles,
      artifactIds,
      failingTestCmd: input.failingTestCmd
        ? scrubCcrPayload(input.failingTestCmd).slice(0, 120)
        : null,
      taskId: input.taskId ?? null,
    },
    verificationCriteria,
    verificationProof: proof,
    idempotencyKey,
  };

  const estimatedTokens = estimateTextTokens(JSON.stringify(draft));
  return {
    ...draft,
    estimatedTokens,
  };
}
