import { analyzeSearchText } from "../persistence/searchText.ts";

/**
 * Wave 4-A2: Korean particle/ending normalization & bigram indexing helpers
 * for `WorkspaceRoutingGraph`.
 *
 * Key design properties:
 * - Preserves >= 2 Hangul syllables before stripping any trailing particle/ending
 *   so 2-syllable nouns ("결과", "추가", "회의", "토큰") are never corrupted.
 * - Supports parallel original + normalized indexing/querying so existing
 *   records and newly normalized `kw:*` hubs both hit cleanly.
 * - Uses `searchText.ts`'s proven Hangul bigram analyzer for `workspace_routing_fts_ko`
 *   because SQLite FTS5 `trigram` cannot match 2-syllable Korean nouns (verified on SQLite 3.53.3).
 */

const HANGUL_ONLY_RE = /^[가-힣]+$/u;
const HAS_HANGUL_RE = /[가-힣]/u;

/** Longest-first Korean particles & verb/adjective endings. */
const KOREAN_PARTICLES_AND_ENDINGS: ReadonlyArray<string> = [
  "에서는",
  "에서도",
  "으로는",
  "으로도",
  "으로써",
  "으로서",
  "로부터",
  "에서부터",
  "으로부터",
  "이라는",
  "이라고",
  "에게서",
  "한테서",
  "해주세요",
  "했습니다",
  "해줘요",
  "합니다",
  "됩니다",
  "되었다",
  "하였다",
  "입니다",
  "까지도",
  "부터는",
  "까지는",
  "뿐만",
  "처럼",
  "보다",
  "까지",
  "부터",
  "에서",
  "에게",
  "한테",
  "으로",
  "에는",
  "에도",
  "이나",
  "이랑",
  "하고",
  "라는",
  "라고",
  "해줘",
  "했다",
  "하다",
  "하는",
  "하게",
  "하기",
  "해서",
  "하면",
  "되는",
  "되게",
  "되기",
  "되어",
  "하면",
  "인지",
  "인가",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "로",
  "와",
  "과",
  "도",
  "만",
  "나",
  "랑",
  "한",
  "할",
  "된",
  "됨",
].toSorted((a, b) => b.length - a.length);

/** Common nouns whose final syllable matches a 1-char particle/ending and must NOT be stripped. */
const PROTECTED_KOREAN_STEMS = new Set<string>([
  "결과",
  "추가",
  "회의",
  "정의",
  "주의",
  "강의",
  "동의",
  "논의",
  "문의",
  "처리",
  "관리",
  "정리",
  "분리",
  "원리",
  "메모리",
  "쿼리",
  "카테고리",
  "디렉터리",
  "바이너리",
  "히스토리",
  "스토리",
  "라이브러리",
  "엔트리",
  "데이터",
  "모니터",
  "파라미터",
  "클러스터",
  "컨테이너",
  "서버",
  "에러",
  "오류",
  "이슈",
  "메뉴",
  "리뷰",
  "테스트",
  "리스트",
  "게이트",
  "상태",
  "형태",
  "생태",
  "기반",
  "제한",
  "권한",
  "변환",
  "반환",
  "교환",
  "전환",
  "순환",
  "복원",
  "자원",
  "지원",
  "원인",
  "확인",
  "로그인",
  "토큰",
  "세션",
  "버전",
  "옵션",
  "패턴",
  "엔진",
  "라인",
  "체인",
  "코인",
  "메인",
  "도메인",
  "플러그인",
  "파이프라인",
  "타임라인",
  "모드",
  "코드",
  "노드",
  "로드",
  "필드",
  "빌드",
  "스레드",
  "가이드",
  "하드",
  "보드",
  "대시보드",
  "백엔드",
  "프론트엔드",
  "커맨드",
  "핸들",
  "모델",
  "채널",
  "패널",
  "터널",
  "터미널",
  "시그널",
  "로컬",
  "글로벌",
  "파일",
  "프로필",
  "스타일",
  "타일",
  "스케줄",
  "모듈",
  "규칙",
  "항목",
  "목록",
  "기록",
  "블록",
  "프로토콜",
  "알고리즘",
  "시스템",
  "프로그램",
  "다이어그램",
  "플랫폼",
  "폼",
  "성능",
  "기능",
  "가능",
  "설정",
  "결정",
  "측정",
  "수정",
  "조정",
  "과정",
  "계정",
  "일정",
  "요청",
  "응답",
  "검색",
  "색인",
  "분석",
  "압축",
  "백업",
  "복구",
  "동기화",
  "최적화",
  "정규화",
  "자동화",
  "시각화",
  "대화",
  "강화",
  "변화",
  "초기화",
  "활성화",
  "비활성화",
  "문서",
  "순서",
  "부서",
  "명세서",
  "보고서",
  "계획서",
  "주소",
  "요소",
  "장소",
  "취소",
  "축소",
  "최소",
  "최대",
  "속도",
  "온도",
  "강도",
  "정확도",
  "신뢰도",
  "유사도",
  "중요도",
  "우선순위",
  "단위",
  "범위",
  "위치",
  "수치",
  "가치",
  "배치",
  "설치",
  "일치",
  "장치",
  "패치",
  "스위치",
  "캐시",
  "해시",
  "메시지",
  "페이지",
  "게이지",
  "패키지",
  "이미지",
  "스토리지",
  "브리지",
  "로그",
  "버그",
  "태그",
  "플래그",
  "그래프",
  "프로파일",
  "워크플로우",
  "트레이스",
  "인덱스",
  "프로세스",
  "서비스",
  "리소스",
  "소스로",
  "인터페이스",
  "워크스페이스",
  "데이터베이스",
]);

