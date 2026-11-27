/**
 * Memory & Conversation RAG Privacy Guard (Korean PII + Credentials).
 *
 * Scrubs cryptographic keys, bearer/API tokens, password assignments, and
 * high-risk Korean PII (Resident Registration Numbers, Luhn-verified payment
 * cards, Korean mobile numbers, and NTS checksum-verified Business Registration
 * Numbers) before durable persistence or FTS/vector indexing.
 */

export interface MemoryPrivacyOptions {
  readonly maskPhoneNumbers?: boolean;
}

export interface MemoryRedactionResult {
  readonly content: string;
  readonly redactionCount: number;
}

const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isPlausibleKoreanRrnDate(yymmdd: string, genderDigit: string): boolean {
  if (yymmdd.length !== 6) return false;
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  const gender = Number(genderDigit);
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const maxDay = DAYS_IN_MONTH[month] ?? 31;
  if (!Number.isInteger(day) || day < 1 || day > maxDay) return false;
  return gender >= 1 && gender <= 8;
}

export function isValidLuhnCardNumber(digitsOnly: string): boolean {
  if (digitsOnly.length < 13 || digitsOnly.length > 19 || !/^\d+$/.test(digitsOnly)) {
    return false;
  }
  // Reject trivial all-identical digits such as 0000000000000000
  if (/^(\d)\1+$/.test(digitsOnly)) {
    return false;
  }
  let sum = 0;
  let shouldDouble = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let digit = digitsOnly.charCodeAt(i) - 48;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Korean National Tax Service (국세청) 10-digit Business Registration Number checksum.
 */
export function isValidKoreanBizRegNo(digitsOnly: string): boolean {
  if (!/^\d{10}$/.test(digitsOnly) || /^(\d)\1+$/.test(digitsOnly)) {
    return false;
  }
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5] as const;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += (digitsOnly.charCodeAt(i) - 48) * weights[i]!;
  }
  sum += Math.floor(((digitsOnly.charCodeAt(8) - 48) * 5) / 10);
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === digitsOnly.charCodeAt(9) - 48;
}

function replaceSensitive(
  value: string,
  pattern: RegExp,
  replacement: string | ((...args: string[]) => string | null),
): { readonly value: string; readonly count: number } {
  let count = 0;
  const next = value.replace(pattern, (...args: string[]) => {
    if (typeof replacement === "string") {
      count += 1;
      return replacement;
    }
    const candidate = replacement(...args);
    if (candidate === null) {
      return args[0]!;
    }
    count += 1;
    return candidate;
  });
  return { value: next, count };
}

export function redactMemorySensitiveData(
  input: string,
  options: MemoryPrivacyOptions = {},
): MemoryRedactionResult {
  const maskPhoneNumbers = options.maskPhoneNumbers ?? true;
  let content = input;
  let redactionCount = 0;

  const apply = (pattern: RegExp, replacement: string | ((...args: string[]) => string | null)) => {
    const result = replaceSensitive(content, pattern, replacement);
    content = result.value;
    redactionCount += result.count;
  };

  // 1. Cryptographic private keys
  apply(
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    "[민감정보 제거: 개인 키]",
  );

  // 2. Authorization Bearer tokens
  apply(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [민감정보 제거: 토큰]");

  // 3. Well-known cloud / AI provider secret prefixes
  apply(
    /\b(?:sk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xai-[A-Za-z0-9_-]{20,})\b/g,
    "[민감정보 제거: 자격 증명]",
  );

  // 4. Key-value credential assignments
  apply(
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*)(["']?)([^\s"',;]{6,})(["']?)/gi,
    (_match, prefix, quote) => `${prefix}${quote}[민감정보 제거]${quote}`,
  );

  // 5. Korean Resident / Foreigner Registration Number (YYMMDD-[1-8]XXXXXX)
  apply(/(?<![0-9A-Za-z-])(\d{6})-([1-8]\d{6})(?![0-9A-Za-z-])/g, (_match, yymmdd, tail) =>
    isPlausibleKoreanRrnDate(yymmdd, tail.slice(0, 1)) ? "[민감정보 제거: 주민등록번호]" : null,
  );

  // 6. Payment card numbers (delimited 4-group or 13~19 digits with Luhn verification)
  apply(/(?<![0-9A-Za-z.-])(?:\d{4}[ -]){2,3}\d{1,7}(?![0-9A-Za-z.-])/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    return isValidLuhnCardNumber(digits) ? "[민감정보 제거: 카드번호]" : null;
  });

  // 7. Korean Mobile Phone Number (010/011/016/017/018/019-XXXX-XXXX)
  if (maskPhoneNumbers) {
    apply(
      /(?<![0-9A-Za-z.-])01[016789]-\d{3,4}-\d{4}(?![0-9A-Za-z.-])/g,
      "[민감정보 제거: 휴대전화]",
    );
  }

  // 8. Korean Business Registration Number (XXX-XX-XXXXX with NTS checksum)
  apply(/(?<![0-9A-Za-z.-])(\d{3})-(\d{2})-(\d{5})(?![0-9A-Za-z.-])/g, (_match, p1, p2, p3) =>
    isValidKoreanBizRegNo(`${p1}${p2}${p3}`) ? "[민감정보 제거: 사업자등록번호]" : null,
  );

  return { content, redactionCount };
}
