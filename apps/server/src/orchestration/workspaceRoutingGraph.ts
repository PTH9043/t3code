// @effect-diagnostics globalDate:off globalDateInEffect:off preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { applyMonorepoPathAliases } from "./contextAssemblyGate.ts";
import {
  buildKoreanBigramFtsMatchExpr,
  buildKoreanBigramIndexFields,
  expandKoreanTermVariants,
  hasStrippableKoreanParticle,
  normalizeKoreanKeywordToken,
} from "./koreanTextNormalization.ts";
import { compressRagText } from "./ragContextCompression.ts";

export const ROUTING_NODE_KIND = {
  PHRASE: 1,
  SYMBOL: 2,
  FILE: 3,
  MASTER_REPORT: 4,
  MEMORY_FACT: 5,
} as const;

export type RoutingNodeKind = (typeof ROUTING_NODE_KIND)[keyof typeof ROUTING_NODE_KIND];

export const ROUTING_EDGE_TYPE = {
  CONTAINS: 1,
  SYNONYM: 2,
  SUPERSEDES: 3,
  CAUSED_BY: 4,
  TOUCHES_FILE: 5,
  VERIFIED_BY: 6,
  DEPENDS_ON: 7,
} as const;

export type RoutingEdgeType = (typeof ROUTING_EDGE_TYPE)[keyof typeof ROUTING_EDGE_TYPE];

export type RoutingEpistemicState = "fact" | "verified_inference" | "hypothesis";

export interface RoutingNodeUpsertInput {
  readonly projectId: string;
  readonly nodeKind: RoutingNodeKind;
  readonly canonicalKey: string;
  readonly title: string;
  readonly summaryMoc: string;
  readonly bodyMarkdown?: string | undefined;
  readonly bodyRefKind?: string | null | undefined;
  readonly bodyRefId?: string | null | undefined;
  readonly epistemicState?: RoutingEpistemicState | undefined;
  readonly staleStatus?: 0 | 1 | 2 | undefined;
  readonly filePath?: string | null | undefined;
  readonly startLine?: number | null | undefined;
  readonly endLine?: number | null | undefined;
  readonly blobSha256?: string | null | undefined;
  readonly updatedAtMs?: number | undefined;
}

export interface RoutingNodeRecord {
  readonly nodeId: number;
  readonly projectId: string;
  readonly nodeKind: number;
  readonly canonicalKey: string;
  readonly title: string;
  readonly summaryMoc: string;
  readonly bodyMarkdown: string;
  readonly bodyRefKind: string | null;
  readonly bodyRefId: string | null;
  readonly epistemicState: string;
  readonly staleStatus: number;
  readonly filePath: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly blobSha256: string | null;
  readonly updatedAtMs: number;
}

export interface RoutingMocChannelSeeds {
  readonly totalDocs: number;
  readonly fileSeeds: number;
  readonly symbolSeeds: number;
  readonly keywordSeeds: number;
  readonly ftsSeeds: number;
}

export interface RoutingMocResult {
  readonly renderedMoc: string;
  readonly primaryNode: RoutingNodeRecord | null;
  readonly pointerNodes: ReadonlyArray<RoutingNodeRecord>;
  readonly seedCount: number;
  readonly elapsedMs: number;
  readonly channelSeeds?: RoutingMocChannelSeeds;
}

export function routingNodeKindLabel(nodeKind: number | null | undefined): string {
  switch (nodeKind) {
    case ROUTING_NODE_KIND.PHRASE:
      return "phrase";
    case ROUTING_NODE_KIND.SYMBOL:
      return "symbol";
    case ROUTING_NODE_KIND.FILE:
      return "file";
    case ROUTING_NODE_KIND.MASTER_REPORT:
      return "master_report";
    case ROUTING_NODE_KIND.MEMORY_FACT:
      return "memory_fact";
    default:
      return "none";
  }
}

const FILE_PATH_EXTRACT_PATTERN =
  /(?:apps|packages|docs|scripts|\.agents|\.claude)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/gu;
const BACKTICK_SYMBOL_PATTERN = /`([A-Za-z_][A-Za-z0-9_.-]{2,64})`/gu;
const WIKI_LINK_PATTERN = /\[\[([^\]|]{2,64})(?:\|[^\]]+)?\]\]/gu;
const KEYWORD_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "into",
  "when",
  "then",
  "else",
  "true",
  "false",
  "null",
  "undefined",
  "const",
  "return",
  "function",
  "import",
  "export",
  "그리고",
  "하지만",
  "그러나",
  "때문",
  "위해",
  "대한",
  "관련",
  "기준",
  "현재",
  "이전",
  "사용자",
  "모델",
  "작업",
  "파일",
  "확인",
  "진행",
  "완료",
  "실행",
  "변경",
  "수정",
  "결과",
  "내용",
  "경우",
  "부분",
  "방식",
  "문제",
  "오류",
  "상태",
  "전체",
  "기본",
]);

export function extractKeywordPhrases(
  title: string,
  text: string,
  explicitKeywords?: ReadonlyArray<string>,
): string[] {
  const found = new Set<string>();
  const addNormalized = (raw: string) => {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length < 2 || trimmed.length > 48) return;
    const norm = normalizeKoreanKeywordToken(trimmed);
    const chosen = norm.length >= 2 ? norm : trimmed;
    if (!KEYWORD_STOPWORDS.has(chosen)) {
      found.add(chosen);
    }
  };
  for (const kw of explicitKeywords ?? []) {
    addNormalized(kw);
  }
  for (const match of text.matchAll(WIKI_LINK_PATTERN)) {
    addNormalized(match[1]!);
  }
  // Extract salient Hangul/ASCII terms from title + opening summary, normalized
  // so particle variants ("토큰을"/"토큰은"/"토큰의") unify onto one canonical `kw:*` hub.
  const source = `${title} ${text.slice(0, 600)}`;
  const tokens = source
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .map((t) => normalizeKoreanKeywordToken(t.trim().toLowerCase()))
    .filter(
      (t) => t.length >= 2 && t.length <= 36 && !/^\d+$/.test(t) && !KEYWORD_STOPWORDS.has(t),
    );
  const freq = new Map<string, number>();
  for (const tok of tokens) {
    freq.set(tok, (freq.get(tok) ?? 0) + 1);
  }
  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([tok]) => tok);
  for (const tok of ranked) {
    if (found.size >= 8) break;
    found.add(tok);
  }
  return [...found].slice(0, 8);
}

