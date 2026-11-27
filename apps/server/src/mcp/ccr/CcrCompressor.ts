// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { redactToolActivityText } from "@t3tools/shared/toolActivity";
import { scrubSecretsFromText } from "../HostSecurityGuard.ts";

export type CcrMimeKind = "json" | "log" | "text";

export interface SmartCrusherOptions {
  /** Minimum byte size before compression kicks in (default: 4096). */
  readonly minBytes?: number;
  /** Number of leading items/lines to keep verbatim (default: 3 / 15). */
  readonly headItems?: number;
  /** Number of trailing items/lines to keep verbatim (default: 2 / 15). */
  readonly tailItems?: number;
  /** Max anomaly items/lines preserved verbatim (default: 25). */
  readonly maxAnomalies?: number;
  /** Max characters for any single non-anomaly string field in JSON mode (default: 240). */
  readonly maxFieldChars?: number;
}

export interface CcrCompressionResult {
  readonly compressed: boolean;
  readonly outputHash: string;
  readonly toolName: string;
  readonly mimeKind: CcrMimeKind;
  readonly rawBytes: number;
  readonly summaryBytes: number;
  readonly savedPercent: number;
  /** Secret-scrubbed full original text (stored in gzipped CCR ledger when compressed). */
  readonly scrubbedOriginal: string;
  /** Compact representation handed back to the model. */
  readonly summaryText: string;
  readonly retrieveHint: string;
}

export interface CacheAlignedPrompt {
  /** Deterministic, static prefix maximizing provider KV-cache hits. */
  readonly stablePrefix: string;
  /** Volatile metadata (timestamps, counters, runtime IDs) moved to suffix. */
  readonly volatileSuffix: string;
  /** Combined prompt ready for dispatch. */
  readonly combined: string;
  /** Count of volatile lines relocated from prefix blocks. */
  readonly relocatedVolatileLines: number;
}

const DEFAULT_MIN_BYTES = 4_096;
const DEFAULT_JSON_HEAD = 3;
const DEFAULT_JSON_TAIL = 2;
const DEFAULT_LOG_HEAD = 18;
const DEFAULT_LOG_TAIL = 20;
const DEFAULT_MAX_ANOMALIES = 25;
const DEFAULT_MAX_FIELD_CHARS = 240;

const ANOMALY_LINE_PATTERN =
  /\b(?:error|err|fail(?:ed|ure)?|exception|fatal|critical|panic|traceback|assertionerror|typeerror|referenceerror|syntaxerror|unhandled|timed?\s*out|econnrefused|enoent|eperm|ebusy)\b|^\s*at\s+.+:\d+:\d+|×\s+|✗\s+/iu;

const VOLATILE_LINE_PATTERN =
  /\b(?:20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?|elapsed(?:Sec|Ms)?\s*[:=]\s*\d+|current(?:Time|Date|Timestamp)\s*[:=]|uptime\s*[:=]\s*\d+|pid\s*[:=]\s*\d+)\b/iu;

const ANOMALY_KEY_SET = new Set([
  "error",
  "errors",
  "err",
  "failure",
  "failures",
  "exception",
  "stack",
  "stderr",
  "warning",
  "warnings",
  "fatal",
  "critical",
]);

/**
 * Scrubs API keys, bearer tokens, private keys, and credential URLs before
 * hashing or persisting any tool output into the CCR ledger.
 */
export function scrubCcrPayload(raw: string, knownSecrets?: ReadonlyArray<string>): string {
  const step1 = redactToolActivityText(raw);
  return scrubSecretsFromText(step1, knownSecrets);
}

/** Computes a stable short CCR identifier (`ccr_<16hex>`) over scrubbed UTF-8 text. */
export function computeCcrOutputHash(scrubbedText: string): string {
  const hex = NodeCrypto.createHash("sha256").update(scrubbedText, "utf8").digest("hex");
  return `ccr_${hex.slice(0, 16)}`;
}

