// @effect-diagnostics globalDate:off
/**
 * Deterministic Korean & ISO Temporal Expression Parser for Memory v3.
 *
 * Converts Korean relative temporal expressions ("어제", "그저께", "3일 전",
 * "지난주", "저번 달", "3개월 전", "작년 11월", "10월 초/중순/말") into concrete
 * `[startMs, endMs]` epoch windows in the caller's timezone (default KST +09:00),
 * and produces non-destructive tail annotations for FTS/embedding indexing.
 */

export interface ParsedTemporalRange {
  readonly startMs: number;
  readonly endMs: number;
  readonly startIsoDate: string;
  readonly endIsoDate: string;
  readonly matchedExpression: string;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const DEFAULT_KST_OFFSET_MINUTES = 540; // UTC+09:00

const KOREAN_NUMBER_WORDS: Readonly<Record<string, number>> = {
  한: 1,
  일: 1,
  두: 2,
  이: 2,
  세: 3,
  석: 3,
  삼: 3,
  네: 4,
  넉: 4,
  사: 4,
  다섯: 5,
  오: 5,
  여섯: 6,
  육: 6,
  일곱: 7,
  칠: 7,
  여덟: 8,
  팔: 8,
  아홉: 9,
  구: 9,
  열: 10,
  십: 10,
};

function parseKoreanCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return KOREAN_NUMBER_WORDS[trimmed] ?? null;
}

interface LocalParts {
  readonly year: number;
  readonly month: number; // 1..12
  readonly day: number; // 1..31
  readonly dayOfWeek: number; // 0 (Sun) .. 6 (Sat)
}

function toLocalParts(epochMs: number, tzOffsetMinutes: number): LocalParts {
  const shifted = new Date(epochMs + tzOffsetMinutes * MS_PER_MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    dayOfWeek: shifted.getUTCDay(),
  };
}

