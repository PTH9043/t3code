// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import { getNativeMemoryCore, runNativeSafe } from "./nativeMemoryCore.ts";

const Vector = Schema.Array(Schema.Number.check(Schema.isFinite())).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
);
export const EmbeddingResponse = Schema.Struct({ embeddings: Schema.Array(Vector) });
const decodeVector = Schema.decodeUnknownSync(Schema.fromJsonString(Vector));
const encodeVector = Schema.encodeSync(Schema.fromJsonString(Vector));
const decodeVectors = Schema.decodeUnknownSync(Schema.Array(Vector));
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
export type SemanticCandidate = {
  id: string;
  title: string;
  content: string;
  projectId?: string;
  itemId?: string;
  contextPrefix?: string | undefined;
  indexTail?: string | undefined;
};
export type SemanticScope = {
  stateDir: string;
  projectId: string;
  endpoint: string;
  model: string;
};
export const EMBEDDING_INPUT_BYTES = 4096;
export const EMBEDDING_BATCH_BYTES = 8192;
/** Hard timeout cap for query-time embeddings so slow/offline local Ollama never stalls a turn. */
export const SEMANTIC_QUERY_EMBED_TIMEOUT_MS = 400;

/** Bound UTF-8 input before tokenization or transport, preserving surrogate pairs. */
export function boundedEmbeddingText(text: string, maxBytes = EMBEDDING_INPUT_BYTES): string {
  let end = Math.min(text.length, maxBytes);
  if (NodeBuffer.Buffer.byteLength(text.slice(0, end)) > maxBytes) {
    let low = 0;
    let high = end;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (NodeBuffer.Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    end = low;
  }
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
  return text.slice(0, end).toWellFormed();
}
export const semanticContentText = (
  candidate: Pick<SemanticCandidate, "title" | "content" | "contextPrefix" | "indexTail">,
) => {
  const base = `title: ${boundedEmbeddingText(candidate.title, 512)} | text: ${candidate.content.slice(0, 1400)}`;
  if (!candidate.contextPrefix && !candidate.indexTail) {
    return boundedEmbeddingText(base);
  }
  const prefix = candidate.contextPrefix
    ? `context: ${boundedEmbeddingText(candidate.contextPrefix, 360)} | `
    : "";
  const tail = candidate.indexTail
    ? ` | meta: ${boundedEmbeddingText(candidate.indexTail, 360)}`
    : "";
  return boundedEmbeddingText(`${prefix}${base}${tail}`);
};
export const semanticContentKey = (
  candidate: Pick<SemanticCandidate, "title" | "content" | "contextPrefix" | "indexTail">,
) => hash(semanticContentText(candidate));

/**
 * Deterministic context prefix + temporal/scope tail shared by `SemanticIndexJobs`
 * and `ProjectionWorkspaceRag` so indexing and query-time lookup derive identical keys
 * without polluting user-facing `content`.
 */
export function buildRagSemanticEnvelope(row: {
  readonly scope?: string | null | undefined;
  readonly appliesToFolder?: string | null | undefined;
  readonly tagsText?: string | null | undefined;
  readonly updatedAt?: string | null | undefined;
}): { readonly contextPrefix?: string; readonly indexTail?: string } {
  const tags = row.tagsText ?? "";
  const isAutoConversation = /\bauto-conversation\b/u.test(tags);
  // Keep plain root knowledge items hash-compatible with existing cached vectors unless
  // scoped to a subfolder or captured from conversation memory.
  if (!isAutoConversation && !row.appliesToFolder) {
    return {};
  }
  const scopePart = row.scope ? `범위:${row.scope}` : "";
  const folderPart = row.appliesToFolder ? `폴더:${row.appliesToFolder}` : "";
  const datePart =
    typeof row.updatedAt === "string" && row.updatedAt.length >= 10
      ? `기준일:${row.updatedAt.slice(0, 10)}`
      : "";
  const contextParts = [datePart, scopePart, folderPart].filter(Boolean);
  const cleanTags = tags
    .split(/\s+/u)
    .filter(
      (t) => t.length > 0 && !/-chars-\d+$/u.test(t) && !/^(?:thread|source)-[0-9a-f]+$/u.test(t),
    )
    .slice(0, 8)
    .join(" ");
  return {
    ...(contextParts.length > 0 ? { contextPrefix: contextParts.join(" · ") } : {}),
    ...(cleanTags ? { indexTail: cleanTags } : {}),
  };
}

const MULTILINGUAL_SAFE_EMBEDDING_MODEL =
  /(?:multilingual|bge-m3|nomic-embed-text-v2|embeddinggemma|text-embedding-3|embedding-3|embedding-v1|ko[-_]|korean|qwen\d*(?:\.\d+)?-embedding|jina-embeddings-v3)/iu;
const ENGLISH_ONLY_EMBEDDING_MODEL =
  /(?:^|[/:_-])(?:bge-(?:small|base|large)-en|all-minilm-l\d+|nomic-embed-text(?:-v1(?:\.5)?)?|mxbai-embed-large|snowflake-arctic-embed(?!-l-v2)|gte-(?:small|base|large)|e5-(?:small|base|large))(?:$|[/:._-])/iu;

/**
 * Warn when a configured local embedding model is English-only, which collapses Korean
 * cosine distances into a narrow high band (Korean Memory Bottleneck #4).
 */
export function getEmbeddingModelMultilingualAdvisory(modelName: string): string | null {
  const trimmed = modelName.trim();
  if (!trimmed || MULTILINGUAL_SAFE_EMBEDDING_MODEL.test(trimmed)) return null;
  if (!ENGLISH_ONLY_EMBEDDING_MODEL.test(trimmed)) return null;
  return `현재 임베딩 모델('${trimmed}')은 영어 전용 모델이어서 한국어 문맥 유사도 변별력이 낮을 수 있습니다. 한국어·코드 혼합 환경에서는 다국어 모델('bge-m3' 또는 'multilingual-e5-large') 사용을 권장합니다.`;
}

export type SemanticEmbeddingInput = {
  readonly endpoint: string;
  readonly model: string;
  readonly texts: readonly string[];
  readonly purpose: "index" | "query";
  readonly signal: AbortSignal;
};

export const PROVIDER_EMBEDDING_ENDPOINT_PREFIX = "provider://";
const PROVIDER_EMBEDDING_INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function parseProviderEmbeddingInstanceId(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (!trimmed.startsWith(PROVIDER_EMBEDDING_ENDPOINT_PREFIX)) return null;
  const instanceId = trimmed.slice(PROVIDER_EMBEDDING_ENDPOINT_PREFIX.length);
  return PROVIDER_EMBEDDING_INSTANCE_ID_PATTERN.test(instanceId) ? instanceId : null;
}

export function formatProviderEmbeddingEndpoint(instanceId: string): string {
  const trimmed = instanceId.trim();
  if (!PROVIDER_EMBEDDING_INSTANCE_ID_PATTERN.test(trimmed)) {
    throw new Error("등록된 제공자 인스턴스 ID가 올바르지 않습니다.");
  }
  return `${PROVIDER_EMBEDDING_ENDPOINT_PREFIX}${trimmed}`;
}

export function normalizeSemanticEndpoint(endpoint: string): string {
  const providerInstanceId = parseProviderEmbeddingInstanceId(endpoint);
  if (providerInstanceId !== null) {
    return `${PROVIDER_EMBEDDING_ENDPOINT_PREFIX}${providerInstanceId}`;
  }
  const parsed = new URL(endpoint);
  if (
    !(
      ["http:", "https:"].includes(parsed.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    )
  )
    throw new Error("로컬 의미 검색 주소는 이 환경의 localhost여야 합니다.");
  return parsed.origin;
}

export function semanticScopeKey(scope: Omit<SemanticScope, "stateDir">): string {
  const normalizedEndpoint = normalizeSemanticEndpoint(scope.endpoint);
  return hash(JSON.stringify([scope.projectId, normalizedEndpoint, scope.model]));
}
export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>) {
  if (left.length !== right.length || left.length === 0) return 0;
  let product = 0,
    leftNorm = 0,
    rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const l = left[index]!;
    const r = right[index]!;
    product += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  return leftNorm > 0 && rightNorm > 0 ? product / Math.sqrt(leftNorm * rightNorm) : 0;
}

export interface SemanticChunkHit {
  chunkId: string;
  filePath: string;
  content: string;
  rrfScore: number;
  cosineDistance: number | null;
  bm25Rank: number | null;
}

const POPCOUNT_8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i;
  let c = 0;
  while (v) {
    v &= v - 1;
    c++;
  }
  POPCOUNT_8[i] = c;
}

