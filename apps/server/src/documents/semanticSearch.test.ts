// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";
import {
  boundedEmbeddingText,
  cleanupSemanticVectors,
  cosineSimilarity,
  hammingDistanceBinary,
  initSqliteVecHybridSchema,
  makeSemanticSearch,
  quantizeBinaryVector,
  reciprocalRankFusion,
  searchWorkspaceHybridSqliteVec,
  semanticContentKey,
  semanticScopeKey,
  semanticVectorStorePath,
  serializeFloat32Vector,
  sliceAndNormalizeMatryoshka,
  upsertSqliteVecHybridChunk,
  type SemanticCandidate,
  type SemanticScope,
} from "./semanticSearch.ts";

async function indexAll(
  search: ReturnType<typeof makeSemanticSearch>,
  input: SemanticScope & {
    candidates: readonly SemanticCandidate[];
    signal: AbortSignal;
  },
) {
  for (let offset = 0; offset < input.candidates.length; offset += 64)
    await search.index({ ...input, candidates: input.candidates.slice(offset, offset + 64) });
}

it("combines keyword and semantic evidence while discarding low similarity matches", () => {
  const result = reciprocalRankFusion(
    ["exact", "both"],
    [
      { id: "both", similarity: 0.7 },
      { id: "meaning", similarity: 0.65 },
      { id: "noise", similarity: 0.3 },
    ],
  );
  expect(result.map(([id]) => id)).toEqual(["both", "exact", "meaning"]);
  expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  expect(cosineSimilarity([1], [1, 0])).toBe(0);
});
it("requires stronger evidence for semantic-only results while preserving keyword ranks", () => {
  const result = reciprocalRankFusion(
    ["lexical", "corroborated"],
    [
      { id: "semantic-only", similarity: 0.56 },
      { id: "below", similarity: 0.5599 },
      { id: "corroborated", similarity: 0.48 },
      { id: "lexical", similarity: 0.3 },
    ],
  );
  expect(result.map(([id]) => id)).toEqual(["corroborated", "lexical", "semantic-only"]);
});

