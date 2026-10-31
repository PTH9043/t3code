// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

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
};
export type SemanticScope = {
  stateDir: string;
  projectId: string;
  endpoint: string;
  model: string;
};
export const EMBEDDING_INPUT_BYTES = 4096;
export const EMBEDDING_BATCH_BYTES = 8192;

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
export const semanticContentText = (candidate: Pick<SemanticCandidate, "title" | "content">) =>
  boundedEmbeddingText(
    `title: ${boundedEmbeddingText(candidate.title, 512)} | text: ${candidate.content.slice(0, 1400)}`,
  );
export const semanticContentKey = (candidate: Pick<SemanticCandidate, "title" | "content">) =>
  hash(semanticContentText(candidate));

export type SemanticEmbeddingInput = {
  readonly endpoint: string;
  readonly model: string;
  readonly texts: readonly string[];
  readonly purpose: "index" | "query";
  readonly signal: AbortSignal;
};

export function semanticScopeKey(scope: Omit<SemanticScope, "stateDir">): string {
  const endpoint = new URL(scope.endpoint);
  if (
    !(
      ["http:", "https:"].includes(endpoint.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    )
  )
    throw new Error("로컬 의미 검색 주소는 이 환경의 localhost여야 합니다.");
  return hash(JSON.stringify([scope.projectId, endpoint.origin, scope.model]));
}
export function cosineSimilarity(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length || left.length === 0) return 0;
  let product = 0,
    leftNorm = 0,
    rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    product += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm > 0 && rightNorm > 0 ? product / Math.sqrt(leftNorm * rightNorm) : 0;
}
/** Preserve exact keyword matches while admitting independently relevant semantic evidence. */
export const MIN_SEMANTIC_SIMILARITY = 0.48;
export function reciprocalRankFusion(
  lexical: readonly string[],
  semantic: readonly { id: string; similarity: number }[],
) {
  const scores = new Map<string, number>();
  lexical.forEach((id, rank) => scores.set(id, 1 / (60 + rank + 1)));
  semantic
    .filter((entry) => entry.similarity >= MIN_SEMANTIC_SIMILARITY)
    .forEach((entry, rank) =>
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + 1 / (60 + rank + 1)),
    );
  return [...scores].toSorted(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
}
/** One vector page and 100 results stay resident; document embedding is an explicit background step. */
export function makeSemanticSearch(dependencies: {
  readonly now: () => number;
  readonly embed: (input: SemanticEmbeddingInput) => Promise<readonly (readonly number[])[]>;
}) {
  const queryVectors = new Map<string, readonly number[]>();
  let queryBytes = 0;
  const file = (scope: SemanticScope, contentKey: string) =>
    NodePath.join(
      scope.stateDir,
      "semantic-rag",
      "v3",
      semanticScopeKey(scope),
      contentKey.slice(0, 2),
      `${contentKey}.json`,
    );
  const read = async (scope: SemanticScope, key: string) => {
    try {
      const path = file(scope, key);
      if ((await NodeFSP.stat(path)).size > 256 * 1024) return undefined;
      return decodeVector(await NodeFSP.readFile(path, "utf8"));
    } catch {
      return undefined;
    }
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
    const vectors = await dependencies.embed({
      endpoint: new URL(scope.endpoint).origin,
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
    semanticScopeKey(input);
    if (input.candidates.length > 64) throw new Error("의미 색인 페이지는 64개 이하여야 합니다.");
    const entries = input.candidates
      .map((candidate) => ({
        candidate,
        text: semanticContentText(candidate),
        key: semanticContentKey(candidate),
      }))
      .sort((left, right) => left.text.length - right.text.length);
    const unique = [...new Map(entries.map((entry) => [entry.key, entry])).values()];
    let written = 0;
    for (let offset = 0; offset < unique.length; offset += 2) {
      input.signal.throwIfAborted();
      const batch = unique.slice(offset, offset + 2);
      const missing: typeof batch = [];
      for (const entry of batch) if (!(await read(input, entry.key))) missing.push(entry);
      if (!missing.length) continue;
      const vectors = await embed(
        input,
        missing.map((entry) => entry.text),
        input.signal,
        "index",
      );
      for (let n = 0; n < missing.length; n++) {
        const path = file(input, missing[n]!.key);
        await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
        const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
        try {
          await NodeFSP.writeFile(temporary, encodeVector(vectors[n]!));
          input.signal.throwIfAborted();
          await NodeFSP.rename(temporary, path);
          written++;
        } finally {
          await NodeFSP.rm(temporary, { force: true });
        }
      }
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
      readonly signal: AbortSignal;
    },
  ) => {
    const scopeKey = semanticScopeKey(input);
    const query = boundedEmbeddingText(
      `task: search result | query: ${boundedEmbeddingText(input.query, EMBEDDING_INPUT_BYTES - 40)}`,
    );
    const queryKey = hash(`${scopeKey}:${query}`);
    let queryVector = queryVectors.get(queryKey);
    if (queryVector) {
      queryVectors.delete(queryKey);
      queryVectors.set(queryKey, queryVector);
    }
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
    try {
      for await (const supplied of pages) {
        for (let offset = 0; offset < supplied.length; offset += 64) {
          input.signal.throwIfAborted();
          const page = supplied.slice(offset, offset + 64);
          if (!page.length) continue;
          const vectors = await Promise.all(
            page.map((candidate) =>
              read(
                { ...input, projectId: candidate.projectId ?? input.projectId },
                semanticContentKey(candidate),
              ),
            ),
          );
          const missingProjects = new Set<string>();
          for (let n = 0; n < page.length; n++)
            if (!vectors[n]) missingProjects.add(page[n]!.projectId ?? input.projectId);
          if (missingProjects.size) await input.missing?.([...missingProjects]);
          if (!queryVector && vectors.some(Boolean)) {
            queryVector = (await embed(input, [query], input.signal, "query"))[0]!;
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
          for (let n = 0; n < page.length; n++) {
            if (!vectors[n] || !queryVector) continue;
            indexed++;
            best.push({
              candidate: page[n]!,
              similarity: cosineSimilarity(queryVector, vectors[n]!),
            });
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
    },
  });
}
/** Only old, unreferenced derived files in one validated scope are eligible for reclamation. */
export async function cleanupSemanticVectors(
  input: SemanticScope & {
    readonly olderThan: number;
    readonly apply: boolean;
    readonly referenced: (contentKey: string) => Promise<boolean>;
    readonly signal: AbortSignal;
  },
) {
  const root = NodePath.join(input.stateDir, "semantic-rag", "v3", semanticScopeKey(input));
  const result = {
    scanned: 0,
    eligibleFiles: 0,
    eligibleBytes: 0,
    removedFiles: 0,
    removedBytes: 0,
  };
  let directories;
  try {
    directories = await NodeFSP.opendir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
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
  return result;
}