function compactMocLine(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > maxChars ? `${single.slice(0, maxChars - 1)}…` : single;
}

export function extractReferencedFilePaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FILE_PATH_EXTRACT_PATTERN)) {
    const cleaned = match[0].replace(/[),.;:]+$/u, "");
    if (cleaned.length >= 6 && cleaned.length <= 200) found.add(cleaned);
  }
  return [...found].slice(0, 12);
}

export function extractReferencedSymbols(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(BACKTICK_SYMBOL_PATTERN)) {
    const sym = match[1]!;
    if (sym.includes("/") || sym.length < 3) continue;
    found.add(sym);
  }
  return [...found].slice(0, 12);
}

function tokenizeQueryTerms(query: string): string[] {
  const raw = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.-]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 64);
  // Wave 4-A2: Emit both normalized Korean stem and original form so both
  // newly normalized `kw:*` hubs and legacy particle-bearing nodes hit cleanly.
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const term of raw) {
    for (const variant of expandKoreanTermVariants(term)) {
      if (variant.length >= 2 && !seen.has(variant)) {
        seen.add(variant);
        expanded.push(variant);
      }
    }
  }
  return expanded.slice(0, 24);
}

export const upsertRoutingNode = Effect.fn("WorkspaceRoutingGraph.upsertNode")(function* (
  sql: SqlClient.SqlClient,
  input: RoutingNodeUpsertInput,
) {
  const nowMs = input.updatedAtMs ?? Date.now();
  const summaryMoc = compactMocLine(input.summaryMoc, 240);
  const bodyMarkdown = input.bodyMarkdown ?? "";
  const epistemicState = input.epistemicState ?? "fact";
  const staleStatus = input.staleStatus ?? 0;

  yield* sql`
    INSERT INTO workspace_routing_nodes (
      project_id, node_kind, canonical_key, title, summary_moc, body_markdown,
      body_ref_kind, body_ref_id, epistemic_state, stale_status,
      file_path, start_line, end_line, blob_sha256, updated_at_ms
    ) VALUES (
      ${input.projectId}, ${input.nodeKind}, ${input.canonicalKey}, ${input.title},
      ${summaryMoc}, ${bodyMarkdown},
      ${input.bodyRefKind ?? null}, ${input.bodyRefId ?? null},
      ${epistemicState}, ${staleStatus},
      ${input.filePath ?? null}, ${input.startLine ?? null}, ${input.endLine ?? null},
      ${input.blobSha256 ?? null}, ${nowMs}
    )
    ON CONFLICT(project_id, node_kind, canonical_key) DO UPDATE SET
      title = excluded.title,
      summary_moc = excluded.summary_moc,
      body_markdown = CASE WHEN length(excluded.body_markdown) > 0 THEN excluded.body_markdown ELSE workspace_routing_nodes.body_markdown END,
      body_ref_kind = COALESCE(excluded.body_ref_kind, workspace_routing_nodes.body_ref_kind),
      body_ref_id = COALESCE(excluded.body_ref_id, workspace_routing_nodes.body_ref_id),
      epistemic_state = excluded.epistemic_state,
      stale_status = excluded.stale_status,
      file_path = COALESCE(excluded.file_path, workspace_routing_nodes.file_path),
      start_line = COALESCE(excluded.start_line, workspace_routing_nodes.start_line),
      end_line = COALESCE(excluded.end_line, workspace_routing_nodes.end_line),
      blob_sha256 = COALESCE(excluded.blob_sha256, workspace_routing_nodes.blob_sha256),
      updated_at_ms = excluded.updated_at_ms
  `;

  const [row] = yield* sql<{ node_id: number }>`
    SELECT node_id FROM workspace_routing_nodes
    WHERE project_id = ${input.projectId}
      AND node_kind = ${input.nodeKind}
      AND canonical_key = ${input.canonicalKey}
  `;
  const nodeId = row!.node_id;

  // Wave 4-A2: Keep auxiliary Korean bigram FTS5 index in sync for document nodes
  // (gracefully ignored on older test DBs that have not applied Migration 118).
  if (
    input.nodeKind === ROUTING_NODE_KIND.MASTER_REPORT ||
    input.nodeKind === ROUTING_NODE_KIND.MEMORY_FACT
  ) {
    const ko = buildKoreanBigramIndexFields({
      title: input.title,
      summaryMoc,
      bodyMarkdown,
    });
    yield* Effect.gen(function* () {
      yield* sql`DELETE FROM workspace_routing_fts_ko WHERE rowid = ${nodeId}`;
      yield* sql`
        INSERT INTO workspace_routing_fts_ko (rowid, title_ko, body_ko)
        VALUES (${nodeId}, ${ko.titleKo}, ${ko.bodyKo})
      `;
    }).pipe(Effect.orElseSucceed(() => undefined));
  }

  return nodeId;
});

export const upsertRoutingEdge = Effect.fn("WorkspaceRoutingGraph.upsertEdge")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly projectId: string;
    readonly srcId: number;
    readonly edgeType: RoutingEdgeType;
    readonly dstId: number;
    readonly weight?: number | undefined;
    readonly validFromMs?: number | null | undefined;
    readonly validToMs?: number | null | undefined;
  },
) {
  if (input.srcId === input.dstId) return;
  const weight = input.weight ?? 1.0;
  const validFrom = input.validFromMs ?? Date.now();
  const validTo = input.validToMs ?? null;

  yield* sql`
    INSERT INTO workspace_routing_edges (
      project_id, src_id, edge_type, dst_id, weight, valid_from_ms, valid_to_ms
    ) VALUES (
      ${input.projectId}, ${input.srcId}, ${input.edgeType}, ${input.dstId},
      ${weight}, ${validFrom}, ${validTo}
    )
    ON CONFLICT(project_id, src_id, edge_type, dst_id) DO UPDATE SET
      weight = MAX(workspace_routing_edges.weight, excluded.weight),
      valid_to_ms = excluded.valid_to_ms
  `;
  yield* sql`
    INSERT INTO workspace_routing_edges_rev (
      project_id, dst_id, edge_type, src_id, weight, valid_from_ms, valid_to_ms
    ) VALUES (
      ${input.projectId}, ${input.dstId}, ${input.edgeType}, ${input.srcId},
      ${weight}, ${validFrom}, ${validTo}
    )
    ON CONFLICT(project_id, dst_id, edge_type, src_id) DO UPDATE SET
      weight = MAX(workspace_routing_edges_rev.weight, excluded.weight),
      valid_to_ms = excluded.valid_to_ms
  `;
});