it("reuses content vectors, invalidates changed documents and scopes projects and models", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-"));
  const calls: string[][] = [];
  const search = makeSemanticSearch({
    now: () => 0,
    embed: async ({ texts }) => {
      calls.push([...texts]);
      return texts.map((text) =>
        text.includes("취소") || text.includes("cancel") ? [1, 0] : [0, 1],
      );
    },
  });
  const input = {
    stateDir: directory,
    projectId: "one",
    model: "model",
    endpoint: "http://127.0.0.1:11434",
    query: "취소",
    candidates: [{ id: "policy", title: "policy", content: "cancel deadline" }],
    signal: new AbortController().signal,
  };
  try {
    await search.index(input);
    expect((await search(input)).ranked[0]?.similarity).toBe(1);
    await search(input);
    expect(calls).toHaveLength(2);
    const changed = {
      ...input,
      candidates: [{ ...input.candidates[0]!, content: "shipping date" }],
    };
    await search.index(changed);
    await search(changed);
    expect(calls).toHaveLength(3);
    await search.index({ ...input, projectId: "two" });
    await search({ ...input, projectId: "two" });
    expect(calls).toHaveLength(5);
    await search.index({ ...input, model: "other" });
    await search({ ...input, model: "other" });
    expect(calls).toHaveLength(7);
    const removed = await search({ ...input, candidates: [] });
    expect(removed.ranked).toEqual([]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
it("rejects remote embedding endpoints before any document is sent", async () => {
  let called = false;
  const search = makeSemanticSearch({
    now: () => 0,
    embed: async () => {
      called = true;
      return [];
    },
  });
  await expect(
    search({
      stateDir: "unused",
      projectId: "p",
      endpoint: "https://example.com",
      model: "m",
      query: "q",
      candidates: [{ id: "a", title: "a", content: "private" }],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("localhost");
  expect(called).toBe(false);
});

it("reuses vectors across folder scopes while ranking only the current candidates", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-scopes-"));
  const calls: string[][] = [];
  const embed = async ({ texts }: { texts: readonly string[] }) => {
    calls.push([...texts]);
    return texts.map(() => [1, 0]);
  };
  const search = makeSemanticSearch({ now: () => 0, embed });
  const input = {
    stateDir: directory,
    projectId: "scoped",
    endpoint: "http://127.0.0.1:11434",
    model: "m",
    query: "policy",
    signal: new AbortController().signal,
  };
  const a = [{ id: "folder-a", title: "A", content: "first folder policy" }];
  const b = [{ id: "folder-b", title: "B", content: "second folder policy" }];
  try {
    await search.index({ ...input, candidates: a });
    await search.index({ ...input, candidates: b });
    expect((await search({ ...input, candidates: a })).ranked.map(({ id }) => id)).toEqual([
      "folder-a",
    ]);
    expect((await search({ ...input, candidates: b })).ranked.map(({ id }) => id)).toEqual([
      "folder-b",
    ]);
    expect((await search({ ...input, candidates: a })).ranked.map(({ id }) => id)).toEqual([
      "folder-a",
    ]);
    expect(calls).toHaveLength(3);

    const reopened = makeSemanticSearch({ now: () => 0, embed });
    await reopened({ ...input, candidates: b });
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual([expect.stringContaining("query: policy")]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("retains vectors across more than 2000 scoped chunks without re-embedding older scopes", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-capacity-"));
  let documentEmbeddings = 0;
  const search = makeSemanticSearch({
    now: () => 0,
    embed: async ({ texts }) => {
      documentEmbeddings += texts.filter((text) => text.startsWith("title:")).length;
      return texts.map(() => [1, 0]);
    },
  });
  const input = {
    stateDir: directory,
    projectId: "bounded",
    endpoint: "http://127.0.0.1:11434",
    model: "m",
    query: "policy",
    signal: new AbortController().signal,
  };
  const scope = (name: string) =>
    Array.from({ length: 1_000 }, (_, index) => ({
      id: `${name}-${index}`,
      title: name,
      content: `${name} policy ${index}`,
    }));
  const a = scope("a");
  const b = scope("b");
  const c = scope("c");
  try {
    await indexAll(search, { ...input, candidates: a });
    await search({ ...input, candidates: a });
    await indexAll(search, { ...input, candidates: b });
    await search({ ...input, candidates: b });
    await search({ ...input, candidates: a });
    expect(documentEmbeddings).toBe(2_000);
    await indexAll(search, { ...input, candidates: c });
    await search({ ...input, candidates: c });
    await search({ ...input, candidates: a });
    expect(documentEmbeddings).toBe(3_000);
    await search({ ...input, candidates: b });
    expect(documentEmbeddings).toBe(3_000);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
it("persists completed indexing batches after a later failure and resumes missing chunks", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-partial-"));
  let fail = true;
  const calls: string[][] = [];
  const search = makeSemanticSearch({
    now: () => 0,
    embed: async ({ texts }) => {
      calls.push([...texts]);
      if (fail && texts.some((text) => text.includes("late chunk")))
        throw new Error("Temporary model overload");
      return texts.map(() => [1, 0]);
    },
  });
  const input = {
    stateDir: directory,
    projectId: "partial",
    endpoint: "http://127.0.0.1:11434",
    model: "m",
    query: "q",
    candidates: ["first", "second", "late chunk", "last"].map((id) => ({
      id,
      title: id,
      content: id,
    })),
    signal: new AbortController().signal,
  };
  try {
    await expect(search.index(input)).rejects.toThrow("Temporary model overload");
    const first = await search(input);
    expect(first.indexed).toBe(2);
    expect(first.total).toBe(4);
    expect(first.interrupted).toBe(false);
    fail = false;
    await search.index(input);
    const resumed = await search(input);
    expect(resumed.indexed).toBe(4);
    expect(resumed.interrupted).toBe(false);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual(expect.arrayContaining([expect.stringContaining("late chunk")]));
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("returns cold-search coverage without embedding documents or waiting for the background job", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-cold-"));
  const calls: string[][] = [];
  const purposes: string[] = [];
  const queued: string[][] = [];
  const search = makeSemanticSearch({
    now: () => 0,
    embed: async ({ texts, purpose }) => {
      calls.push([...texts]);
      purposes.push(purpose);
      return texts.map(() => [1, 0]);
    },
  });
  const input = {
    stateDir: directory,
    projectId: "cold",
    endpoint: "http://127.0.0.1:11434",
    model: "m",
    query: "취소",
    candidates: [{ id: "one", title: "Policy", content: "cancellation policy" }],
    signal: new AbortController().signal,
  };
  try {
    const cold = await search({
      ...input,
      missing: async (projects) => {
        queued.push([...projects]);
      },
    });
    expect(cold).toMatchObject({ total: 1, indexed: 0, ranked: [] });
    expect(calls).toEqual([]);
    expect(queued).toEqual([["cold"]]);
    await search.index(input);
    expect((await search(input)).indexed).toBe(1);
    expect(calls).toHaveLength(2);
    expect(purposes).toEqual(["index", "query"]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("keeps distinct semantic evidence when one large item would otherwise fill the best-100 shortlist", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-diverse-"));
  const search = makeSemanticSearch({
    now: () => 0,
    embed: async ({ texts }) =>
      texts.map((text) => (text.includes("unique evidence") ? [0.8, 0.6] : [1, 0])),
  });
  const input = {
    stateDir: directory,
    projectId: "diverse",
    endpoint: "http://127.0.0.1:11434",
    model: "m",
    query: "policy",
    candidates: [
      ...Array.from({ length: 120 }, (_, n) => ({
        id: `large-${n}`,
        itemId: "one-large-document",
        title: "Large",
        content: `policy section ${n}`,
      })),
      { id: "other", itemId: "other-document", title: "Other", content: "unique evidence" },
    ],
    signal: new AbortController().signal,
  };
  try {
    await indexAll(search, input);
    expect((await search(input)).ranked.map((entry) => entry.id)).toContain("other");
    expect((await search(input)).ranked).toHaveLength(2);
    expect((await search({ ...input, maxChunksPerItem: 3 })).ranked).toHaveLength(4);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("bounds huge titles, multilingual queries and embedding batches without splitting emoji", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-budget-"));
  const calls: string[][] = [];
  const search = makeSemanticSearch({
    now: () => 0,
    embed: async ({ texts }) => {
      calls.push([...texts]);
      expect(texts.length).toBeLessThanOrEqual(2);
      expect(texts.reduce((size, text) => size + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(
        8192,
      );
      for (const text of texts) {
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
        expect(text.isWellFormed()).toBe(true);
      }
      return texts.map(() => [1, 0]);
    },
  });
  const input = {
    stateDir: directory,
    projectId: "bytes",
    endpoint: "http://127.0.0.1:11434",
    model: "m",
    query: "🙂가나다".repeat(100_000),
    candidates: [{ id: "large", title: "큰제목".repeat(100_000), content: "🙂".repeat(100_000) }],
    signal: new AbortController().signal,
  };
  try {
    expect(boundedEmbeddingText("🙂".repeat(10), 7)).toBe("🙂");
    await search.index(input);
    await search(input);
    expect(calls).toHaveLength(2);
    expect(input.candidates[0]!.content.length).toBe(200_000);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("keeps query vector cache within its byte budget as well as its entry limit", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-cache-"));
  const search = makeSemanticSearch({
    now: () => 0,
    embed: async ({ texts }) => texts.map(() => Array.from({ length: 4096 }, () => 1)),
  });
  const input = {
    stateDir: directory,
    projectId: "cache",
    endpoint: "http://127.0.0.1:11434",
    model: "m",
    query: "q",
    candidates: [{ id: "a", title: "a", content: "a" }],
    signal: new AbortController().signal,
  };
  try {
    await search.index(input);
    for (let n = 0; n < 160; n++) await search({ ...input, query: `q-${n}` });
    expect(search.cacheStats().bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(search.cacheStats().entries).toBeLessThan(128);
    search.clear();
    expect(search.cacheStats()).toEqual({ entries: 0, bytes: 0 });
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("keeps partial evidence and reports the interruption when a search is cancelled", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-abort-"));
  const controller = new AbortController();
  const search = makeSemanticSearch({
    now: () => 0,
    embed: async ({ texts }) => texts.map(() => [1, 0]),
  });
  const candidates = Array.from({ length: 128 }, (_, index) => ({
    id: `item-${index}`,
    title: "Policy",
    content: `policy section ${index}`,
  }));
  const input = {
    stateDir: directory,
    projectId: "abort",
    endpoint: "http://127.0.0.1:11434",
    model: "m",
    query: "policy",
    candidates,
    signal: controller.signal,
  };
  let pages = 0;
  try {
    await indexAll(search, { ...input, signal: new AbortController().signal });
    const result = await search({
      ...input,
      candidatePages: async function* (signal) {
        yield candidates.slice(0, 64);
        pages++;
        controller.abort();
        signal.throwIfAborted();
        yield candidates.slice(64);
      },
    });
    expect(pages).toBe(1);
    expect(result.interrupted).toBe(true);
    expect(result.total).toBe(64);
    expect(result.indexed).toBe(64);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.ranked.length).toBe(result.candidates.length);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("previews and removes only old unreferenced legacy JSON vectors, preserving current and fresh files and originals", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-cleanup-"));
  const search = makeSemanticSearch({
    now: () => 0,
    storageMode: "legacy-json",
    embed: async ({ texts }) => texts.map(() => [1, 0]),
  });
  const input = {
    stateDir: directory,
    projectId: "cleanup",
    endpoint: "http://127.0.0.1:11434",
    model: "m",
    candidates: ["active", "orphan", "fresh"].map((id) => ({ id, title: id, content: id })),
    signal: new AbortController().signal,
  };
  const path = (n: number) => {
    const key = semanticContentKey(input.candidates[n]!);
    return NodePath.join(
      directory,
      "semantic-rag/v3",
      semanticScopeKey(input),
      key.slice(0, 2),
      `${key}.json`,
    );
  };
  try {
    await search.index(input);
    await NodeFSP.utimes(path(0), 1, 1);
    await NodeFSP.utimes(path(1), 1, 1);
    const original = NodePath.join(directory, "original.ndjson");
    await NodeFSP.writeFile(original, "original transcript\n");
    const cleanup = {
      ...input,
      olderThan: 60_000,
      referenced: async (key: string) => key === semanticContentKey(input.candidates[0]!),
    };
    expect(await cleanupSemanticVectors({ ...cleanup, apply: false })).toMatchObject({
      eligibleFiles: 1,
      removedFiles: 0,
    });
    await NodeFSP.access(path(1));
    expect(await cleanupSemanticVectors({ ...cleanup, apply: true })).toMatchObject({
      removedFiles: 1,
    });
    await expect(NodeFSP.access(path(1))).rejects.toThrow();
    await NodeFSP.access(path(0));
    await NodeFSP.access(path(2));
    expect(await NodeFSP.readFile(original, "utf8")).toBe("original transcript\n");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("performs 2-stage Binary Quantization Hamming oversampling + Float32 cosine reranking + FTS5 RRF hybrid search in SQLite", () => {
  const mrl = sliceAndNormalizeMatryoshka([3, 4, 0, 0, 99, 100], 4);
  expect(mrl).toHaveLength(4);
  expect(mrl[0]).toBeCloseTo(0.6, 5);
  expect(mrl[1]).toBeCloseTo(0.8, 5);
  expect(serializeFloat32Vector(mrl).byteLength).toBe(16);

  const qA = quantizeBinaryVector([1, -1, 1, -1, 1, 1, -1, -1]);
  const qB = quantizeBinaryVector([1, -1, -1, -1, 1, -1, -1, -1]);
  expect(hammingDistanceBinary(qA, qB)).toBe(2);

  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    initSqliteVecHybridSchema(db, 8);
    upsertSqliteVecHybridChunk(db, {
      chunkId: "chunk-auth",
      workspaceId: "ws-1",
      filePath: "src/auth/session.ts",
      content: "Session token validation and refresh logic for TS-999",
      embedding: [0.9, 0.8, 0.1, -0.2, 0.4, 0.5, -0.1, 0.2],
    });
    upsertSqliteVecHybridChunk(db, {
      chunkId: "chunk-db",
      workspaceId: "ws-1",
      filePath: "src/db/sqlite.ts",
      content: "SQLite WAL checkpoint and connection pooling",
      embedding: [-0.8, -0.7, 0.9, 0.5, -0.4, -0.3, 0.8, -0.2],
    });
    upsertSqliteVecHybridChunk(db, {
      chunkId: "chunk-other-ws",
      workspaceId: "ws-2",
      filePath: "src/secret.ts",
      content: "Session token validation TS-999 in another workspace",
      embedding: [0.9, 0.8, 0.1, -0.2, 0.4, 0.5, -0.1, 0.2],
    });

    const hits = searchWorkspaceHybridSqliteVec(
      db,
      "ws-1",
      "TS-999 session token",
      [0.88, 0.79, 0.12, -0.18, 0.39, 0.51, -0.11, 0.19],
      { topK: 5, oversampleFactor: 5, rrfK: 60 },
    );

    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.chunkId).toBe("chunk-auth");
    expect(hits[0]?.bm25Rank).toBe(1);
    expect(hits[0]?.cosineDistance).not.toBeNull();
    expect(hits[0]?.cosineDistance!).toBeLessThan(0.05);
    expect(hits.some((h) => h.chunkId === "chunk-other-ws")).toBe(false);
  } finally {
    db.close();
  }
});

it("persists vectors in unified v4/vectors.sqlite, promotes legacy v3 JSON without re-embedding, and reclaims stale rows", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-semantic-v4-"));
  let nowMs = 1_000;
  let embedCalls = 0;
  const embed = async ({ texts }: { readonly texts: readonly string[] }) => {
    embedCalls++;
    return texts.map((text) =>
      text.includes("legacy-hit") || text.includes("target-hit")
        ? [0.95, 0.2, 0.1, -0.3, 0.5, 0.4, -0.2, 0.6]
        : [-0.9, -0.3, 0.8, 0.4, -0.5, -0.2, 0.7, -0.4],
    );
  };
  const legacySearch = makeSemanticSearch({ now: () => nowMs, storageMode: "legacy-json", embed });
  const sqliteSearch = makeSemanticSearch({ now: () => nowMs, embed });
  const scope: SemanticScope = {
    stateDir: directory,
    projectId: "proj-v4",
    endpoint: "http://127.0.0.1:11434",
    model: "bge-m3",
  };
  const legacyCandidate: SemanticCandidate = {
    id: "legacy-1",
    title: "Legacy",
    content: "legacy-hit memory note",
  };
  const extraCandidates: SemanticCandidate[] = Array.from({ length: 24 }, (_, idx) => ({
    id: `doc-${idx}`,
    title: `Doc ${idx}`,
    content: idx === 12 ? "target-hit architecture doc" : `noise document number ${idx}`,
  }));

  try {
    // 1. Seed a legacy v3 JSON vector file
    await legacySearch.index({
      ...scope,
      candidates: [legacyCandidate],
      signal: new AbortController().signal,
    });
    const callsAfterLegacy = embedCalls;

    // 2. Index 24 new candidates into unified SQLite v4 store
    await sqliteSearch.index({
      ...scope,
      candidates: extraCandidates,
      signal: new AbortController().signal,
    });
    await NodeFSP.access(semanticVectorStorePath(directory));

    // 3. Search across legacy + v4 candidates: legacy candidate is read and promoted without re-embedding it
    const callsBeforeSearch = embedCalls;
    const result = await sqliteSearch({
      ...scope,
      query: "target-hit",
      candidates: [legacyCandidate, ...extraCandidates],
      signal: new AbortController().signal,
    });
    expect(embedCalls).toBe(callsBeforeSearch + 1); // query embedding only
    expect(result.indexed).toBe(25);
    expect(
      result.ranked
        .slice(0, 2)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["doc-12", "legacy-1"]);
    expect(callsAfterLegacy).toBe(1);

    // 4. Delete the legacy JSON file; subsequent search still finds legacy-1 from v4/vectors.sqlite
    await NodeFSP.rm(NodePath.join(directory, "semantic-rag", "v3"), {
      recursive: true,
      force: true,
    });
    const afterPromotion = await sqliteSearch({
      ...scope,
      query: "target-hit",
      candidates: [legacyCandidate],
      signal: new AbortController().signal,
    });
    expect(afterPromotion.indexed).toBe(1);

    // 5. Cleanup reclaims old unreferenced SQLite rows while keeping referenced rows
    const keepKey = semanticContentKey(legacyCandidate);
    const preview = await cleanupSemanticVectors({
      ...scope,
      olderThan: 10_000,
      apply: false,
      referenced: async (key) => key === keepKey,
      signal: new AbortController().signal,
    });
    expect(preview.eligibleFiles).toBe(24);
    expect(preview.removedFiles).toBe(0);

    const applied = await cleanupSemanticVectors({
      ...scope,
      olderThan: 10_000,
      apply: true,
      referenced: async (key) => key === keepKey,
      signal: new AbortController().signal,
    });
    expect(applied.removedFiles).toBe(24);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