/**
 * Serialize a Float32Array or number[] into a raw Little-Endian Buffer.
 */
export function serializeFloat32Vector(vec: Float32Array | readonly number[]): NodeBuffer.Buffer {
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
  return NodeBuffer.Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Deserialize a raw Little-Endian Buffer or Uint8Array back into a Float32Array.
 */
export function deserializeFloat32Vector(buf: Uint8Array): Float32Array {
  const aligned = new Uint8Array(buf.byteLength);
  aligned.set(buf);
  return new Float32Array(aligned.buffer);
}

/**
 * Lossless Float64 vector serialization (preserves exact double-precision boundaries such as 0.56)
 * with backward-compatible decoding for previously written Float32 BLOBs.
 */
function serializeFloat64Vector(vec: readonly number[]): NodeBuffer.Buffer {
  const f64 = new Float64Array(vec);
  return NodeBuffer.Buffer.from(f64.buffer, f64.byteOffset, f64.byteLength);
}

function deserializeStoredVector(buf: Uint8Array, dim: number): Float64Array | Float32Array {
  if (dim > 0 && buf.byteLength === dim * 8) {
    const aligned = new Uint8Array(buf.byteLength);
    aligned.set(buf);
    return new Float64Array(aligned.buffer);
  }
  return deserializeFloat32Vector(buf);
}

/**
 * Matryoshka Representation Learning (MRL) dimension truncation + L2 normalization.
 */
export function sliceAndNormalizeMatryoshka(
  fullVector: Float32Array | readonly number[],
  targetDim: number = 512,
): Float32Array {
  const sliced = new Float32Array(targetDim);
  let normSq = 0;
  for (let i = 0; i < targetDim; i++) {
    const val = fullVector[i] ?? 0;
    sliced[i] = val;
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq) || 1.0;
  for (let i = 0; i < targetDim; i++) {
    sliced[i] = (sliced[i] ?? 0) / norm;
  }
  return sliced;
}

/**
 * 1-bit Binary Quantization (32x compression compared to float32).
 */
export function quantizeBinaryVector(vec: Float32Array | readonly number[]): Uint8Array {
  const byteLength = Math.ceil(vec.length / 8);
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < vec.length; i++) {
    if ((vec[i] ?? 0) > 0) {
      out[i >> 3]! |= 1 << (i & 7);
    }
  }
  return out;
}

/**
 * Fast XOR + popcount Hamming distance between two binary-quantized vectors.
 */
export function hammingDistanceBinary(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < len; i++) {
    dist += POPCOUNT_8[(a[i]! ^ b[i]!) & 0xff]!;
  }
  for (let i = len; i < a.length; i++) {
    dist += POPCOUNT_8[a[i]! & 0xff]!;
  }
  for (let i = len; i < b.length; i++) {
    dist += POPCOUNT_8[b[i]! & 0xff]!;
  }
  return dist;
}

export interface SqliteHybridDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

/**
 * Initialize SQLite Binary Quantization + Float32 + FTS5 hybrid schema.
 */
