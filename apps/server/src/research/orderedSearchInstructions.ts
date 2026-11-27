/** Applied only to turns for which the environment has configured search models. */
export const ORDERED_SEARCH_INSTRUCTIONS =
  "외부 검색이 필요하면 workspace_research(action=search, query, requestId)로 공개 검색어만 보내세요. " +
  "설정한 모델들이 순서대로 조사합니다. 출처가 질문을 뒷받침하는지 확인하세요. " +
  "search-directly이거나 조사 도구를 쓸 수 없으면 현재 모델의 허용된 검색 도구로 직접 확인하세요. " +
  "여전히 근거가 부족하면 확인한 내용, 시도한 경로와 실패 이유를 보고하세요. 권한·예산·안전 정책으로 거절된 작업은 중단하고 사유를 보고하세요.";