function fromLocalMidnight(
  year: number,
  month: number,
  day: number,
  tzOffsetMinutes: number,
): number {
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0) - tzOffsetMinutes * MS_PER_MINUTE;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function formatLocalIsoDate(
  epochMs: number,
  tzOffsetMinutes: number = DEFAULT_KST_OFFSET_MINUTES,
): string {
  const { year, month, day } = toLocalParts(epochMs, tzOffsetMinutes);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function makeRange(
  startMs: number,
  endMs: number,
  matchedExpression: string,
  tzOffsetMinutes: number,
): ParsedTemporalRange {
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  return {
    startMs: lo,
    endMs: hi,
    startIsoDate: formatLocalIsoDate(lo, tzOffsetMinutes),
    endIsoDate: formatLocalIsoDate(hi, tzOffsetMinutes),
    matchedExpression: matchedExpression.trim(),
  };
}

function monthPartBounds(
  year: number,
  month: number,
  part: string | undefined,
  tzOffsetMinutes: number,
): { startMs: number; endMs: number } {
  const lastDay = daysInMonth(year, month);
  const normalizedPart = part?.trim();
  const startDay = normalizedPart === "중순" ? 11 : normalizedPart === "말" ? 21 : 1;
  const endDay = normalizedPart === "초" ? 10 : normalizedPart === "중순" ? 20 : lastDay;
  const startMs = fromLocalMidnight(year, month, startDay, tzOffsetMinutes);
  const endMs = fromLocalMidnight(year, month, endDay, tzOffsetMinutes) + MS_PER_DAY - 1;
  return { startMs, endMs };
}

/**
 * Parse the most specific Korean or ISO temporal expression in `query` relative to `nowMs`.
 */
export function parseKoreanTemporalRange(
  query: string,
  nowMs: number = Date.now(),
  tzOffsetMinutes: number = DEFAULT_KST_OFFSET_MINUTES,
): ParsedTemporalRange | null {
  const normalized = query.normalize("NFKC");
  const nowParts = toLocalParts(nowMs, tzOffsetMinutes);
  const todayStartMs = fromLocalMidnight(
    nowParts.year,
    nowParts.month,
    nowParts.day,
    tzOffsetMinutes,
  );

  // 1. Explicit ISO date: YYYY-MM-DD
  const isoMatch = /(?<!\d)(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)/u.exec(normalized);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Math.min(Number(isoMatch[3]), daysInMonth(year, month));
    const start = fromLocalMidnight(year, month, day, tzOffsetMinutes);
    return makeRange(start, start + MS_PER_DAY - 1, isoMatch[0], tzOffsetMinutes);
  }

  // 2. Explicit Korean year + month (+ day or 초/중순/말): "2026년 8월", "작년 11월 초", "올해 3월 15일"
  const yearMonthMatch =
    /(?:(20\d{2})\s*년|(작년|지난해|재작년|올해|금년))\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일|\s*(초|중순|말))?/u.exec(
      normalized,
    );
  if (yearMonthMatch) {
    const yearWord = yearMonthMatch[2];
    const year = yearMonthMatch[1]
      ? Number(yearMonthMatch[1])
      : yearWord === "작년" || yearWord === "지난해"
        ? nowParts.year - 1
        : yearWord === "재작년"
          ? nowParts.year - 2
          : nowParts.year;
    const month = Number(yearMonthMatch[3]);
    if (month >= 1 && month <= 12) {
      if (yearMonthMatch[4]) {
        const day = Math.min(Math.max(1, Number(yearMonthMatch[4])), daysInMonth(year, month));
        const start = fromLocalMidnight(year, month, day, tzOffsetMinutes);
        return makeRange(start, start + MS_PER_DAY - 1, yearMonthMatch[0], tzOffsetMinutes);
      }
      const { startMs, endMs } = monthPartBounds(year, month, yearMonthMatch[5], tzOffsetMinutes);
      return makeRange(startMs, endMs, yearMonthMatch[0], tzOffsetMinutes);
    }
  }

  // 3. Month + day or 초/중순/말 without explicit year ("11월 초", "10월 15일")
  const monthOnlyMatch = /(?<!\d)(1[0-2]|0?[1-9])\s*월(?:\s*(\d{1,2})\s*일|\s*(초|중순|말))/u.exec(
    normalized,
  );
  if (monthOnlyMatch) {
    const month = Number(monthOnlyMatch[1]);
    const inferredYear = month > nowParts.month ? nowParts.year - 1 : nowParts.year;
    if (monthOnlyMatch[2]) {
      const day = Math.min(
        Math.max(1, Number(monthOnlyMatch[2])),
        daysInMonth(inferredYear, month),
      );
      const start = fromLocalMidnight(inferredYear, month, day, tzOffsetMinutes);
      return makeRange(start, start + MS_PER_DAY - 1, monthOnlyMatch[0], tzOffsetMinutes);
    }
    const { startMs, endMs } = monthPartBounds(
      inferredYear,
      month,
      monthOnlyMatch[3],
      tzOffsetMinutes,
    );
    return makeRange(startMs, endMs, monthOnlyMatch[0], tzOffsetMinutes);
  }

  // 4. Relative N units ago ("3일 전", "2주 전", "3개월 전", "두 달 전", "1년 전", "2시간 전")
  const relCountMatch =
    /(?:(\d+|한|두|세|석|네|넉|다섯|여섯|일곱|여덟|아홉|열)\s*(분|시간|일|주|주일|달|개월|년|해)\s*전)/u.exec(
      normalized,
    );
  if (relCountMatch) {
    const count = parseKoreanCount(relCountMatch[1]!);
    const unit = relCountMatch[2]!;
    if (count !== null) {
      if (unit === "분") {
        const center = nowMs - count * MS_PER_MINUTE;
        return makeRange(
          center - 15 * MS_PER_MINUTE,
          Math.min(nowMs, center + 15 * MS_PER_MINUTE),
          relCountMatch[0],
          tzOffsetMinutes,
        );
      }
      if (unit === "시간") {
        const center = nowMs - count * MS_PER_HOUR;
        return makeRange(
          center - 2 * MS_PER_HOUR,
          Math.min(nowMs, center + 2 * MS_PER_HOUR),
          relCountMatch[0],
          tzOffsetMinutes,
        );
      }
      if (unit === "일") {
        const targetStart = todayStartMs - count * MS_PER_DAY;
        return makeRange(
          targetStart,
          targetStart + MS_PER_DAY - 1,
          relCountMatch[0],
          tzOffsetMinutes,
        );
      }
      if (unit === "주" || unit === "주일") {
        const centerStart = todayStartMs - count * 7 * MS_PER_DAY;
        return makeRange(
          centerStart - 3 * MS_PER_DAY,
          centerStart + 4 * MS_PER_DAY - 1,
          relCountMatch[0],
          tzOffsetMinutes,
        );
      }
      if (unit === "달" || unit === "개월") {
        let targetYear = nowParts.year;
        let targetMonth = nowParts.month - count;
        while (targetMonth <= 0) {
          targetMonth += 12;
          targetYear -= 1;
        }
        const monthStart = fromLocalMidnight(targetYear, targetMonth, 1, tzOffsetMinutes);
        const monthEnd =
          fromLocalMidnight(
            targetYear,
            targetMonth,
            daysInMonth(targetYear, targetMonth),
            tzOffsetMinutes,
          ) +
          MS_PER_DAY -
          1;
        return makeRange(
          monthStart - 5 * MS_PER_DAY,
          monthEnd + 5 * MS_PER_DAY,
          relCountMatch[0],
          tzOffsetMinutes,
        );
      }
      if (unit === "년" || unit === "해") {
        const targetYear = nowParts.year - count;
        const yearStart = fromLocalMidnight(targetYear, 1, 1, tzOffsetMinutes);
        const yearEnd = fromLocalMidnight(targetYear, 12, 31, tzOffsetMinutes) + MS_PER_DAY - 1;
        return makeRange(yearStart, yearEnd, relCountMatch[0], tzOffsetMinutes);
      }
    }
  }

  // 5. Named relative days / weeks / months / years
  if (/(?<![가-힣])(?:엊그제|그저께|그제)(?![가-힣])/u.test(normalized)) {
    const match = /(?<![가-힣])(엊그제|그저께|그제)(?![가-힣])/u.exec(normalized)!;
    const daysBack = match[1] === "엊그제" ? 3 : 2;
    const start = todayStartMs - daysBack * MS_PER_DAY;
    return makeRange(
      start,
      todayStartMs - (daysBack === 3 ? 1 : 1) * MS_PER_DAY - 1,
      match[0],
      tzOffsetMinutes,
    );
  }
  if (/(?<![가-힣])(?:어제|전일)(?![가-힣])/u.test(normalized)) {
    const match = /(?<![가-힣])(어제|전일)(?![가-힣])/u.exec(normalized)!;
    const start = todayStartMs - MS_PER_DAY;
    return makeRange(start, todayStartMs - 1, match[0], tzOffsetMinutes);
  }
  if (/(?<![가-힣])(?:오늘|금일)(?![가-힣])/u.test(normalized)) {
    const match = /(?<![가-힣])(오늘|금일)(?![가-힣])/u.exec(normalized)!;
    return makeRange(todayStartMs, todayStartMs + MS_PER_DAY - 1, match[0], tzOffsetMinutes);
  }
  if (/(?<![가-힣])(?:방금|아까|조금\s*전)(?![가-힣])/u.test(normalized)) {
    const match = /(?<![가-힣])(방금|아까|조금\s*전)(?![가-힣])/u.exec(normalized)!;
    return makeRange(nowMs - 6 * MS_PER_HOUR, nowMs, match[0], tzOffsetMinutes);
  }
  if (/며칠\s*전/u.test(normalized)) {
    return makeRange(todayStartMs - 7 * MS_PER_DAY, todayStartMs - 1, "며칠 전", tzOffsetMinutes);
  }
  if (/(?:지난\s*주|저번\s*주|전주)/u.test(normalized)) {
    const match = /(지난\s*주|저번\s*주|전주)/u.exec(normalized)!;
    // Monday-based week: Sunday(0) -> 6 days since Monday; Monday(1) -> 0 days
    const daysSinceMonday = (nowParts.dayOfWeek + 6) % 7;
    const thisMondayStart = todayStartMs - daysSinceMonday * MS_PER_DAY;
    const prevMondayStart = thisMondayStart - 7 * MS_PER_DAY;
    return makeRange(prevMondayStart, thisMondayStart - 1, match[0], tzOffsetMinutes);
  }
  if (/(?:이번\s*주|금주)/u.test(normalized)) {
    const match = /(이번\s*주|금주)/u.exec(normalized)!;
    const daysSinceMonday = (nowParts.dayOfWeek + 6) % 7;
    const thisMondayStart = todayStartMs - daysSinceMonday * MS_PER_DAY;
    return makeRange(thisMondayStart, nowMs, match[0], tzOffsetMinutes);
  }
  if (/(?:지난\s*달|저번\s*달|전월)/u.test(normalized)) {
    const match = /(지난\s*달|저번\s*달|전월)/u.exec(normalized)!;
    const prevYear = nowParts.month === 1 ? nowParts.year - 1 : nowParts.year;
    const prevMonth = nowParts.month === 1 ? 12 : nowParts.month - 1;
    const start = fromLocalMidnight(prevYear, prevMonth, 1, tzOffsetMinutes);
    const end =
      fromLocalMidnight(prevYear, prevMonth, daysInMonth(prevYear, prevMonth), tzOffsetMinutes) +
      MS_PER_DAY -
      1;
    return makeRange(start, end, match[0], tzOffsetMinutes);
  }
  if (/(?:이번\s*달|금월)/u.test(normalized)) {
    const match = /(이번\s*달|금월)/u.exec(normalized)!;
    const start = fromLocalMidnight(nowParts.year, nowParts.month, 1, tzOffsetMinutes);
    return makeRange(start, nowMs, match[0], tzOffsetMinutes);
  }
  if (/(?<![가-힣])(?:작년|지난해)(?![가-힣])/u.test(normalized)) {
    const match = /(?<![가-힣])(작년|지난해)(?![가-힣])/u.exec(normalized)!;
    const targetYear = nowParts.year - 1;
    const start = fromLocalMidnight(targetYear, 1, 1, tzOffsetMinutes);
    const end = fromLocalMidnight(targetYear, 12, 31, tzOffsetMinutes) + MS_PER_DAY - 1;
    return makeRange(start, end, match[0], tzOffsetMinutes);
  }
  if (/(?<![가-힣])재작년(?![가-힣])/u.test(normalized)) {
    const targetYear = nowParts.year - 2;
    const start = fromLocalMidnight(targetYear, 1, 1, tzOffsetMinutes);
    const end = fromLocalMidnight(targetYear, 12, 31, tzOffsetMinutes) + MS_PER_DAY - 1;
    return makeRange(start, end, "재작년", tzOffsetMinutes);
  }

  return null;
}