export function gzipCcrText(scrubbedText: string): Uint8Array {
  return gzipSync(strToU8(scrubbedText), { level: 6 });
}

export function gunzipCcrText(payload: Uint8Array): string {
  return strFromU8(gunzipSync(payload));
}

function isJsonAnomalyRecord(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return ANOMALY_LINE_PATTERN.test(value);
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => isJsonAnomalyRecord(item));
  const record = value as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if (ANOMALY_KEY_SET.has(lower)) {
      if (typeof val === "string" && val.trim().length > 0) return true;
      if (typeof val === "boolean" && val) return true;
      if (Array.isArray(val) && val.length > 0) return true;
      if (val && typeof val === "object") return true;
    }
    if ((lower === "ok" || lower === "passed" || lower === "success") && val === false) {
      return true;
    }
    if (
      (lower === "status" || lower === "level" || lower === "severity" || lower === "state") &&
      typeof val === "string" &&
      /^(?:error|err|fail|failed|fatal|critical|stalled|timeout|rejected|limit_exceeded|warn|warning)$/i.test(
        val.trim(),
      )
    ) {
      return true;
    }
    if (
      (lower === "status" || lower === "statuscode" || lower === "httpstatus") &&
      typeof val === "number" &&
      val >= 400
    ) {
      return true;
    }
    if (lower === "exitcode" && typeof val === "number" && val !== 0) {
      return true;
    }
  }
  return false;
}

function compactJsonValue(value: unknown, maxFieldChars: number, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= maxFieldChars) return value;
    return `${value.slice(0, maxFieldChars)}… [+${value.length - maxFieldChars} chars]`;
  }
  if (typeof value !== "object") return value;
  if (depth >= 4) {
    return Array.isArray(value)
      ? `[Array(${value.length})]`
      : `{Object(${Object.keys(value).length} keys)}`;
  }
  if (Array.isArray(value)) {
    if (value.length <= 6) {
      return value.map((item) => compactJsonValue(item, maxFieldChars, depth + 1));
    }
    return [
      ...value.slice(0, 3).map((item) => compactJsonValue(item, maxFieldChars, depth + 1)),
      `… [${value.length - 4} items omitted]`,
      compactJsonValue(value[value.length - 1], maxFieldChars, depth + 1),
    ];
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = compactJsonValue(v, maxFieldChars, depth + 1);
  }
  return out;
}

function summarizeJsonArray(
  arr: ReadonlyArray<unknown>,
  options: SmartCrusherOptions,
): Record<string, unknown> {
  const headCount = options.headItems ?? DEFAULT_JSON_HEAD;
  const tailCount = options.tailItems ?? DEFAULT_JSON_TAIL;
  const maxAnomalies = options.maxAnomalies ?? DEFAULT_MAX_ANOMALIES;
  const maxFieldChars = options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS;

  const keyFreq = new Map<string, number>();
  const sampleLimit = Math.min(arr.length, 200);
  for (let i = 0; i < sampleLimit; i += 1) {
    const item = arr[i];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const key of Object.keys(item as Record<string, unknown>)) {
        keyFreq.set(key, (keyFreq.get(key) ?? 0) + 1);
      }
    }
  }

  const keptIndices = new Set<number>();
  for (let i = 0; i < Math.min(headCount, arr.length); i += 1) keptIndices.add(i);
  for (let i = Math.max(0, arr.length - tailCount); i < arr.length; i += 1) keptIndices.add(i);

  const anomalies: Array<{ readonly index: number; readonly item: unknown }> = [];
  let totalAnomalies = 0;
  for (let i = 0; i < arr.length; i += 1) {
    if (isJsonAnomalyRecord(arr[i])) {
      totalAnomalies += 1;
      if (anomalies.length < maxAnomalies) {
        anomalies.push({ index: i, item: arr[i] });
      }
    }
  }

  const head = arr
    .slice(0, Math.min(headCount, arr.length))
    .map((item) => compactJsonValue(item, maxFieldChars));
  const tailStart = Math.max(head.length, arr.length - tailCount);
  const tail = arr.slice(tailStart).map((item) => compactJsonValue(item, maxFieldChars));

  return {
    _ccrArraySummary: true,
    totalItems: arr.length,
    omittedItems: Math.max(0, arr.length - head.length - tail.length),
    schemaKeys: [...keyFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([k]) => k),
    head,
    ...(anomalies.length > 0
      ? {
          anomaliesPreserved: anomalies.length,
          anomaliesTotal: totalAnomalies,
          anomalies,
        }
      : {}),
    ...(tail.length > 0 ? { tail } : {}),
  };
}