/**
 * Deterministic zero-LLM ingestion of a knowledge note or memory fact into the
 * disk-resident routing graph: automatically creates file (`node_kind=3`) and
 * symbol (`node_kind=2`) nodes plus `touches_file` / `contains` backlinks.
 */
export const indexTextArtifactIntoRoutingGraph = Effect.fn(
  "WorkspaceRoutingGraph.indexTextArtifact",
)(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly projectId: string;
    readonly nodeKind:
      | typeof ROUTING_NODE_KIND.MASTER_REPORT
      | typeof ROUTING_NODE_KIND.MEMORY_FACT;
    readonly canonicalKey: string;
    readonly title: string;
    readonly summaryMoc: string;
    readonly bodyMarkdown: string;
    readonly bodyRefKind?: string | undefined;
    readonly bodyRefId?: string | undefined;
    readonly epistemicState?: RoutingEpistemicState | undefined;
    readonly keywords?: ReadonlyArray<string> | undefined;
    readonly updatedAtMs?: number | undefined;
  },
) {
  const combinedText = `${input.title}\n${input.summaryMoc}\n${input.bodyMarkdown}`;
  const files = extractReferencedFilePaths(combinedText);
  const symbols = extractReferencedSymbols(combinedText);
  const keywords = extractKeywordPhrases(input.title, combinedText, input.keywords);

  // When an external canonical source exists (knowledge / rag_source / memory_v2),
  // store ONLY a compressed index snippet (~480 chars) on disk instead of duplicating
  // multi-KB raw text — keeping SQLite FTS5 & disk footprint ultra-lean while letting
  // agents follow pointers (`body_ref_id`) on demand.
  const storedBodyMarkdown =
    input.bodyRefId && input.bodyRefKind !== "compiled_report"
      ? compressRagText(input.bodyMarkdown, { maxChars: 480 })
      : compressRagText(input.bodyMarkdown, { maxChars: 2_400 });

  const mainNodeId = yield* upsertRoutingNode(sql, {
    projectId: input.projectId,
    nodeKind: input.nodeKind,
    canonicalKey: input.canonicalKey,
    title: input.title,
    summaryMoc: compressRagText(input.summaryMoc, { maxChars: 240 }),
    bodyMarkdown: storedBodyMarkdown,
    bodyRefKind: input.bodyRefKind ?? null,
    bodyRefId: input.bodyRefId ?? null,
    epistemicState: input.epistemicState ?? "fact",
    filePath: files[0] ?? null,
    updatedAtMs: input.updatedAtMs,
  });

  let edgesCreated = 0;
  for (const filePath of files) {
    const fileNodeId = yield* upsertRoutingNode(sql, {
      projectId: input.projectId,
      nodeKind: ROUTING_NODE_KIND.FILE,
      canonicalKey: `file:${filePath}`,
      title: filePath,
      summaryMoc: `Source file ${filePath}`,
      filePath,
      epistemicState: "fact",
      updatedAtMs: input.updatedAtMs,
    });
    yield* upsertRoutingEdge(sql, {
      projectId: input.projectId,
      srcId: mainNodeId,
      edgeType: ROUTING_EDGE_TYPE.TOUCHES_FILE,
      dstId: fileNodeId,
      weight: 1.0,
    });
    edgesCreated += 1;
  }

  for (const sym of symbols) {
    const symNodeId = yield* upsertRoutingNode(sql, {
      projectId: input.projectId,
      nodeKind: ROUTING_NODE_KIND.SYMBOL,
      canonicalKey: `sym:${sym}`,
      title: sym,
      summaryMoc: `Symbol ${sym}`,
      epistemicState: "fact",
      updatedAtMs: input.updatedAtMs,
    });
    yield* upsertRoutingEdge(sql, {
      projectId: input.projectId,
      srcId: mainNodeId,
      edgeType: ROUTING_EDGE_TYPE.CONTAINS,
      dstId: symNodeId,
      weight: 0.85,
    });
    edgesCreated += 1;
  }

  for (const kw of keywords) {
    const kwNodeId = yield* upsertRoutingNode(sql, {
      projectId: input.projectId,
      nodeKind: ROUTING_NODE_KIND.PHRASE,
      canonicalKey: `kw:${kw}`,
      title: kw,
      summaryMoc: `Keyword ${kw}`,
      epistemicState: "fact",
      updatedAtMs: input.updatedAtMs,
    });
    yield* upsertRoutingEdge(sql, {
      projectId: input.projectId,
      srcId: mainNodeId,
      edgeType: ROUTING_EDGE_TYPE.CONTAINS,
      dstId: kwNodeId,
      weight: 0.75,
    });
    edgesCreated += 1;
  }

  return {
    nodeId: mainNodeId,
    edgesCreated,
    filesLinked: files.length,
    symbolsLinked: symbols.length,
    keywordsLinked: keywords.length,
  };
});

/**
 * Removes a routing graph node (and all incident forward/reverse edges) by canonical key.
 * Used when a RAG/knowledge item is archived or deleted so stale pointers never linger.
 */
