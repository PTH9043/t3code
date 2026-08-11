/** Cap for the per-thread "recently seen" URL list shown in the empty state. */
export const PREVIEW_RECENT_URL_LIMIT = 10;

/**
 * Common Chromium error codes mapped to a short human label. Used by the
 * unreachable view to drop the raw `ERR_*` code in favour of friendlier copy.
 */
export const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: "DNS 주소를 찾을 수 없습니다",
  ERR_NAME_RESOLUTION_FAILED: "DNS 주소를 찾을 수 없습니다",
  ERR_CONNECTION_REFUSED: "연결이 거부되었습니다",
  ERR_CONNECTION_RESET: "연결이 재설정되었습니다",
  ERR_CONNECTION_CLOSED: "연결이 닫혔습니다",
  ERR_CONNECTION_TIMED_OUT: "연결 시간이 초과되었습니다",
  ERR_INTERNET_DISCONNECTED: "인터넷에 연결되어 있지 않습니다",
  ERR_TIMED_OUT: "연결 시간이 초과되었습니다",
  ERR_CERT_AUTHORITY_INVALID: "인증 기관을 신뢰할 수 없습니다",
  ERR_CERT_COMMON_NAME_INVALID: "인증서 호스트 이름이 일치하지 않습니다",
  ERR_CERT_DATE_INVALID: "인증서가 만료되었거나 아직 유효하지 않습니다",
  ERR_TOO_MANY_REDIRECTS: "리디렉션이 너무 많습니다",
});