/**
 * Strips one trailing Korean particle or ending from a Hangul token when:
 * 1. The token is not a protected noun stem, and
 * 2. At least 2 Hangul syllables remain after stripping.
 */
export function normalizeKoreanKeywordToken(rawTerm: string): string {
  const cleaned = rawTerm.normalize("NFKC").toLowerCase().trim();
  if (!cleaned || !HAS_HANGUL_RE.test(cleaned)) return cleaned;
  if (PROTECTED_KOREAN_STEMS.has(cleaned)) return cleaned;

  // Handle pure Hangul or mixed Latin+Hangul (e.g. "rag에서", "fts5는", "opencode가")
  for (const suffix of KOREAN_PARTICLES_AND_ENDINGS) {
    if (!cleaned.endsWith(suffix)) continue;
    const stem = cleaned.slice(0, cleaned.length - suffix.length);
    if (!stem) continue;
    if (HANGUL_ONLY_RE.test(cleaned)) {
      if (Array.from(stem).length >= 2) return stem;
    } else {
      // Mixed token like "rag에서" or "claude를" -> stem must be >= 2 chars
      if (stem.length >= 2) return stem;
    }
  }
  return cleaned;
}

/**
 * Returns deduplicated [normalized, original] variants so indexing and querying
 * match both normalized stems and legacy particle-bearing keywords.
 */
export function expandKoreanTermVariants(rawTerm: string): ReadonlyArray<string> {
  const cleaned = rawTerm.normalize("NFKC").toLowerCase().trim();
  if (!cleaned) return [];
  const normalized = normalizeKoreanKeywordToken(cleaned);
  if (normalized && normalized !== cleaned) {
    return [normalized, cleaned];
  }
  return [cleaned];
}

/**
 * Detects whether a `kw:*` Hangul token still has a strippable Korean particle/ending.
 */
export function hasStrippableKoreanParticle(rawTerm: string): boolean {
  const cleaned = rawTerm.normalize("NFKC").toLowerCase().trim();
  if (!cleaned || !HAS_HANGUL_RE.test(cleaned)) return false;
  return normalizeKoreanKeywordToken(cleaned) !== cleaned;
}

/**
 * Builds analyzed bigram text for `workspace_routing_fts_ko` (using `searchText.ts`).
 */
export function buildKoreanBigramIndexFields(input: {
  readonly title: string;
  readonly summaryMoc: string;
  readonly bodyMarkdown: string;
}): { readonly titleKo: string; readonly bodyKo: string } {
  const titleKo = analyzeSearchText(input.title);
  const bodyKo = analyzeSearchText(`${input.summaryMoc}\n${input.bodyMarkdown}`);
  return { titleKo, bodyKo };
}

/**
 * Builds an FTS5 MATCH expression over `workspace_routing_fts_ko` for query terms
 * (including 2-character Korean nouns such as "토큰", "캐시", "백업").
 */
export function buildKoreanBigramFtsMatchExpr(rawTerms: ReadonlyArray<string>): string | null {
  const clauses: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTerms) {
    const stem = normalizeKoreanKeywordToken(raw);
    if (!stem || stem.length < 2) continue;
    const analyzed = analyzeSearchText(stem).trim();
    if (!analyzed) continue;
    const escaped = analyzed.replaceAll('"', "");
    if (!escaped || seen.has(escaped)) continue;
    seen.add(escaped);
    clauses.push(`"${escaped}"`);
    if (clauses.length >= 8) break;
  }
  return clauses.length > 0 ? clauses.join(" OR ") : null;
}