export const removeRoutingNodeByCanonicalKey = Effect.fn(
  "WorkspaceRoutingGraph.removeByCanonicalKey",
)(function* (
  sql: SqlClient.SqlClient,
  input: { readonly projectId: string; readonly canonicalKey: string },
) {
  const rows = yield* sql<{ node_id: number }>`
    SELECT node_id FROM workspace_routing_nodes
    WHERE project_id = ${input.projectId} AND canonical_key = ${input.canonicalKey}
  `;
  for (const row of rows) {
    yield* sql`DELETE FROM workspace_routing_edges WHERE project_id = ${input.projectId} AND (src_id = ${row.node_id} OR dst_id = ${row.node_id})`;
    yield* sql`DELETE FROM workspace_routing_edges_rev WHERE project_id = ${input.projectId} AND (src_id = ${row.node_id} OR dst_id = ${row.node_id})`;
    yield* sql`DELETE FROM workspace_routing_nodes WHERE project_id = ${input.projectId} AND node_id = ${row.node_id}`;
  }
  if (rows.length > 0) {
    // Clean up orphaned phrase/file/symbol anchor nodes that no longer connect to any document.
    yield* sql`
      DELETE FROM workspace_routing_nodes
      WHERE project_id = ${input.projectId}
        AND node_kind IN (${ROUTING_NODE_KIND.PHRASE}, ${ROUTING_NODE_KIND.FILE}, ${ROUTING_NODE_KIND.SYMBOL})
        AND NOT EXISTS (
          SELECT 1 FROM workspace_routing_edges e
          WHERE e.project_id = ${input.projectId}
            AND (e.src_id = workspace_routing_nodes.node_id OR e.dst_id = workspace_routing_nodes.node_id)
        )
    `;
  }
  return rows.length;
});

/**
 * Incremental zero-RAM / zero-LLM sync of active `projection_workspace_knowledge_items`
 * into the SQLite disk-resident keyword routing graph.
 * Only processes items missing from `workspace_routing_nodes` or updated more recently
 * than their stored node timestamp.
 */
export const syncMissingKnowledgeToRoutingGraph = Effect.fn(
  "WorkspaceRoutingGraph.syncMissingKnowledge",
)(function* (
  sql: SqlClient.SqlClient,
  input: { readonly projectId: string; readonly maxItems?: number | undefined },
) {
  const limit = input.maxItems ?? 120;
  const rows = yield* sql<{
    item_id: string;
    title: string;
    content: string;
    tags_json: string | null;
    updated_at: string;
    existing_updated_ms: number | null;
  }>`
    SELECT
      k.item_id,
      k.title,
      substr(k.content, 1, 4000) AS content,
      k.tags_json,
      k.updated_at,
      n.updated_at_ms AS existing_updated_ms
    FROM projection_workspace_knowledge_items k
    LEFT JOIN workspace_routing_nodes n
      ON n.project_id = k.project_id
     AND n.node_kind = ${ROUTING_NODE_KIND.MEMORY_FACT}
     AND n.canonical_key = ('knowledge:' || k.item_id)
    WHERE k.project_id = ${input.projectId}
      AND k.status = 'active'
      AND (n.node_id IS NULL OR n.updated_at_ms < CAST(strftime('%s', k.updated_at) AS INTEGER) * 1000)
    ORDER BY k.updated_at DESC
    LIMIT ${limit}
  `.pipe(Effect.orElseSucceed(() => []));

  let indexedCount = 0;
  let edgesCreated = 0;
  for (const row of rows) {
    let tags: string[] = [];
    if (row.tags_json) {
      try {
        const parsed = JSON.parse(row.tags_json);
        if (Array.isArray(parsed)) {
          tags = parsed.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
        }
      } catch {
        // Ignore malformed tag JSON.
      }
    }
    const updatedMs = Date.parse(row.updated_at) || Date.now();
    const res = yield* indexTextArtifactIntoRoutingGraph(sql, {
      projectId: input.projectId,
      nodeKind: ROUTING_NODE_KIND.MEMORY_FACT,
      canonicalKey: `knowledge:${row.item_id}`,
      title: row.title || row.item_id,
      summaryMoc: row.content.slice(0, 220),
      bodyMarkdown: row.content,
      bodyRefKind: "knowledge",
      bodyRefId: row.item_id,
      epistemicState: "fact",
      keywords: tags,
      updatedAtMs: updatedMs,
    });
    indexedCount += 1;
    edgesCreated += res.edgesCreated;
  }
  return { indexedCount, edgesCreated };
});

/**
 * Zero-token deterministic staleness propagation & self-healing on file SHA-256 change.
 * - If `newBlobSha256` differs from stored hash -> marks dependent nodes `stale_status = 2` (STALE).
 * - If `newBlobSha256` matches restored original hash (`git checkout`) -> self-heals to `0` (VALID).
 */
export const propagateFileHashStaleness = Effect.fn(
  "WorkspaceRoutingGraph.propagateFileHashStaleness",
)(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly projectId: string;
    readonly filePath: string;
    readonly newBlobSha256: string;
    readonly baselineSha256?: string | undefined;
  },
) {
  const [fileNode] = yield* sql<{ node_id: number; blob_sha256: string | null }>`
    SELECT node_id, blob_sha256
    FROM workspace_routing_nodes
    WHERE project_id = ${input.projectId}
      AND node_kind = ${ROUTING_NODE_KIND.FILE}
      AND (file_path = ${input.filePath} OR canonical_key = ${`file:${input.filePath}`})
    LIMIT 1
  `;
  if (!fileNode) {
    return { found: false, changed: false, affectedNodes: 0, newStaleStatus: 0 as const };
  }

  const effectiveBaseline = input.baselineSha256 ?? fileNode.blob_sha256;
  const isUnchanged =
    effectiveBaseline !== null &&
    effectiveBaseline !== undefined &&
    effectiveBaseline === input.newBlobSha256;
  const isFirstStamp = fileNode.blob_sha256 === null && input.baselineSha256 === undefined;

  if (isFirstStamp) {
    yield* sql`
      UPDATE workspace_routing_nodes
      SET blob_sha256 = ${input.newBlobSha256}, stale_status = 0
      WHERE node_id = ${fileNode.node_id}
    `;
    return { found: true, changed: false, affectedNodes: 0, newStaleStatus: 0 as const };
  }

  const nextStatus: 0 | 2 = isUnchanged ? 0 : 2;
  const dependents = yield* sql<{ src_id: number }>`
    SELECT DISTINCT src_id
    FROM workspace_routing_edges_rev
    WHERE project_id = ${input.projectId}
      AND dst_id = ${fileNode.node_id}
      AND edge_type IN (${ROUTING_EDGE_TYPE.TOUCHES_FILE}, ${ROUTING_EDGE_TYPE.VERIFIED_BY})
      AND valid_to_ms IS NULL
  `;

  if (dependents.length > 0) {
    for (const dep of dependents) {
      yield* sql`
        UPDATE workspace_routing_nodes
        SET stale_status = ${nextStatus}
        WHERE node_id = ${dep.src_id} AND project_id = ${input.projectId}
      `;
    }
  }
  return {
    found: true,
    changed: !isUnchanged,
    affectedNodes: dependents.length,
    newStaleStatus: nextStatus,
  };
});