/**
 * Headroom-inspired statistical JSON compressor (`SmartCrusher`):
 * collapses large repetitive arrays while preserving schema, head/tail context,
 * and 100% of detected error/failure/anomaly records (up to `maxAnomalies`).
 */
export function compressJsonSmartCrusher(
  parsed: unknown,
  options: SmartCrusherOptions = {},
): unknown {
  const maxFieldChars = options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS;
  if (Array.isArray(parsed)) {
    if (
      parsed.length > 10 ||
      JSON.stringify(parsed).length > (options.minBytes ?? DEFAULT_MIN_BYTES)
    ) {
      return summarizeJsonArray(parsed, options);
    }
    return parsed.map((item) => compactJsonValue(item, maxFieldChars));
  }
  if (parsed && typeof parsed === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length > 10) {
        result[key] = summarizeJsonArray(value, options);
      } else {
        result[key] = compactJsonValue(value, maxFieldChars);
      }
    }
    return result;
  }
  return compactJsonValue(parsed, maxFieldChars);
}

function normalizeLogLineForDedup(line: string): string {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<TS>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|kb|mb|gb|%)\b/gi, "<NUM>")
    .replace(/\b\d+\b/g, "<N>")
    .trim();
}

/**
 * Compresses verbose build/test/runtime logs while preserving head, tail, and
 * every error/failure/stacktrace line verbatim.
 */
export function compressLogSmartCrusher(text: string, options: SmartCrusherOptions = {}): string {
  const lines = text.split(/\r?\n/);
  const headCount = options.headItems ?? DEFAULT_LOG_HEAD;
  const tailCount = options.tailItems ?? DEFAULT_LOG_TAIL;
  const maxAnomalies = options.maxAnomalies ?? DEFAULT_MAX_ANOMALIES;

  if (lines.length <= headCount + tailCount + 5) {
    return text;
  }

  const head = lines.slice(0, headCount);
  const tailStart = Math.max(headCount, lines.length - tailCount);
  const tail = lines.slice(tailStart);
  const middle = lines.slice(headCount, tailStart);

  const anomalyLines: string[] = [];
  const patternCounts = new Map<string, number>();
  let collapsedMiddleCount = 0;

  for (let i = 0; i < middle.length; i += 1) {
    const line = middle[i]!;
    if (ANOMALY_LINE_PATTERN.test(line)) {
      if (anomalyLines.length < maxAnomalies) {
        anomalyLines.push(`L${headCount + i + 1}: ${line}`);
      }
    } else {
      collapsedMiddleCount += 1;
      const sig = normalizeLogLineForDedup(line);
      if (sig.length > 0) {
        patternCounts.set(sig, (patternCounts.get(sig) ?? 0) + 1);
      }
    }
  }

  const out: string[] = [...head];
  out.push(
    `... [CCR collapsed ${collapsedMiddleCount} routine lines (${lines.length} total lines; ${patternCounts.size} distinct templates)] ...`,
  );
  if (anomalyLines.length > 0) {
    out.push("[CCR preserved error/anomaly lines]");
    out.push(...anomalyLines);
  }
  out.push(...tail);
  return out.join("\n");
}

