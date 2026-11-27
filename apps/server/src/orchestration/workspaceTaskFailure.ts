/** Classify recognized input errors; their origin remains unknown until investigated. */
export function classifyDeterministicWorkspaceFailure(
  message: string,
):
  | "request-format"
  | "handoff-missing"
  | "handoff-hash-mismatch"
  | "handoff-permission"
  | "delivery-unconfirmed"
  | null {
  if (message.includes("이전 입력의 전달·종료가 미확인입니다. 자동 재전송을 중단했습니다."))
    return "delivery-unconfirmed";
  if (/Expected ['"]function\.name['"] to be a string\./u.test(message)) return "request-format";
  if (!/(?:인계|첨부|입력 파일|handoff|input file)/iu.test(message)) return null;
  if (/(?:hash mismatch|sha-?256[^\n]*mismatch|해시 불일치)/iu.test(message))
    return "handoff-hash-mismatch";
  if (/(?:ENOENT|찾을 수 없)/iu.test(message)) return "handoff-missing";
  if (/(?:EACCES|EPERM|권한)/iu.test(message)) return "handoff-permission";
  return null;
}

export function isDeterministicWorkspaceRequestFailure(message: string): boolean {
  return classifyDeterministicWorkspaceFailure(message) !== null;
}