export function initSqliteVecHybridSchema(
  db: SqliteHybridDatabaseLike,
  _embeddingDim: number = 512,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_chunks_meta (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_semantic_chunks_ws_hash
      ON semantic_chunks_meta (workspace_id, content_hash);

    CREATE TABLE IF NOT EXISTS semantic_vec_bin (
      rowid INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS semantic_vec_f32 (
      rowid INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      file_path,
      content,
      tokenize = 'unicode61 tokenchars ''_.-/:#'''
    );
  `);
}

/**
 * Upsert a chunk and its Float32 + 1-bit Binary Quantized vectors into the SQLite hybrid index.
 */
export function upsertSqliteVecHybridChunk(
  db: SqliteHybridDatabaseLike,
  input: {
    chunkId: string;
    workspaceId: string;
    filePath: string;
    content: string;
    embedding: Float32Array | readonly number[];
    updatedAt?: number;
  },
): number {
  const contentHash = hash(`${input.filePath}:${input.content}`);
  const nowMs = input.updatedAt ?? Date.now();
  const existing = db
    .prepare("SELECT rowid FROM semantic_chunks_meta WHERE chunk_id = ?")
    .get(input.chunkId) as { rowid: number } | undefined;

  let rowid: number;
  if (existing) {
    rowid = Number(existing.rowid);
    db.prepare(
      `UPDATE semantic_chunks_meta
       SET workspace_id = ?, file_path = ?, content_hash = ?, content = ?, updated_at = ?
       WHERE rowid = ?`,
    ).run(input.workspaceId, input.filePath, contentHash, input.content, nowMs, rowid);
    db.prepare("DELETE FROM semantic_chunks_fts WHERE rowid = ?").run(rowid);
  } else {
    const res = db
      .prepare(
        `INSERT INTO semantic_chunks_meta (chunk_id, workspace_id, file_path, content_hash, content, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.chunkId, input.workspaceId, input.filePath, contentHash, input.content, nowMs);
    rowid = Number(res.lastInsertRowid);
  }

  const binBuf = NodeBuffer.Buffer.from(quantizeBinaryVector(input.embedding));
  const f32Buf = serializeFloat32Vector(input.embedding);

  db.prepare("INSERT OR REPLACE INTO semantic_vec_bin (rowid, embedding) VALUES (?, ?)").run(
    rowid,
    binBuf,
  );
  db.prepare("INSERT OR REPLACE INTO semantic_vec_f32 (rowid, embedding) VALUES (?, ?)").run(
    rowid,
    f32Buf,
  );
  db.prepare(
    "INSERT INTO semantic_chunks_fts (rowid, chunk_id, file_path, content) VALUES (?, ?, ?, ?)",
  ).run(rowid, input.chunkId, input.filePath, input.content);

  return rowid;
}

/**
 * Two-stage Binary Oversampling (Hamming scan) + Float32 Cosine Reranking + FTS5 BM25 RRF(k=60) hybrid search.
 */
export function searchWorkspaceHybridSqliteVec(
  db: SqliteHybridDatabaseLike,
  workspaceId: string,
  queryText: string,
  queryEmbedding: Float32Array | readonly number[],
  options: { topK?: number; oversampleFactor?: number; rrfK?: number } = {},
): SemanticChunkHit[] {
  const topK = options.topK ?? 12;
  const oversampleFactor = options.oversampleFactor ?? 5;
  const rrfK = options.rrfK ?? 60;
  const queryBin = quantizeBinaryVector(queryEmbedding);
  const queryF32 =
    queryEmbedding instanceof Float32Array ? Array.from(queryEmbedding) : [...queryEmbedding];

  // Stage 1: Binary Quantization Hamming scan with 5x oversampling
  const binRows = db
    .prepare(
      `SELECT b.rowid, b.embedding
       FROM semantic_vec_bin b
       INNER JOIN semantic_chunks_meta m ON m.rowid = b.rowid
       WHERE m.workspace_id = ?`,
    )
    .all(workspaceId) as Array<{ rowid: number; embedding: Uint8Array }>;

  const binCandidates = binRows
    .map((row) => ({
      rowid: Number(row.rowid),
      distance: hammingDistanceBinary(queryBin, row.embedding),
    }))
    .sort((a, b) => a.distance - b.distance || a.rowid - b.rowid)
    .slice(0, topK * oversampleFactor);

  // Stage 2: Exact Float32 cosine distance reranking on the oversampled candidate rowIds
  let denseRanked: Array<{ rowid: number; cosineDistance: number }> = [];
  if (binCandidates.length > 0) {
    const rowIds = binCandidates.map((c) => c.rowid);
    const placeholders = rowIds.map(() => "?").join(",");
    const f32Rows = db
      .prepare(
        `SELECT f.rowid, f.embedding
         FROM semantic_vec_f32 f
         INNER JOIN semantic_chunks_meta m ON m.rowid = f.rowid
         WHERE f.rowid IN (${placeholders}) AND m.workspace_id = ?`,
      )
      .all(...rowIds, workspaceId) as Array<{ rowid: number; embedding: Uint8Array }>;

    denseRanked = f32Rows
      .map((row) => {
        const vec = Array.from(deserializeFloat32Vector(row.embedding));
        const sim = cosineSimilarity(queryF32, vec);
        return {
          rowid: Number(row.rowid),
          cosineDistance: Math.max(0, 1 - sim),
        };
      })
      .sort((a, b) => a.cosineDistance - b.cosineDistance || a.rowid - b.rowid)
      .slice(0, topK * 2);
  }

  // Stage 3: FTS5 BM25 lexical search
  const sanitizedFtsQuery = queryText
    .replace(/["'()*^]/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((t) => t.length >= 2)
    .map((t) => `"${t}"`)
    .join(" OR ");

  let sparseRanked: Array<{ rowid: number; bm25Score: number }> = [];
  if (sanitizedFtsQuery.length > 0) {
    sparseRanked = (
      db
        .prepare(
          `SELECT fts.rowid, bm25(semantic_chunks_fts) AS bm25Score
           FROM semantic_chunks_fts fts
           INNER JOIN semantic_chunks_meta m ON m.rowid = fts.rowid
           WHERE semantic_chunks_fts MATCH ? AND m.workspace_id = ?
           ORDER BY bm25Score ASC
           LIMIT ?`,
        )
        .all(sanitizedFtsQuery, workspaceId, topK * 2) as Array<{
        rowid: number;
        bm25Score: number;
      }>
    ).map((r) => ({ rowid: Number(r.rowid), bm25Score: Number(r.bm25Score) }));
  }

  // Stage 4: RRF (Reciprocal Rank Fusion, k=60)
  const rrfMap = new Map<
    number,
    { rrfScore: number; cosineDistance: number | null; bm25Rank: number | null }
  >();

  denseRanked.forEach((item, idx) => {
    const rank = idx + 1;
    const prev = rrfMap.get(item.rowid) ?? { rrfScore: 0, cosineDistance: null, bm25Rank: null };
    prev.rrfScore += 1.0 / (rrfK + rank);
    prev.cosineDistance = item.cosineDistance;
    rrfMap.set(item.rowid, prev);
  });

  sparseRanked.forEach((item, idx) => {
    const rank = idx + 1;
    const prev = rrfMap.get(item.rowid) ?? { rrfScore: 0, cosineDistance: null, bm25Rank: null };
    prev.rrfScore += 1.0 / (rrfK + rank);
    prev.bm25Rank = rank;
    rrfMap.set(item.rowid, prev);
  });

  const topRowIds = [...rrfMap.entries()]
    .sort((a, b) => b[1].rrfScore - a[1].rrfScore || a[0] - b[0])
    .slice(0, topK)
    .map(([rowid]) => rowid);

  if (topRowIds.length === 0) return [];

  const metaPlaceholders = topRowIds.map(() => "?").join(",");
  const metaRows = db
    .prepare(
      `SELECT rowid, chunk_id as chunkId, file_path as filePath, content
       FROM semantic_chunks_meta
       WHERE rowid IN (${metaPlaceholders})`,
    )
    .all(...topRowIds) as Array<{
    rowid: number;
    chunkId: string;
    filePath: string;
    content: string;
  }>;

  const metaById = new Map(metaRows.map((r) => [Number(r.rowid), r]));

  return topRowIds
    .map((rowid) => {
      const meta = metaById.get(rowid);
      const scores = rrfMap.get(rowid);
      if (!meta || !scores) return null;
      return {
        chunkId: meta.chunkId,
        filePath: meta.filePath,
        content: meta.content,
        rrfScore: scores.rrfScore,
        cosineDistance: scores.cosineDistance,
        bm25Rank: scores.bm25Rank,
      };
    })
    .filter((x): x is SemanticChunkHit => x !== null);
}
// An FTS hit already has lexical evidence. A semantic-only hit must qualify on its own.
const MIN_KEYWORD_BOOST_SIMILARITY = 0.48;
export const MIN_SEMANTIC_ONLY_SIMILARITY = 0.56;
export const DEFAULT_RRF_K = 60;
export const DEFAULT_RRF_TOP_N = 100;
export function reciprocalRankFusion(
  lexical: readonly string[],
  semantic: readonly { id: string; similarity: number }[],
  k: number = DEFAULT_RRF_K,
  topNCandidates: number = DEFAULT_RRF_TOP_N,
) {
  const scores = new Map<string, number>();
  lexical.forEach((id, rank) => scores.set(id, 1 / (k + rank + 1)));
  semantic
    .filter(
      ({ id, similarity }) =>
        similarity >=
        (scores.has(id) ? MIN_KEYWORD_BOOST_SIMILARITY : MIN_SEMANTIC_ONLY_SIMILARITY),
    )
    .forEach((entry, rank) =>
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + 1 / (k + rank + 1)),
    );
  return [...scores]
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, topNCandidates);
}

/**
 * Multi-arm Reciprocal Rank Fusion (`k = 60`) combining Semantic, Hangul 2-gram BM25,
 * Entity Co-occurrence, and Bi-temporal Proximity ranked candidate lists.
 */
export function multiArmReciprocalRankFusion(
  arms: ReadonlyArray<{
    readonly ids: ReadonlyArray<string>;
    readonly weight?: number;
  }>,
  k: number = DEFAULT_RRF_K,
  topNCandidates: number = DEFAULT_RRF_TOP_N,
): Array<[string, number]> {
  const scores = new Map<string, number>();
  for (const arm of arms) {
    const weight = arm.weight ?? 1.0;
    if (weight <= 0 || arm.ids.length === 0) continue;
    arm.ids.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + weight * (1 / (k + rank + 1)));
    });
  }
  return [...scores.entries()]
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, topNCandidates);
}
const SEMANTIC_SQLITE_DIR = ["semantic-rag", "v4"] as const;
const SEMANTIC_SQLITE_FILENAME = "vectors.sqlite";
const SEMANTIC_POOL_V5_DIR = ["semantic-rag", "v5"] as const;
const BINARY_PREFILTER_MIN_ITEMS = 16;
const NATIVE_VECTOR_POOL_MIN_VECTORS = 512;