function mapRow(r: {
  node_id: number;
  project_id: string;
  node_kind: number;
  canonical_key: string;
  title: string;
  summary_moc: string;
  body_markdown: string;
  body_ref_kind: string | null;
  body_ref_id: string | null;
  epistemic_state: string;
  stale_status: number;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  blob_sha256: string | null;
  updated_at_ms: number;
}): RoutingNodeRecord {
  return {
    nodeId: r.node_id,
    projectId: r.project_id,
    nodeKind: r.node_kind,
    canonicalKey: r.canonical_key,
    title: r.title,
    summaryMoc: r.summary_moc,
    bodyMarkdown: r.body_markdown,
    bodyRefKind: r.body_ref_kind,
    bodyRefId: r.body_ref_id,
    epistemicState: r.epistemic_state,
    staleStatus: r.stale_status,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
    blobSha256: r.blob_sha256,
    updatedAtMs: r.updated_at_ms,
  };
}

/**
 * Disk-resident 2-Hop Truncated Push PPR + `fts5vocab` specificity weighting
 * (`0 MB` extra V8 heap, target latency < 10 ms).
 * Returns a compact `~350–480 tok` `<t3_routing_moc>` block with #1 primary report
 * summary + #2..5 1-line pointers carrying `[VALID]` / `[STALE]` badges.
 */
