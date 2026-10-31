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
  return [...additions];
}

export function workspaceRetrievalQuery(task: string): string {
  const expansion = workspaceSearchExpansion(task);
  return expansion.length ? `${expansion.join(" ")} ${task}` : task;
}