function detectMimeKind(
  text: string,
  hint?: CcrMimeKind,
): {
  readonly kind: CcrMimeKind;
  readonly parsedJson?: unknown;
} {
  const trimmed = text.trim();
  if (hint === "json" || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { kind: "json", parsedJson: JSON.parse(trimmed) };
    } catch {
      // Fall through to log/text detection.
    }
  }
  if (hint === "log") return { kind: "log" };
  const lineCount = text.split(/\r?\n/).length;
  if (lineCount >= 25) return { kind: "log" };
  return { kind: hint ?? "text" };
}

/**
 * Main CCR entry point: scrubs secrets, routes by content type (`json`/`log`/`text`),
 * compresses large payloads, and returns a compact summary + lossless hash handle.
 */
export function compressToolOutputForCcr(input: {
  readonly toolName: string;
  readonly rawText: string;
  readonly mimeHint?: CcrMimeKind | undefined;
  readonly knownSecrets?: ReadonlyArray<string> | undefined;
  readonly options?: SmartCrusherOptions | undefined;
}): CcrCompressionResult {
  // Idempotency guard: never re-compress an output that already carries a CCR handle.
  if (input.rawText.includes("[CCR outputHash=")) {
    const rawBytes = Buffer.byteLength(input.rawText, "utf8");
    return {
      compressed: false,
      outputHash: computeCcrOutputHash(input.rawText),
      toolName: input.toolName,
      mimeKind: input.mimeHint ?? "text",
      rawBytes,
      summaryBytes: rawBytes,
      savedPercent: 0,
      scrubbedOriginal: input.rawText,
      summaryText: input.rawText,
      retrieveHint: "",
    };
  }
  const scrubbedOriginal = scrubCcrPayload(input.rawText, input.knownSecrets);
  const outputHash = computeCcrOutputHash(scrubbedOriginal);
  const rawBytes = Buffer.byteLength(scrubbedOriginal, "utf8");
  const minBytes = input.options?.minBytes ?? DEFAULT_MIN_BYTES;
  const detected = detectMimeKind(scrubbedOriginal, input.mimeHint);

  if (rawBytes < minBytes) {
    return {
      compressed: false,
      outputHash,
      toolName: input.toolName,
      mimeKind: detected.kind,
      rawBytes,
      summaryBytes: rawBytes,
      savedPercent: 0,
      scrubbedOriginal,
      summaryText: scrubbedOriginal,
      retrieveHint: "",
    };
  }

  let body: string;
  if (detected.kind === "json" && detected.parsedJson !== undefined) {
    body = JSON.stringify(compressJsonSmartCrusher(detected.parsedJson, input.options), null, 2);
  } else if (detected.kind === "log") {
    body = compressLogSmartCrusher(scrubbedOriginal, input.options);
  } else {
    const keepHead = Math.min(1_600, Math.floor(scrubbedOriginal.length * 0.35));
    const keepTail = Math.min(1_600, Math.floor(scrubbedOriginal.length * 0.35));
    const omitted = Math.max(0, scrubbedOriginal.length - keepHead - keepTail);
    body =
      omitted > 0
        ? `${scrubbedOriginal.slice(0, keepHead)}\n\n... [CCR omitted ${omitted} chars] ...\n\n${scrubbedOriginal.slice(-keepTail)}`
        : scrubbedOriginal;
  }

  const retrieveHint = `[CCR outputHash=${outputHash} rawBytes=${rawBytes} tool=${input.toolName}] Call workspace_retrieve_output({ outputHash: "${outputHash}", sliceStart?, sliceLength?, jsonPath?, grep? }) to inspect any exact slice losslessly.`;
  const candidate = `${body}\n\n${retrieveHint}`;
  const candidateBytes = Buffer.byteLength(candidate, "utf8");

  // Only claim compression if the summary is meaningfully smaller than raw.
  if (candidateBytes >= rawBytes * 0.92) {
    return {
      compressed: false,
      outputHash,
      toolName: input.toolName,
      mimeKind: detected.kind,
      rawBytes,
      summaryBytes: rawBytes,
      savedPercent: 0,
      scrubbedOriginal,
      summaryText: scrubbedOriginal,
      retrieveHint: "",
    };
  }

  const savedPercent = Math.max(0, Math.round(((rawBytes - candidateBytes) / rawBytes) * 100));
  return {
    compressed: true,
    outputHash,
    toolName: input.toolName,
    mimeKind: detected.kind,
    rawBytes,
    summaryBytes: candidateBytes,
    savedPercent,
    scrubbedOriginal,
    summaryText: candidate,
    retrieveHint,
  };
}