export const queryRoutingGraphMoc = Effect.fn("WorkspaceRoutingGraph.queryMoc")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly projectId: string;
    readonly query: string;
    readonly nowMs?: number | undefined;
    readonly maxPointers?: number | undefined;
  },
) {
  const startedAt = Date.now();
  const nowMs = input.nowMs ?? startedAt;
  const maxPointers = input.maxPointers ?? 4;

  const [countRow] = yield* sql<{ cnt: number }>`
    SELECT COUNT(*) AS cnt FROM workspace_routing_nodes WHERE project_id = ${input.projectId}
  `;
  const totalDocs = countRow?.cnt ?? 0;

  let fileSeeds = 0;
  let symbolSeeds = 0;
  let keywordSeeds = 0;
  let ftsSeeds = 0;

  const finalize = (payload: {
    readonly renderedMoc: string;
    readonly primaryNode: RoutingNodeRecord | null;
    readonly pointerNodes: ReadonlyArray<RoutingNodeRecord>;
    readonly seedCount: number;
  }) => {
    const elapsedMs = Date.now() - startedAt;
    const channelSeeds: RoutingMocChannelSeeds = {
      totalDocs,
      fileSeeds,
      symbolSeeds,
      keywordSeeds,
      ftsSeeds,
    };
    return Effect.annotateCurrentSpan({
      "routing.project_id": input.projectId,
      "routing.total_docs": totalDocs,
      "routing.seed_file_count": fileSeeds,
      "routing.seed_symbol_count": symbolSeeds,
      "routing.seed_keyword_count": keywordSeeds,
      "routing.seed_fts_count": ftsSeeds,
      "routing.seed_count": payload.seedCount,
      "routing.primary_node_kind": routingNodeKindLabel(payload.primaryNode?.nodeKind),
      "routing.pointer_nodes_count": payload.pointerNodes.length,
      "routing.rendered_moc_chars": payload.renderedMoc.length,
      "routing.elapsed_ms": elapsedMs,
    }).pipe(
      Effect.as({
        renderedMoc: payload.renderedMoc,
        primaryNode: payload.primaryNode,
        pointerNodes: payload.pointerNodes,
        seedCount: payload.seedCount,
        elapsedMs,
        channelSeeds,
      } satisfies RoutingMocResult),
    );
  };

  if (totalDocs === 0) {
    return yield* finalize({
      renderedMoc: "",
      primaryNode: null,
      pointerNodes: [],
      seedCount: 0,
    });
  }

  const seedScores = new Map<number, number>();
  const addSeed = (nodeId: number, weight: number) => {
    seedScores.set(nodeId, (seedScores.get(nodeId) ?? 0) + weight);
  };

  // Channel 1 (lambda=0.45): Exact file & symbol anchors extracted from user query.
  const queryFiles = extractReferencedFilePaths(input.query);
  const querySymbols = extractReferencedSymbols(input.query);
  const queryTerms = tokenizeQueryTerms(input.query);

  const fileSeedIds = new Set<number>();
  for (const filePath of queryFiles) {
    const rows = yield* sql<{ node_id: number }>`
      SELECT node_id FROM workspace_routing_nodes
      WHERE project_id = ${input.projectId}
        AND (file_path = ${filePath} OR canonical_key = ${`file:${filePath}`})
      LIMIT 8
    `;
    for (const r of rows) {
      addSeed(r.node_id, 0.45);
      fileSeedIds.add(r.node_id);
    }
  }
  fileSeeds = fileSeedIds.size;

  const symbolSeedIds = new Set<number>();
  for (const sym of querySymbols) {
    const rows = yield* sql<{ node_id: number }>`
      SELECT node_id FROM workspace_routing_nodes
      WHERE project_id = ${input.projectId}
        AND node_kind = ${ROUTING_NODE_KIND.SYMBOL}
        AND canonical_key = ${`sym:${sym}`}
      LIMIT 8
    `;
    for (const r of rows) {
      addSeed(r.node_id, 0.45);
      symbolSeedIds.add(r.node_id);
    }
  }
  symbolSeeds = symbolSeedIds.size;

  // Channel 1B (lambda=0.25): Direct keyword phrase anchors (`kw:*`) on SQLite B-Tree
  // so non-code Korean/English RAG documents immediately route through 2-Hop keyword edges.
  const keywordSeedIds = new Set<number>();
  for (const term of queryTerms.slice(0, 12)) {
    const rows = yield* sql<{ node_id: number }>`
      SELECT node_id FROM workspace_routing_nodes
      WHERE project_id = ${input.projectId}
        AND node_kind = ${ROUTING_NODE_KIND.PHRASE}
        AND canonical_key = ${`kw:${term}`}
      LIMIT 4
    `;
    for (const r of rows) {
      addSeed(r.node_id, 0.25);
      keywordSeedIds.add(r.node_id);
    }
  }
  keywordSeeds = keywordSeedIds.size;

  // Channel 2 (lambda=0.30): Rare-term BM25 via O(1) `fts5vocab` + Wave 4-A2 Korean Bigram FTS5.
  const weightedTerms: Array<{ term: string; specificity: number }> = [];
  for (const term of queryTerms) {
    const [vocab] = yield* sql<{ doc: number }>`
      SELECT doc FROM workspace_routing_fts_vocab WHERE term = ${term} LIMIT 1
    `;
    if (!vocab || vocab.doc <= 0) continue;
    const dfRatio = vocab.doc / Math.max(1, totalDocs);
    if (totalDocs >= 20 && dfRatio > 0.35) continue;
    const specificity = Math.log(1 + totalDocs / Math.max(1, vocab.doc));
    weightedTerms.push({ term, specificity });
  }
  weightedTerms.sort((a, b) => b.specificity - a.specificity);

  const topFtsTerms = weightedTerms.slice(0, 6);
  const ftsSeedIds = new Set<number>();
  if (topFtsTerms.length > 0) {
    const matchExpr = topFtsTerms.map((t) => `"${t.term.replaceAll('"', "")}"`).join(" OR ");
    const ftsRows = yield* sql<{ node_id: number; rank: number }>`
      SELECT n.node_id, bm25(workspace_routing_fts) AS rank
      FROM workspace_routing_fts f
      JOIN workspace_routing_nodes n ON n.node_id = f.rowid
      WHERE f.workspace_routing_fts MATCH ${matchExpr}
        AND n.project_id = ${input.projectId}
      ORDER BY rank ASC
      LIMIT 32
    `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ node_id: number; rank: number }>));

    for (let i = 0; i < ftsRows.length; i += 1) {
      const r = ftsRows[i]!;
      const normScore = 0.3 / (1 + i * 0.25);
      addSeed(r.node_id, normScore);
      ftsSeedIds.add(r.node_id);
    }
  }

  // Channel 2B (Wave 4-A2): Auxiliary Korean bigram FTS5 (`workspace_routing_fts_ko`)
  // catches 2-char Korean nouns ("토큰", "캐시", "백업") and particle-inflected text.
  const koMatchExpr = buildKoreanBigramFtsMatchExpr(queryTerms);
  if (koMatchExpr) {
    const koRows = yield* sql<{ node_id: number; rank: number }>`
      SELECT n.node_id, bm25(workspace_routing_fts_ko) AS rank
      FROM workspace_routing_fts_ko f
      JOIN workspace_routing_nodes n ON n.node_id = f.rowid
      WHERE f.workspace_routing_fts_ko MATCH ${koMatchExpr}
        AND n.project_id = ${input.projectId}
      ORDER BY rank ASC
      LIMIT 24
    `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ node_id: number; rank: number }>));

    for (let i = 0; i < koRows.length; i += 1) {
      const r = koRows[i]!;
      const normScore = 0.28 / (1 + i * 0.25);
      addSeed(r.node_id, normScore);
      ftsSeedIds.add(r.node_id);
    }
  }
  ftsSeeds = ftsSeedIds.size;

  if (seedScores.size === 0) {
    return yield* finalize({
      renderedMoc: "",
      primaryNode: null,
      pointerNodes: [],
      seedCount: 0,
    });
  }

  // 2-Hop Truncated Push PPR (alpha = 0.50, beam B = 48, degree cap = 64).
  const ALPHA = 0.5;
  const BEAM = 48;
  const DEG_CAP = 64;
  const pprScores = new Map<number, number>(seedScores);

  let frontier = [...seedScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, BEAM);

  for (let hop = 0; hop < 2; hop += 1) {
    const nextFrontier = new Map<number, number>();
    for (const [srcId, mass] of frontier) {
      const fwd = yield* sql<{ dst_id: number; weight: number }>`
        SELECT dst_id, weight FROM workspace_routing_edges
        WHERE project_id = ${input.projectId} AND src_id = ${srcId} AND valid_to_ms IS NULL
        LIMIT ${DEG_CAP}
      `;
      const rev = yield* sql<{ src_id: number; weight: number }>`
        SELECT src_id, weight FROM workspace_routing_edges_rev
        WHERE project_id = ${input.projectId} AND dst_id = ${srcId} AND valid_to_ms IS NULL
        LIMIT ${DEG_CAP}
      `;
      const neighbors: Array<{ id: number; weight: number }> = [
        ...fwd.map((e) => ({ id: e.dst_id, weight: e.weight })),
        ...rev.map((e) => ({ id: e.src_id, weight: e.weight * 0.85 })),
      ];
      if (neighbors.length === 0) continue;
      const denom = Math.sqrt(neighbors.length);
      for (const nb of neighbors) {
        const pushed = ((1 - ALPHA) * mass * nb.weight) / denom;
        pprScores.set(nb.id, (pprScores.get(nb.id) ?? 0) + pushed);
        nextFrontier.set(nb.id, (nextFrontier.get(nb.id) ?? 0) + pushed);
      }
    }
    frontier = [...nextFrontier.entries()].sort((a, b) => b[1] - a[1]).slice(0, BEAM);
  }

  // Fetch candidate content nodes (prefer MASTER_REPORT=4 & MEMORY_FACT=5 over raw phrase/file nodes).
  const topCandidateIds = [...pprScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([id]) => id);

  const candidates: Array<{ node: RoutingNodeRecord; score: number }> = [];
  for (const id of topCandidateIds) {
    const [row] = yield* sql<{
      node_id: number;
      project_id: string;
      node_kind: number;
      canonical_key: string;
      title: string;
      summary_moc: string;
      body_markdown: string;
      body_ref_kind: string | null;
      body_ref_id: string | null;
      epistemic_state: string;
      stale_status: number;
      file_path: string | null;
      start_line: number | null;
      end_line: number | null;
      blob_sha256: string | null;
      updated_at_ms: number;
    }>`SELECT * FROM workspace_routing_nodes WHERE node_id = ${id} AND project_id = ${input.projectId}`;
    if (!row) continue;
    if (
      row.node_kind !== ROUTING_NODE_KIND.MASTER_REPORT &&
      row.node_kind !== ROUTING_NODE_KIND.MEMORY_FACT
    ) {
      continue;
    }
    const base = pprScores.get(id) ?? 0;
    const ageDays = Math.max(0, (nowMs - row.updated_at_ms) / 86_400_000);
    const recencyFactor = 1 / (1 + ageDays * 0.02);
    const kindBoost = row.node_kind === ROUTING_NODE_KIND.MASTER_REPORT ? 1.65 : 1.0;
    const stalePenalty = row.stale_status === 2 ? 0.85 : 1.0;
    candidates.push({ node: mapRow(row), score: base * recencyFactor * kindBoost * stalePenalty });
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length === 0) {
    return yield* finalize({
      renderedMoc: "",
      primaryNode: null,
      pointerNodes: [],
      seedCount: seedScores.size,
    });
  }

  // MMR-style deduplication by title/file diversity.
  const selected: RoutingNodeRecord[] = [];
  const seenFiles = new Set<string>();
  for (const item of candidates) {
    if (selected.length >= 1 + maxPointers) break;
    if (item.node.filePath && seenFiles.has(item.node.filePath) && selected.length >= 2) {
      continue;
    }
    selected.push(item.node);
    if (item.node.filePath) seenFiles.add(item.node.filePath);
  }

  const primaryNode = selected[0] ?? null;
  const pointerNodes = selected.slice(1);

  const badge = (stale: number) =>
    stale === 2 ? "[STALE:파일변경]" : stale === 1 ? "[SUSPECT]" : "[VALID]";
  const lines: string[] = [
    "<t3_routing_moc>",
    "선계산 라우팅 이정표(MoC): 아래 1위 요약과 포인터만 먼저 참고하고, 상세 원문이 필요할 때만 workspace_memory read로 정밀 조회하라.",
  ];
  if (primaryNode) {
    lines.push(
      `[PRIMARY #${primaryNode.nodeId} ${badge(primaryNode.staleStatus)} ${primaryNode.epistemicState}] ${primaryNode.title}`,
      compactMocLine(primaryNode.summaryMoc, 260),
    );
  }
  if (pointerNodes.length > 0) {
    lines.push("[POINTERS]");
    for (const ptr of pointerNodes) {
      const refHint = ptr.bodyRefId ? ` ref=${ptr.bodyRefId}` : "";
      lines.push(
        `- #${ptr.nodeId} ${badge(ptr.staleStatus)} ${ptr.title} — ${compactMocLine(ptr.summaryMoc, 110)}${refHint}`,
      );
    }
  }
  lines.push("</t3_routing_moc>");

  const aliased = applyMonorepoPathAliases(lines.join("\n"), 2);
  const renderedMoc = aliased.header
    ? aliased.text.replace("<t3_routing_moc>", `<t3_routing_moc>\n${aliased.header}`)
    : aliased.text;

  return yield* finalize({
    renderedMoc,
    primaryNode,
    pointerNodes,
    seedCount: seedScores.size,
  });
});