/**
 * Produce an indexing-only temporal tail summary without altering user-visible `content`.
 */
export function buildTemporalIndexTail(
  text: string,
  referenceMs: number,
  tzOffsetMinutes: number = DEFAULT_KST_OFFSET_MINUTES,
): string {
  const anchorIso = formatLocalIsoDate(referenceMs, tzOffsetMinutes);
  const resolved = parseKoreanTemporalRange(text, referenceMs, tzOffsetMinutes);
  if (!resolved) {
    return `(기준일: ${anchorIso})`;
  }
  const resolvedSpan =
    resolved.startIsoDate === resolved.endIsoDate
      ? resolved.startIsoDate
      : `${resolved.startIsoDate}~${resolved.endIsoDate}`;
  return `(기준일: ${anchorIso} · 시간해석 ${resolved.matchedExpression}=${resolvedSpan})`;
}

/**
 * Score temporal alignment in `[0, 1]` for 4-arm RRF Temporal Arm.
 */
export function computeTemporalProximityScore(
  recordTimeMs: number,
  parsedRange: ParsedTemporalRange | null,
  nowMs: number,
): number {
  if (!Number.isFinite(recordTimeMs) || recordTimeMs <= 0) return 0;
  if (parsedRange !== null) {
    if (recordTimeMs >= parsedRange.startMs && recordTimeMs <= parsedRange.endMs) {
      return 1.0;
    }
    const distanceMs =
      recordTimeMs < parsedRange.startMs
        ? parsedRange.startMs - recordTimeMs
        : recordTimeMs - parsedRange.endMs;
    const distanceDays = distanceMs / MS_PER_DAY;
    return Math.exp(-distanceDays / 7);
  }
  const ageDays = Math.max(0, (nowMs - recordTimeMs) / MS_PER_DAY);
  return 1 / (1 + ageDays / 30);
}