export function semanticVectorStorePath(stateDir: string): string {
  return NodePath.join(stateDir, ...SEMANTIC_SQLITE_DIR, SEMANTIC_SQLITE_FILENAME);
}

function openVectorStoreDb(
  stateDir: string,
  options: { readonly createIfMissing: boolean },
): NodeSqlite.DatabaseSync | undefined {
  const dbPath = semanticVectorStorePath(stateDir);
  if (!options.createIfMissing && !NodeFS.existsSync(dbPath)) {
    return undefined;
  }
  if (options.createIfMissing) {
    NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
  }
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA journal_size_limit = 33554432;
    PRAGMA mmap_size = 134217728;
    CREATE TABLE IF NOT EXISTS semantic_vectors (
      scope_key TEXT NOT NULL,
      content_key TEXT NOT NULL,
      dim INTEGER NOT NULL,
      bin BLOB NOT NULL,
      f32 BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_key, content_key)
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_vectors_scope_updated
      ON semantic_vectors (scope_key, updated_at);
  `);
  return db;
}

function withVectorStoreDb<T>(
  stateDir: string,
  options: { readonly createIfMissing: boolean },
  fn: (db: NodeSqlite.DatabaseSync) => T,
): T | undefined {
  const db = openVectorStoreDb(stateDir, options);
  if (!db) return undefined;
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Builds or updates the Windows-safe generation-versioned Rust `mmap` vector pool
 * (`semantic-rag/v5/pool-<scope16>-gen<N>.t3vec`) from the SQLite SSOT (`v4/vectors.sqlite`).
 * Safe no-op when `native/t3-memory-core` is disabled/unavailable or scope has `< 512` vectors.
 */
export function syncNativeVectorPoolForScope(
  stateDir: string,
  scopeKey: string,
  minVectors = NATIVE_VECTOR_POOL_MIN_VECTORS,
): { readonly synced: boolean; readonly vectorCount: number; readonly filePath: string | null } {
  const addon = getNativeMemoryCore();
  if (!addon) {
    return { synced: false, vectorCount: 0, filePath: null };
  }
  const poolDir = NodePath.join(stateDir, ...SEMANTIC_POOL_V5_DIR);
  const shortScope = scopeKey.slice(0, 16);
  const pointerPath = NodePath.join(poolDir, `pool-${shortScope}.current.json`);

  const built = withVectorStoreDb(stateDir, { createIfMissing: false }, (db) => {
    const meta = db
      .prepare(
        `SELECT COUNT(*) AS cnt, MAX(updated_at) AS max_updated, MAX(dim) AS dim
         FROM semantic_vectors WHERE scope_key = ?`,
      )
      .get(scopeKey) as { cnt: number; max_updated: number | null; dim: number | null } | undefined;
    const count = Number(meta?.cnt ?? 0);
    const dim = Number(meta?.dim ?? 0);
    const maxUpdated = Number(meta?.max_updated ?? 0);
    if (count < minVectors || dim <= 0) {
      return { synced: false, vectorCount: count, filePath: null };
    }

    let prevGen = 0;
    if (NodeFS.existsSync(pointerPath)) {
      try {
        const ptr = JSON.parse(NodeFS.readFileSync(pointerPath, "utf8")) as {
          generation?: number;
          sourceMaxUpdatedAt?: number;
          vectorCount?: number;
          filePath?: string;
        };
        prevGen = Number(ptr.generation ?? 0);
        if (
          ptr.sourceMaxUpdatedAt === maxUpdated &&
          ptr.vectorCount === count &&
          ptr.filePath &&
          NodeFS.existsSync(ptr.filePath)
        ) {
          runNativeSafe((a) => a.openVectorPool(scopeKey, ptr.filePath!));
          return { synced: true, vectorCount: count, filePath: ptr.filePath };
        }
      } catch {
        // Rebuild on corrupt pointer.
      }
    }

    const rows = db
      .prepare(
        `SELECT content_key, dim, f32 FROM semantic_vectors
         WHERE scope_key = ? AND dim = ? ORDER BY content_key ASC`,
      )
      .all(scopeKey, dim) as Array<{ content_key: string; dim: number; f32: Uint8Array }>;
    if (rows.length < minVectors) {
      return { synced: false, vectorCount: rows.length, filePath: null };
    }

    const keys: string[] = new Array(rows.length);
    const f32Matrix = new Float32Array(rows.length * dim);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      keys[i] = row.content_key;
      const vec = deserializeStoredVector(row.f32, dim);
      const base = i * dim;
      for (let d = 0; d < dim; d += 1) {
        f32Matrix[base + d] = vec[d] ?? 0;
      }
    }

    const nextGen = prevGen + 1;
    const nextFile = NodePath.join(poolDir, `pool-${shortScope}-gen${nextGen}.t3vec`);
    const ok = runNativeSafe((a) => {
      a.writeVectorPool(nextFile, dim, keys, f32Matrix, nextGen, maxUpdated);
      a.openVectorPool(scopeKey, nextFile);
      return true;
    });
    if (!ok) {
      return { synced: false, vectorCount: rows.length, filePath: null };
    }
    NodeFS.mkdirSync(poolDir, { recursive: true });
    NodeFS.writeFileSync(
      pointerPath,
      JSON.stringify({
        scopeKey,
        generation: nextGen,
        sourceMaxUpdatedAt: maxUpdated,
        vectorCount: rows.length,
        dim,
        filePath: nextFile,
      }),
    );
    return { synced: true, vectorCount: rows.length, filePath: nextFile };
  });

  return built ?? { synced: false, vectorCount: 0, filePath: null };
}

interface StoredVectorRecord {
  readonly bin: Uint8Array;
  readonly vector: ArrayLike<number>;
}

/**
 * One vector page and 100 results stay resident; document embedding is an explicit background step.
 * Vectors persist in a unified SQLite binary+Float32 store (`semantic-rag/v4/vectors.sqlite`)
 * with transparent on-demand promotion of legacy `v3/*.json` files and 2-stage Hamming → Cosine ranking.
 */
export function makeSemanticSearch(dependencies: {
  readonly now: () => number;
  readonly embed: (input: SemanticEmbeddingInput) => Promise<readonly (readonly number[])[]>;
  readonly storageMode?: "sqlite" | "legacy-json";
}) {
  const storageMode = dependencies.storageMode ?? "sqlite";
  const queryVectors = new Map<string, readonly number[]>();
  let queryBytes = 0;
  const legacyFile = (scope: SemanticScope, contentKey: string) =>
    NodePath.join(
      scope.stateDir,
      "semantic-rag",
      "v3",
      semanticScopeKey(scope),
      contentKey.slice(0, 2),
      `${contentKey}.json`,
    );
  const readLegacyJson = async (scope: SemanticScope, key: string) => {
    // Fast negative check: skip NTFS stat storms once `v3/` has been migrated or doesn't exist.
    const v3Root = NodePath.join(scope.stateDir, "semantic-rag", "v3");
    if (!NodeFS.existsSync(v3Root)) return undefined;
    try {
      const path = legacyFile(scope, key);
      if ((await NodeFSP.stat(path)).size > 256 * 1024) return undefined;
      return decodeVector(await NodeFSP.readFile(path, "utf8"));
    } catch {
      return undefined;
    }
  };
  const readBatch = async (
    stateDir: string,
    requests: ReadonlyArray<{
      readonly scope: SemanticScope;
      readonly scopeKey: string;
      readonly key: string;
    }>,
    sharedDb?: NodeSqlite.DatabaseSync | undefined,
  ): Promise<Map<string, StoredVectorRecord>> => {
    const found = new Map<string, StoredVectorRecord>();
    if (requests.length === 0) return found;
    const compositeKey = (scopeKey: string, key: string) => `${scopeKey}:${key}`;

    if (storageMode === "sqlite") {
      const byScope = new Map<string, string[]>();
      for (const req of requests) {
        let list = byScope.get(req.scopeKey);
        if (!list) {
          list = [];
          byScope.set(req.scopeKey, list);
        }
        list.push(req.key);
      }
      const runSelect = (db: NodeSqlite.DatabaseSync) => {
        for (const [scopeKey, keys] of byScope) {
          const uniqueKeys = [...new Set(keys)];
          const placeholders = uniqueKeys.map(() => "?").join(",");
          const rows = db
            .prepare(
              `SELECT content_key, dim, bin, f32 FROM semantic_vectors
               WHERE scope_key = ? AND content_key IN (${placeholders})`,
            )
            .all(scopeKey, ...uniqueKeys) as Array<{
            content_key: string;
            dim: number;
            bin: Uint8Array;
            f32: Uint8Array;
          }>;
          for (const row of rows) {
            found.set(compositeKey(scopeKey, row.content_key), {
              bin: new Uint8Array(row.bin),
              vector: deserializeStoredVector(row.f32, Number(row.dim)),
            });
          }
        }
      };
      if (sharedDb) {
        runSelect(sharedDb);
      } else {
        withVectorStoreDb(stateDir, { createIfMissing: false }, runSelect);
      }
    }

    // Transparently read legacy `v3/*.json` vectors on miss and promote into SQLite.
    const toPromote: Array<{
      readonly scopeKey: string;
      readonly key: string;
      readonly vector: readonly number[];
    }> = [];
    for (const req of requests) {
      const id = compositeKey(req.scopeKey, req.key);
      if (found.has(id)) continue;
      const legacy = await readLegacyJson(req.scope, req.key);
      if (!legacy) continue;
      const bin = quantizeBinaryVector(legacy);
      found.set(id, { bin, vector: legacy });
      if (storageMode === "sqlite") {
        toPromote.push({ scopeKey: req.scopeKey, key: req.key, vector: legacy });
      }
    }

    if (storageMode === "sqlite" && toPromote.length > 0) {
      const updatedAt = dependencies.now();
      withVectorStoreDb(stateDir, { createIfMissing: true }, (db) => {
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO semantic_vectors (scope_key, content_key, dim, bin, f32, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        db.exec("BEGIN");
        try {
          for (const item of toPromote) {
            const vecBuf = serializeFloat64Vector(item.vector);
            const binBuf = NodeBuffer.Buffer.from(quantizeBinaryVector(item.vector));
            stmt.run(item.scopeKey, item.key, item.vector.length, binBuf, vecBuf, updatedAt);
          }
          db.exec("COMMIT");
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      });
    }

    return found;
  };

  const writeBatch = async (
    scope: SemanticScope,
    items: ReadonlyArray<{ readonly key: string; readonly vector: readonly number[] }>,
    signal: AbortSignal,
  ): Promise<number> => {
    if (items.length === 0) return 0;
    signal.throwIfAborted();
    if (storageMode === "sqlite") {
      const scopeKey = semanticScopeKey(scope);
      const updatedAt = dependencies.now();
      withVectorStoreDb(scope.stateDir, { createIfMissing: true }, (db) => {
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO semantic_vectors (scope_key, content_key, dim, bin, f32, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        db.exec("BEGIN");
        try {
          for (const item of items) {
            const vecBuf = serializeFloat64Vector(item.vector);
            const binBuf = NodeBuffer.Buffer.from(quantizeBinaryVector(item.vector));
            stmt.run(scopeKey, item.key, item.vector.length, binBuf, vecBuf, updatedAt);
          }
          db.exec("COMMIT");
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      });
      return items.length;
    }

    let written = 0;
    for (const item of items) {
      const path = legacyFile(scope, item.key);
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        await NodeFSP.writeFile(temporary, encodeVector(item.vector));
        signal.throwIfAborted();
        await NodeFSP.rename(temporary, path);
        written++;
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    }
    return written;
  };

  const embed = async (
    scope: SemanticScope,
    texts: readonly string[],
    signal: AbortSignal,
    purpose: SemanticEmbeddingInput["purpose"],
  ) => {
    semanticScopeKey(scope);
    if (
      texts.length > 2 ||
      texts.some((text) => NodeBuffer.Buffer.byteLength(text) > EMBEDDING_INPUT_BYTES) ||
      texts.reduce((size, text) => size + NodeBuffer.Buffer.byteLength(text), 0) >
        EMBEDDING_BATCH_BYTES
    )
      throw new Error("임베딩 입력 예산을 초과했습니다.");
    signal.throwIfAborted();
    const normalizedEndpoint = normalizeSemanticEndpoint(scope.endpoint);
    const vectors = await dependencies.embed({
      endpoint: normalizedEndpoint,
      model: scope.model,
      texts,
      purpose,
      signal,
    });
    if (vectors.length !== texts.length) throw new Error("임베딩 수가 입력과 다릅니다.");
    return decodeVectors(vectors);
  };
  const index = async (
    input: SemanticScope & { candidates: readonly SemanticCandidate[]; signal: AbortSignal },
  ) => {
    const scopeKey = semanticScopeKey(input);
    if (input.candidates.length > 64) throw new Error("의미 색인 페이지는 64개 이하여야 합니다.");
    const entries = input.candidates
      .map((candidate) => ({
        candidate,
        text: semanticContentText(candidate),
        key: semanticContentKey(candidate),
      }))
      .sort((left, right) => left.text.length - right.text.length);
    const unique = [...new Map(entries.map((entry) => [entry.key, entry])).values()];
    const existing = await readBatch(
      input.stateDir,
      unique.map((entry) => ({ scope: input, scopeKey, key: entry.key })),
    );
    let written = 0;
    for (let offset = 0; offset < unique.length; offset += 2) {
      input.signal.throwIfAborted();
      const batch = unique.slice(offset, offset + 2);
      const missing = batch.filter((entry) => !existing.has(`${scopeKey}:${entry.key}`));
      if (!missing.length) continue;
      const vectors = await embed(
        input,
        missing.map((entry) => entry.text),
        input.signal,
        "index",
      );
      written += await writeBatch(
        input,
        missing.map((entry, n) => ({ key: entry.key, vector: vectors[n]! })),
        input.signal,
      );
    }
    return {
      written,
      references: entries.map(({ candidate, key }) => ({ id: candidate.id, key })),
    };
  };
  const search = async <A extends SemanticCandidate>(
    input: SemanticScope & {
      readonly query: string;
      readonly candidates?: readonly A[];
      readonly candidatePages?: (signal: AbortSignal) => AsyncIterable<readonly A[]>;
      readonly missing?: (projects: readonly string[]) => Promise<void>;
      readonly maxChunksPerItem?: number;
      readonly queryEmbedTimeoutMs?: number;
      readonly signal: AbortSignal;
    },
  ) => {
    const scopeKey = semanticScopeKey(input);
    const defaultQueryTimeoutMs =
      parseProviderEmbeddingInstanceId(input.endpoint) !== null
        ? 3500
        : SEMANTIC_QUERY_EMBED_TIMEOUT_MS;
    const queryEmbedTimeoutMs = input.queryEmbedTimeoutMs ?? defaultQueryTimeoutMs;
    let queryEmbedTimedOut = false;
    const query = boundedEmbeddingText(
      `task: search result | query: ${boundedEmbeddingText(input.query, EMBEDDING_INPUT_BYTES - 40)}`,
    );
    const queryKey = hash(`${scopeKey}:${query}`);
    let queryVector = queryVectors.get(queryKey);
    if (queryVector) {
      queryVectors.delete(queryKey);
      queryVectors.set(queryKey, queryVector);
    }
    let queryBin: Uint8Array | undefined = queryVector
      ? quantizeBinaryVector(queryVector)
      : undefined;
    let total = 0,
      indexed = 0;
    const best: { candidate: A; similarity: number }[] = [];
    const arrayPages = async function* () {
      const rows = input.candidates ?? [];
      for (let offset = 0; offset < rows.length; offset += 64)
        yield rows.slice(offset, offset + 64);
    };
    let interrupted = false;
    const pages = input.candidatePages ? input.candidatePages(input.signal) : arrayPages();
    // Phase 1 optimization: keep ONE SQLite handle open for the entire search pass
    // (eliminates 592x open/close + PRAGMA storms on large scopes) and close cleanly in `finally`.
    const sharedSearchDb =
      storageMode === "sqlite"
        ? openVectorStoreDb(input.stateDir, { createIfMissing: false })
        : undefined;
    try {
      for await (const supplied of pages) {
        for (let offset = 0; offset < supplied.length; offset += 64) {
          input.signal.throwIfAborted();
          const page = supplied.slice(offset, offset + 64);
          if (!page.length) continue;
          const pageRequests = page.map((candidate) => {
            const candidateScope: SemanticScope = {
              ...input,
              projectId: candidate.projectId ?? input.projectId,
            };
            return {
              candidate,
              scope: candidateScope,
              scopeKey:
                candidateScope.projectId === input.projectId
                  ? scopeKey
                  : semanticScopeKey(candidateScope),
              key: semanticContentKey(candidate),
            };
          });
          const batchMap = await readBatch(input.stateDir, pageRequests, sharedSearchDb);
          const records = pageRequests.map((req) => batchMap.get(`${req.scopeKey}:${req.key}`));
          const missingProjects = new Set<string>();
          for (let n = 0; n < page.length; n++)
            if (!records[n]) missingProjects.add(page[n]!.projectId ?? input.projectId);
          if (missingProjects.size) await input.missing?.([...missingProjects]);
          if (!queryVector && !queryEmbedTimedOut && records.some(Boolean)) {
            const timeoutSignal =
              queryEmbedTimeoutMs > 0
                ? AbortSignal.any([input.signal, AbortSignal.timeout(queryEmbedTimeoutMs)])
                : input.signal;
            try {
              queryVector = (await embed(input, [query], timeoutSignal, "query"))[0]!;
              queryBin = quantizeBinaryVector(queryVector);
            } catch (embedError) {
              if (input.signal.aborted) throw embedError;
              // Local embedding server stalled or offline (>400ms): degrade gracefully
              // so callers immediately use FTS5 BM25 + entity ranking with zero stall.
              queryEmbedTimedOut = true;
              continue;
            }
            const bytes = 128 + queryVector.length * 8;
            const replaced = queryVectors.get(queryKey);
            if (replaced) {
              queryBytes -= 128 + replaced.length * 8;
              queryVectors.delete(queryKey);
            }
            while (
              queryVectors.size &&
              (queryVectors.size >= 128 || queryBytes + bytes > 1024 * 1024)
            ) {
              const oldest = queryVectors.keys().next().value!;
              queryBytes -= 128 + queryVectors.get(oldest)!.length * 8;
              queryVectors.delete(oldest);
            }
            queryVectors.set(queryKey, queryVector);
            queryBytes += bytes;
          }
          total += page.length;
          if (queryVector && queryBin) {
            const available: Array<{
              readonly candidate: A;
              readonly record: StoredVectorRecord;
            }> = [];
            for (let n = 0; n < page.length; n++) {
              const rec = records[n];
              if (!rec) continue;
              indexed++;
              available.push({ candidate: page[n]!, record: rec });
            }
            // Stage 1: Diversity-preserving 1-bit Binary Quantization Hamming oversampling
            const maxPerItem = input.maxChunksPerItem ?? 1;
            const rerankPool =
              available.length > BINARY_PREFILTER_MIN_ITEMS
                ? (() => {
                    const sorted = available
                      .map((item) => ({
                        ...item,
                        hamming: hammingDistanceBinary(queryBin!, item.record.bin),
                      }))
                      .sort(
                        (left, right) =>
                          left.hamming - right.hamming ||
                          left.candidate.id.localeCompare(right.candidate.id),
                      );
                    const budget = Math.max(
                      BINARY_PREFILTER_MIN_ITEMS,
                      Math.ceil(available.length * 0.6),
                    );
                    const perSource = new Map<string, number>();
                    const picked: typeof sorted = [];
                    for (const item of sorted) {
                      const sourceKey = JSON.stringify([
                        item.candidate.projectId ?? input.projectId,
                        item.candidate.itemId ?? item.candidate.id,
                      ]);
                      const count = perSource.get(sourceKey) ?? 0;
                      if (count >= maxPerItem) continue;
                      perSource.set(sourceKey, count + 1);
                      picked.push(item);
                      if (picked.length >= budget) break;
                    }
                    return picked;
                  })()
                : available;
            // Stage 2: Exact cosine similarity reranking (use Rust AVX2 batch when pool >= 32 and dim >= 64)
            const qDim = queryVector.length;
            const useNativeBatch =
              rerankPool.length >= 32 && qDim >= 64 && getNativeMemoryCore() !== null;
            let nativeScored = false;
            if (useNativeBatch) {
              const flat = new Float32Array(rerankPool.length * qDim);
              let dimsMatch = true;
              for (let rIdx = 0; rIdx < rerankPool.length; rIdx += 1) {
                const vec = rerankPool[rIdx]!.record.vector;
                if (vec.length !== qDim) {
                  dimsMatch = false;
                  break;
                }
                const base = rIdx * qDim;
                for (let d = 0; d < qDim; d += 1) {
                  flat[base + d] = vec[d]!;
                }
              }
              if (dimsMatch) {
                const qF32 = new Float32Array(queryVector);
                const hits = runNativeSafe((a) =>
                  a.normalizedCosineTopKF32(flat, qDim, qF32, rerankPool.length),
                );
                if (hits) {
                  for (const hit of hits) {
                    const item = rerankPool[hit.index];
                    if (item) {
                      best.push({ candidate: item.candidate, similarity: hit.score });
                    }
                  }
                  nativeScored = true;
                }
              }
            }
            if (!nativeScored) {
              for (const item of rerankPool) {
                best.push({
                  candidate: item.candidate,
                  similarity: cosineSimilarity(queryVector, item.record.vector),
                });
              }
            }
          }
          best.sort(
            (left, right) =>
              right.similarity - left.similarity ||
              left.candidate.id.localeCompare(right.candidate.id),
          );
          const perSource = new Map<string, number>();
          const retained = best
            .filter(({ candidate }) => {
              const key = JSON.stringify([
                candidate.projectId ?? input.projectId,
                candidate.itemId ?? candidate.id,
              ]);
              const count = perSource.get(key) ?? 0;
              if (count >= (input.maxChunksPerItem ?? 1)) return false;
              perSource.set(key, count + 1);
              return true;
            })
            .slice(0, 100);
          best.splice(0, best.length, ...retained);
        }
      }
    } catch (error) {
      if (!input.signal.aborted) throw error;
      interrupted = true;
    } finally {
      if (sharedSearchDb) {
        try {
          sharedSearchDb.close();
        } catch {
          // Ignore close errors.
        }
      }
    }
    return {
      ranked: best.map(({ candidate, similarity }) => ({ id: candidate.id, similarity })),
      candidates: best.map(({ candidate }) => candidate),
      indexed,
      total,
      interrupted,
    };
  };
  return Object.assign(search, {
    index,
    cacheStats: () => ({ entries: queryVectors.size, bytes: queryBytes }),
    clear: () => {
      queryVectors.clear();
      queryBytes = 0;
      runNativeSafe((a) => a.closeAllVectorPools());
    },
  });
}
/** Only old, unreferenced derived files/rows in one validated scope are eligible for reclamation. */
export async function cleanupSemanticVectors(
  input: SemanticScope & {
    readonly olderThan: number;
    readonly apply: boolean;
    readonly referenced: (contentKey: string) => Promise<boolean>;
    readonly signal: AbortSignal;
  },
) {
  const scopeKey = semanticScopeKey(input);
  const root = NodePath.join(input.stateDir, "semantic-rag", "v3", scopeKey);
  const result = {
    scanned: 0,
    eligibleFiles: 0,
    eligibleBytes: 0,
    removedFiles: 0,
    removedBytes: 0,
  };

  // 1. Reclaim legacy `v3/*.json` files
  let directories;
  try {
    directories = await NodeFSP.opendir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (directories) {
    for await (const prefix of directories) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue;
      for await (const entry of await NodeFSP.opendir(NodePath.join(root, prefix.name))) {
        input.signal.throwIfAborted();
        const match = /^([a-f0-9]{64})\.json(?:\.[a-f0-9-]{36}\.tmp)?$/u.exec(entry.name);
        if (!entry.isFile() || !match || !match[1]!.startsWith(prefix.name)) continue;
        result.scanned++;
        const path = NodePath.join(root, prefix.name, entry.name);
        const stat = await NodeFSP.stat(path);
        if (stat.mtimeMs >= input.olderThan || (await input.referenced(match[1]!))) continue;
        result.eligibleFiles++;
        result.eligibleBytes += stat.size;
        if (input.apply) {
          await NodeFSP.unlink(path);
          result.removedFiles++;
          result.removedBytes += stat.size;
        }
      }
    }
  }

  // 2. Reclaim old unreferenced rows in unified SQLite `v4/vectors.sqlite`
  const sqliteCandidates =
    withVectorStoreDb(
      input.stateDir,
      { createIfMissing: false },
      (db) =>
        db
          .prepare(
            `SELECT content_key, updated_at, length(bin) + length(f32) AS payload_bytes
           FROM semantic_vectors WHERE scope_key = ?`,
          )
          .all(scopeKey) as Array<{
          content_key: string;
          updated_at: number;
          payload_bytes: number;
        }>,
    ) ?? [];
  const toDelete: string[] = [];
  for (const row of sqliteCandidates) {
    input.signal.throwIfAborted();
    result.scanned++;
    if (row.updated_at >= input.olderThan || (await input.referenced(row.content_key))) continue;
    const approxBytes = Number(row.payload_bytes) || 0;
    result.eligibleFiles++;
    result.eligibleBytes += approxBytes;
    if (input.apply) {
      toDelete.push(row.content_key);
      result.removedFiles++;
      result.removedBytes += approxBytes;
    }
  }
  if (input.apply && toDelete.length > 0) {
    withVectorStoreDb(input.stateDir, { createIfMissing: false }, (db) => {
      const del = db.prepare(
        "DELETE FROM semantic_vectors WHERE scope_key = ? AND content_key = ?",
      );
      db.exec("BEGIN");
      try {
        for (const contentKey of toDelete) {
          del.run(scopeKey, contentKey);
        }
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    });
  }

  return result;
}