/** Batch-read up to 5 routing graph nodes by `nodeId` in a single query. */
export const readRoutingNodesBatch = Effect.fn("WorkspaceRoutingGraph.readBatch")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly projectId: string; readonly nodeIds: ReadonlyArray<number> },
) {
  const capped = [
    ...new Set(input.nodeIds.filter((id) => Number.isSafeInteger(id) && id > 0)),
  ].slice(0, 5);
  const out: RoutingNodeRecord[] = [];
  for (const id of capped) {
    const [row] = yield* sql<{
      node_id: number;
      project_id: string;
      node_kind: number;
      canonical_key: string;
      title: string;
      summary_moc: string;
      body_markdown: string;
      body_ref_kind: string | null;
      body_ref_id: string | null;
      epistemic_state: string;
      stale_status: number;
      file_path: string | null;
      start_line: number | null;
      end_line: number | null;
      blob_sha256: string | null;
      updated_at_ms: number;
    }>`SELECT * FROM workspace_routing_nodes WHERE project_id = ${input.projectId} AND node_id = ${id}`;
    if (row) out.push(mapRow(row));
  }
  return out;
});

/**
 * Wave 4-A2: Merges legacy particle-bearing `kw:*` nodes (e.g. `kw:토큰을`, `kw:토큰은`)
 * into their normalized canonical hub (`kw:토큰`), migrating all forward & reverse edges
 * losslessly in bounded batches.
 */