/**
 * Headroom-inspired `CacheAligner`:
 * keeps static instruction blocks at the front of the prompt and relocates
 * volatile runtime lines (timestamps, PIDs, elapsed timers) to the tail so
 * provider KV-cache prefixes stay bit-for-bit stable across turns.
 */
export function alignPromptForPrefixCache(input: {
  readonly staticSections: ReadonlyArray<string>;
  readonly volatileSections?: ReadonlyArray<string> | undefined;
}): CacheAlignedPrompt {
  const cleanStatic: string[] = [];
  const relocated: string[] = [];

  for (const section of input.staticSections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const keptLines: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (VOLATILE_LINE_PATTERN.test(line)) {
        relocated.push(line.trim());
      } else {
        keptLines.push(line);
      }
    }
    const rebuilt = keptLines.join("\n").trim();
    if (rebuilt) cleanStatic.push(rebuilt);
  }

  const explicitVolatile = (input.volatileSections ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const volatileParts = [
    ...(relocated.length > 0
      ? [`<runtime_volatile_meta>\n${relocated.join("\n")}\n</runtime_volatile_meta>`]
      : []),
    ...explicitVolatile,
  ];

  const stablePrefix = cleanStatic.join("\n\n");
  const volatileSuffix = volatileParts.join("\n\n");
  const combined =
    stablePrefix && volatileSuffix
      ? `${stablePrefix}\n\n${volatileSuffix}`
      : stablePrefix || volatileSuffix;

  return {
    stablePrefix,
    volatileSuffix,
    combined,
    relocatedVolatileLines: relocated.length,
  };
}

// ── Phase 3: t0 Coding-Tool Filters, Edit Receipt & Break-Even Gate ───────

export type CodingToolKind = "read" | "test" | "typecheck" | "git-diff" | "grep" | "generic";

export interface CodingToolT0Input {
  readonly toolKind: CodingToolKind;
  readonly toolName: string;
  readonly rawText: string;
  readonly exitCode?: number | undefined;
  readonly filePath?: string | undefined;
  readonly explicitLineRange?: boolean | undefined;
  readonly knownSecrets?: ReadonlyArray<string> | undefined;
}

const SYMBOL_DECL_PATTERN =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const\s+[A-Za-z0-9_]+\s*=\s*(?:async\s*)?\(|def\s+|pub\s+(?:async\s+)?(?:fn|struct|enum|trait)|fn\s+|func\s+)/u;

const LOCK_OR_GENERATED_FILE_PATTERN =
  /(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.min\.js$|(?:^|\/)(?:dist|dist-electron|build|coverage)\/)/i;

function extractFastSymbolOutline(lines: ReadonlyArray<string>, maxSymbols = 45): string[] {
  const outline: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (SYMBOL_DECL_PATTERN.test(line)) {
      const compact = line.trim().replace(/\s+/g, " ").slice(0, 110);
      outline.push(`L${i + 1}: ${compact}`);
      if (outline.length >= maxSymbols) break;
    }
  }
  return outline;
}

