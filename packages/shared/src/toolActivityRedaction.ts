/**
 * Fast secret-denylist redaction for tool activity previews, commands, and
 * background task progress lines. Preserves normal commands, paths, flags,
 * and diagnostic output while masking credentials and sensitive file contents.
 */

const URL_WITH_SECRET_PATTERN =
  /\bhttps?:\/\/(?:[^\s/@'"]+?:[^\s/@'"]+?@[^\s'"]+|[^\s'"]*[?&](?:token|key|api[_-]?key|secret|password|passwd|auth|access_token|signature|sig|session|jwt|bearer)=[^\s'"&]+[^\s'"]*)/giu;

const BEARER_OR_BASIC_AUTH_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu;

const KNOWN_API_KEY_PATTERN =
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})\b/gu;

const KEY_VALUE_SECRET_PATTERN =
  /((?:^|[\s;,?&("'`])(?:[A-Z0-9_]*?(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTHORIZATION)|token|secret|password|passwd|api[_-]?key|apikey|credential|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;,&)"'`]+)/giu;

const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/giu;

const SENSITIVE_FILE_PATH_PATTERN =
  /(?:^|[\\/])(?:\.env(?:\.[^\\/\s]+)?|id_(?:rsa|ed25519)|credentials(?:\.[^\\/\s]+)?|[^\\/\s]+\.(?:pem|key|p12|pfx))$/iu;

export function isSensitiveFilePath(filePath: string): boolean {
  return SENSITIVE_FILE_PATH_PATTERN.test(filePath.trim());
}

/**
 * Masks only secret/credential substrings while leaving normal script names,
 * arguments, and diagnostic output readable.
 */
export function redactToolActivityText(raw: string, maxLength?: number): string {
  let text = raw
    .replace(PEM_PRIVATE_KEY_PATTERN, "•••")
    .replace(URL_WITH_SECRET_PATTERN, "•••")
    .replace(BEARER_OR_BASIC_AUTH_PATTERN, "$1 •••")
    .replace(KNOWN_API_KEY_PATTERN, "•••")
    .replace(KEY_VALUE_SECRET_PATTERN, "$1•••");
  if (maxLength !== undefined && text.length > maxLength) {
    text = `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
  }
  return text;
}

/**
 * Redacts a shell command line for technical record display: preserves safe
 * executable names, subcommands, paths, and flags, while masking secret URLs,
 * credential tokens, and key=value secret assignments.
 */
export function redactCommandLineForDisplay(value: unknown, maxLength = 240): string | null {
  const raw =
    typeof value === "string"
      ? value
      : Array.isArray(value) && value.every((v) => typeof v === "string")
        ? value.join(" ")
        : null;
  if (!raw) return null;
  const singleLine = raw.replace(/\s+/gu, " ").trim();
  if (!singleLine) return null;
  return redactToolActivityText(singleLine, maxLength);
}