export const mergeKoreanParticleKeywordNodes = Effect.fn(
  "WorkspaceRoutingGraph.mergeKoreanKeywords",
)(function* (
  sql: SqlClient.SqlClient,
  input: { readonly projectId: string; readonly maxBatch?: number | undefined },
) {
  const maxBatch = input.maxBatch ?? 200;
  const kwRows = yield* sql<{ node_id: number; canonical_key: string; title: string }>`
    SELECT node_id, canonical_key, title
    FROM workspace_routing_nodes
    WHERE project_id = ${input.projectId}
      AND node_kind = ${ROUTING_NODE_KIND.PHRASE}
      AND canonical_key LIKE 'kw:%'
    LIMIT ${maxBatch * 4}
  `;

  let mergedNodes = 0;
  let migratedEdges = 0;

  for (const row of kwRows) {
    if (mergedNodes >= maxBatch) break;
    const rawKw = row.canonical_key.slice(3);
    if (!hasStrippableKoreanParticle(rawKw)) continue;
    const normKw = normalizeKoreanKeywordToken(rawKw);
    if (!normKw || normKw === rawKw || normKw.length < 2) continue;

    const targetNodeId = yield* upsertRoutingNode(sql, {
      projectId: input.projectId,
      nodeKind: ROUTING_NODE_KIND.PHRASE,
      canonicalKey: `kw:${normKw}`,
      title: normKw,
      summaryMoc: `Keyword ${normKw}`,
      epistemicState: "fact",
    });
    if (targetNodeId === row.node_id) continue;

    const inEdges = yield* sql<{
      src_id: number;
      edge_type: number;
      weight: number;
      valid_from_ms: number;
      valid_to_ms: number | null;
    }>`
      SELECT src_id, edge_type, weight, valid_from_ms, valid_to_ms
      FROM workspace_routing_edges_rev
      WHERE project_id = ${input.projectId} AND dst_id = ${row.node_id}
    `;
    for (const e of inEdges) {
      yield* upsertRoutingEdge(sql, {
        projectId: input.projectId,
        srcId: e.src_id,
        edgeType: e.edge_type as RoutingEdgeType,
        dstId: targetNodeId,
        weight: e.weight,
        validFromMs: e.valid_from_ms,
        validToMs: e.valid_to_ms,
      });
      migratedEdges += 1;
    }

    const outEdges = yield* sql<{
      dst_id: number;
      edge_type: number;
      weight: number;
      valid_from_ms: number;
      valid_to_ms: number | null;
    }>`
      SELECT dst_id, edge_type, weight, valid_from_ms, valid_to_ms
      FROM workspace_routing_edges
      WHERE project_id = ${input.projectId} AND src_id = ${row.node_id}
    `;
    for (const e of outEdges) {
      yield* upsertRoutingEdge(sql, {
        projectId: input.projectId,
        srcId: targetNodeId,
        edgeType: e.edge_type as RoutingEdgeType,
        dstId: e.dst_id,
        weight: e.weight,
        validFromMs: e.valid_from_ms,
        validToMs: e.valid_to_ms,
      });
      migratedEdges += 1;
    }

    yield* sql`DELETE FROM workspace_routing_edges WHERE project_id = ${input.projectId} AND (src_id = ${row.node_id} OR dst_id = ${row.node_id})`;
    yield* sql`DELETE FROM workspace_routing_edges_rev WHERE project_id = ${input.projectId} AND (src_id = ${row.node_id} OR dst_id = ${row.node_id})`;
    yield* sql`DELETE FROM workspace_routing_nodes WHERE project_id = ${input.projectId} AND node_id = ${row.node_id}`;
    mergedNodes += 1;
  }

  return { mergedNodes, migratedEdges };
});

/**
 * Wave 4-A2: Incremental, resumable cursor-based backfill of `workspace_routing_fts_ko`
 * and legacy `kw:*` normalization (designed to run in small chunks while user is away).
 */
export const backfillRoutingKoreanBigramBatch = Effect.fn(
  "WorkspaceRoutingGraph.backfillKoreanBigramBatch",
)(function* (
  sql: SqlClient.SqlClient,
  input: { readonly projectId: string; readonly batchSize?: number | undefined },
) {
  const batchSize = input.batchSize ?? 100;
  const nowMs = Date.now();
  const [cursor] = yield* sql<{
    last_node_id: number;
    normalized_docs: number;
    merged_kw_nodes: number;
  }>`
    SELECT last_node_id, normalized_docs, merged_kw_nodes
    FROM workspace_routing_reindex_state
    WHERE project_id = ${input.projectId}
  `.pipe(Effect.orElseSucceed(() => []));

  const lastNodeId = cursor?.last_node_id ?? 0;
  const docs = yield* sql<{
    node_id: number;
    title: string;
    summary_moc: string;
    body_markdown: string;
  }>`
    SELECT node_id, title, summary_moc, body_markdown
    FROM workspace_routing_nodes
    WHERE project_id = ${input.projectId}
      AND node_kind IN (${ROUTING_NODE_KIND.MASTER_REPORT}, ${ROUTING_NODE_KIND.MEMORY_FACT})
      AND node_id > ${lastNodeId}
    ORDER BY node_id ASC
    LIMIT ${batchSize}
  `;

  let maxSeenId = lastNodeId;
  for (const doc of docs) {
    const ko = buildKoreanBigramIndexFields({
      title: doc.title,
      summaryMoc: doc.summary_moc,
      bodyMarkdown: doc.body_markdown,
    });
    yield* sql`DELETE FROM workspace_routing_fts_ko WHERE rowid = ${doc.node_id}`;
    yield* sql`
      INSERT INTO workspace_routing_fts_ko (rowid, title_ko, body_ko)
      VALUES (${doc.node_id}, ${ko.titleKo}, ${ko.bodyKo})
    `;
    if (doc.node_id > maxSeenId) maxSeenId = doc.node_id;
  }

  const mergeRes = yield* mergeKoreanParticleKeywordNodes(sql, {
    projectId: input.projectId,
    maxBatch: batchSize,
  });

  const done = docs.length < batchSize && mergeRes.mergedNodes < batchSize;
  const nextDocs = (cursor?.normalized_docs ?? 0) + docs.length;
  const nextMerged = (cursor?.merged_kw_nodes ?? 0) + mergeRes.mergedNodes;

  yield* sql`
    INSERT INTO workspace_routing_reindex_state (
      project_id, last_node_id, normalized_docs, merged_kw_nodes, status, updated_at_ms
    ) VALUES (
      ${input.projectId}, ${maxSeenId}, ${nextDocs}, ${nextMerged}, ${done ? "completed" : "in_progress"}, ${nowMs}
    )
    ON CONFLICT(project_id) DO UPDATE SET
      last_node_id = excluded.last_node_id,
      normalized_docs = excluded.normalized_docs,
      merged_kw_nodes = excluded.merged_kw_nodes,
      status = excluded.status,
      updated_at_ms = excluded.updated_at_ms
  `.pipe(Effect.orElseSucceed(() => undefined));

  return {
    processedDocs: docs.length,
    mergedKwNodes: mergeRes.mergedNodes,
    migratedEdges: mergeRes.migratedEdges,
    lastNodeId: maxSeenId,
    done,
  };
});