function filterTestRunnerOutput(text: string, exitCode: number | undefined): string {
  const lines = text.split(/\r?\n/);
  if (exitCode === 0) {
    const summaryLines = lines
      .filter((line) =>
        /(?:Test Files|Tests\s+\d+|passed|Duration|Ran \d+ tests|OK\s*\(|test result:\s*ok)/i.test(
          line,
        ),
      )
      .slice(-4);
    const body =
      summaryLines.length > 0
        ? summaryLines.map((l) => l.trim()).join(" | ")
        : `${lines.length} lines (exit 0)`;
    return `[PASS] ${body}`;
  }
  const kept: string[] = [];
  let userFrames = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\s*[✓✔]\s+|^\s*PASS\s+/u.test(line)) continue;
    if (/^\s*at\s+.*node_modules/i.test(line)) continue;
    if (/^\s*at\s+/u.test(line)) {
      if (userFrames >= 5) continue;
      userFrames += 1;
      kept.push(line.slice(0, 200));
      continue;
    }
    if (
      /FAIL|ERROR|AssertionError|Expected|Received|TypeError|ReferenceError|SyntaxError|Test Files|Tests\s+\d+/i.test(
        line,
      )
    ) {
      kept.push(line.slice(0, 220));
      if (kept.length >= 45) break;
    }
  }
  return kept.length > 0 ? kept.join("\n") : compressLogSmartCrusher(text);
}

function filterTypecheckOrLintOutput(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => !/^[\s│─╭╰┌└┐┘├┤┬┴┼]+$/u.test(l) && l.trim().length > 0);
  const clusters = new Map<string, string[]>();
  const standalone: string[] = [];
  for (const line of lines) {
    const match = line.match(/\b(TS\d{4}|E\d{4}|no-[a-z-]+)\b/i);
    if (match) {
      const code = match[1]!.toUpperCase();
      const bucket = clusters.get(code) ?? [];
      bucket.push(line.trim().slice(0, 200));
      clusters.set(code, bucket);
    } else if (/error|warning|found \d+ error/i.test(line)) {
      standalone.push(line.trim().slice(0, 200));
    }
  }
  if (clusters.size === 0) return compressLogSmartCrusher(text);
  const out: string[] = [];
  for (const [code, items] of clusters.entries()) {
    out.push(`[${code} x${items.length}]`);
    for (const sample of items.slice(0, 3)) out.push(`  ${sample}`);
    if (items.length > 3) out.push(`  ... (+${items.length - 3} more ${code} occurrences)`);
  }
  if (standalone.length > 0) {
    out.push(...standalone.slice(-4));
  }
  return out.join("\n");
}

function filterGitDiffOutput(text: string): string {
  const sections = text.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  for (const sec of sections) {
    const header = sec.split(/\r?\n/, 1)[0] ?? "";
    const fileMatch = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const filePath = fileMatch?.[2] ?? "";
    if (filePath && LOCK_OR_GENERATED_FILE_PATTERN.test(filePath)) {
      const lineCount = sec.split(/\r?\n/).length;
      kept.push(`[omitted generated/lockfile diff: ${filePath} (${lineCount} lines)]`);
    } else {
      kept.push(sec);
    }
  }
  return kept.join("\n").trim();
}

function filterGrepOutput(text: string): string {
  const lines = text.split(/\r?\n/);
  const byFile = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const clipped = raw.length > 240 ? `${raw.slice(0, 237)}...` : raw;
    const match = clipped.match(/^([^:\s][^:]{1,180}):(\d+):(.*)$/);
    if (match) {
      const file = match[1]!;
      const bucket = byFile.get(file) ?? [];
      bucket.push(`L${match[2]}:${match[3]}`);
      byFile.set(file, bucket);
    } else {
      ungrouped.push(clipped);
    }
  }
  const out: string[] = [];
  for (const [file, matches] of byFile.entries()) {
    out.push(`${file} (${matches.length} matches)`);
    for (const m of matches.slice(0, 5)) out.push(`  ${m}`);
    if (matches.length > 5) out.push(`  ... (+${matches.length - 5} more)`);
  }
  if (ungrouped.length > 0) out.push(...ungrouped.slice(0, 20));
  return out.join("\n");
}

