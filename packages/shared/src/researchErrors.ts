export function researchErrorMessage(cause: unknown, fallback: string): string {
  if (typeof cause === "string" && cause.trim()) return cause;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim()
  )
    return cause.message;
  return fallback;
}
