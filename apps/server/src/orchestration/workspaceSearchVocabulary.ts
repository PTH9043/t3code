/** Small bilingual project vocabulary, applied to retrieval only; the user's task stays verbatim. */
export function workspaceSearchExpansion(task: string): ReadonlyArray<string> {
  const additions = new Set<string>();
  if (/(?:다른|별도|각).{0,8}(?:프로젝트|폴더|디렉터리).{0,16}(?:섞|분리|격리|경계)/u.test(task)) {
    additions.add("문맥");
    additions.add("격리");
  }
  if (/휴대폰|스마트폰/u.test(task)) additions.add("모바일");
  if (/파일.{0,12}지켜보|파일\s*(?:감시|변경\s*감지)|변경\s*감지.{0,12}(?:파일|폴더)/u.test(task)) {
    additions.add("감시기");
    additions.add("fs.watch");
  }
  if (/실행\s*파일\s*(?:탐색|검색)\s*경로|명령어\s*검색\s*경로/u.test(task)) additions.add("PATH");
  if (/인공지능/u.test(task) && /명령|실행|토큰|소비량|세션|에이전트|발언/u.test(task))
    additions.add("AI");
  if (
    /(?:소비량|사용량|누적\s*집계)/u.test(task) &&
    /인공지능|\bAI\b|토큰|provider|세션/iu.test(task)
  ) {
    additions.add("토큰");
    additions.add("사용량");
  }
  if (/출장/u.test(task) && /숙박비|교통비|식비|일비|여비|한도/u.test(task)) {
    additions.add("규정");
  }
  if (/(?:재정렬|리랭킹|순위\s*융합)/u.test(task)) {
    additions.add("RRF");
    additions.add("rerank");
  }
  if (/(?:후기\s*청킹|맥락\s*보존\s*청킹)/u.test(task)) {
    additions.add("chunking");
  }
  return [...additions];
}

export function workspaceRetrievalQuery(task: string): string {
  const expansion = workspaceSearchExpansion(task);
  return expansion.length ? `${expansion.join(" ")} ${task}` : task;
}

/**
 * Decompose a multi-hop or comparative user question into bounded sub-queries
 * so Agentic RAG map-reduce and sufficient-context checks can evaluate each facet.
 */
export function decomposeRetrievalSubQueries(task: string): ReadonlyArray<string> {
  const normalized = task.replace(/\s+/gu, " ").trim();
  if (!normalized) return [];
  const clauses = normalized
    .split(/\s*(?:그리고|또한|반면에?|및|(?<=[\p{L}\p{N}])와\/과|;|(?<=\?)\s+)\s*/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
  if (clauses.length <= 1) return [normalized];
  return [normalized, ...clauses.slice(0, 4)];
}