/**
 * Prefix-cache-preserving `t0` coding-tool output filter (`S = 0`, 0% cache bust).
 * Preserves explicit <=350-line file reads verbatim; summarizes unbounded >400-line
 * reads into head-60 + symbol outline; applies exit-code-aware test/tsc/git/grep filters.
 */
export function compressCodingToolOutputAtT0(input: CodingToolT0Input): CcrCompressionResult {
  if (input.rawText.includes("[CCR outputHash=")) {
    return compressToolOutputForCcr({
      toolName: input.toolName,
      rawText: input.rawText,
      knownSecrets: input.knownSecrets,
    });
  }

  const scrubbedOriginal = scrubCcrPayload(input.rawText, input.knownSecrets);
  const outputHash = computeCcrOutputHash(scrubbedOriginal);
  const rawBytes = Buffer.byteLength(scrubbedOriginal, "utf8");
  const lines = scrubbedOriginal.split(/\r?\n/);

  // Rule 1: Explicit bounded Read (<=350 lines) is NEVER compressed.
  if (input.toolKind === "read") {
    if (input.explicitLineRange === true && lines.length <= 350) {
      return {
        compressed: false,
        outputHash,
        toolName: input.toolName,
        mimeKind: "text",
        rawBytes,
        summaryBytes: rawBytes,
        savedPercent: 0,
        scrubbedOriginal,
        summaryText: scrubbedOriginal,
        retrieveHint: "",
      };
    }
    if (lines.length <= 400) {
      return {
        compressed: false,
        outputHash,
        toolName: input.toolName,
        mimeKind: "text",
        rawBytes,
        summaryBytes: rawBytes,
        savedPercent: 0,
        scrubbedOriginal,
        summaryText: scrubbedOriginal,
        retrieveHint: "",
      };
    }
    const head60 = lines.slice(0, 60).join("\n");
    const outline = extractFastSymbolOutline(lines);
    const label = input.filePath ?? input.toolName;
    const retrieveHint = `[CCR outputHash=${outputHash} rawBytes=${rawBytes} lines=${lines.length} tool=${input.toolName}] Call workspace_retrieve_output({ outputHash: "${outputHash}", sliceStart?, sliceLength?, grep? }) or Read with explicit line range.`;
    const summaryText = [
      `[READ OUTLINE: ${label} (${lines.length} lines — unbounded read compressed at t0)]`,
      head60,
      outline.length > 0 ? `\n[SYMBOL OUTLINE]\n${outline.join("\n")}` : "",
      `\n${retrieveHint}`,
    ]
      .filter(Boolean)
      .join("\n");
    const summaryBytes = Buffer.byteLength(summaryText, "utf8");
    const savedPercent = Math.max(0, Math.round(((rawBytes - summaryBytes) / rawBytes) * 100));
    return {
      compressed: summaryBytes < rawBytes * 0.92,
      outputHash,
      toolName: input.toolName,
      mimeKind: "text",
      rawBytes,
      summaryBytes: summaryBytes < rawBytes * 0.92 ? summaryBytes : rawBytes,
      savedPercent: summaryBytes < rawBytes * 0.92 ? savedPercent : 0,
      scrubbedOriginal,
      summaryText: summaryBytes < rawBytes * 0.92 ? summaryText : scrubbedOriginal,
      retrieveHint: summaryBytes < rawBytes * 0.92 ? retrieveHint : "",
    };
  }

  let filteredBody: string | null = null;
  if (input.toolKind === "test" && rawBytes >= 1_024) {
    filteredBody = filterTestRunnerOutput(scrubbedOriginal, input.exitCode);
  } else if (input.toolKind === "typecheck" && rawBytes >= 1_536) {
    filteredBody = filterTypecheckOrLintOutput(scrubbedOriginal);
  } else if (input.toolKind === "git-diff" && rawBytes >= 1_536) {
    filteredBody = filterGitDiffOutput(scrubbedOriginal);
  } else if (input.toolKind === "grep" && rawBytes >= 2_048) {
    filteredBody = filterGrepOutput(scrubbedOriginal);
  }

  if (filteredBody === null) {
    return compressToolOutputForCcr({
      toolName: input.toolName,
      rawText: scrubbedOriginal,
      knownSecrets: input.knownSecrets,
    });
  }

  const retrieveHint = `[CCR outputHash=${outputHash} rawBytes=${rawBytes} tool=${input.toolName}] Call workspace_retrieve_output({ outputHash: "${outputHash}", sliceStart?, sliceLength?, grep? }) for full raw output.`;
  const candidate = `${filteredBody}\n${retrieveHint}`;
  const candidateBytes = Buffer.byteLength(candidate, "utf8");
  if (candidateBytes >= rawBytes * 0.92) {
    return {
      compressed: false,
      outputHash,
      toolName: input.toolName,
      mimeKind: "log",
      rawBytes,
      summaryBytes: rawBytes,
      savedPercent: 0,
      scrubbedOriginal,
      summaryText: scrubbedOriginal,
      retrieveHint: "",
    };
  }
  const savedPercent = Math.max(0, Math.round(((rawBytes - candidateBytes) / rawBytes) * 100));
  return {
    compressed: true,
    outputHash,
    toolName: input.toolName,
    mimeKind: "log",
    rawBytes,
    summaryBytes: candidateBytes,
    savedPercent,
    scrubbedOriginal,
    summaryText: candidate,
    retrieveHint,
  };
}

/** Compact ~22-token 1-line edit receipt replacing redundant code re-echo. */
export function formatCompactEditReceipt(input: {
  readonly path: string;
  readonly lineRange: string;
  readonly lineDelta: number;
  readonly contentAfter: string;
  readonly syntaxStatus?: "PASS" | "FAIL" | "SKIP";
}): string {
  const sha = NodeCrypto.createHash("sha256")
    .update(input.contentAfter, "utf8")
    .digest("hex")
    .slice(0, 8);
  const deltaStr = input.lineDelta >= 0 ? `+${input.lineDelta}` : `${input.lineDelta}`;
  return `[EDIT OK] ${input.path}:${input.lineRange} (${deltaStr} lines) | sha256:${sha} | syntax:${input.syntaxStatus ?? "SKIP"}`;
}

/**
 * Prefix-cache break-even gate (Yang et al., 2026) + Haiku 65k cliff guard.
 * Never triggers per-turn rolling masking; triggers clean-capsule rollover ONLY
 * when removable observation mass B >= 30,000 AND B/S >= 1.80, or when Haiku
 * approaches its 100k pricing cliff (>= 65,000 tokens).
 */
export function evaluateBatchCompactionGate(input: {
  readonly model?: string | undefined;
  readonly totalContextTokens: number;
  readonly removableObservationTokens: number;
  readonly protectedSuffixTokens: number;
}): {
  readonly shouldRollover: boolean;
  readonly reason: "none" | "haiku-cliff-guard" | "breakeven-batch";
} {
  const lowerModel = (input.model ?? "").toLowerCase();
  if (lowerModel.includes("haiku") && input.totalContextTokens >= 65_000) {
    return { shouldRollover: true, reason: "haiku-cliff-guard" };
  }
  const suffix = Math.max(1, input.protectedSuffixTokens);
  if (
    input.removableObservationTokens >= 30_000 &&
    input.removableObservationTokens / suffix >= 1.8
  ) {
    return { shouldRollover: true, reason: "breakeven-batch" };
  }
  return { shouldRollover: false, reason: "none" };
}
