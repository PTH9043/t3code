type MemoryEvidence = {
  id: string;
  project_id: string;
  scope: string;
  text: string;
  origin: string;
  verification: string;
  status: string;
  created_at: string;
};
const historicalQuery =
  /과거|이전|당시|언제|연혁|변경\s*이력|작년|재작년|지난|어제|그때|\b(?:history|historical|previous|before|when|20\d{2})\b/iu;
const correction = /정정|이제부터|앞으로|수정한다|대신|\b(?:correction|actually|from now on)\b/iu;
const normalize = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const words = (text: string) =>
  new Set(
    normalize(text)
      .match(/[\p{L}\p{N}_./:-]+/gu)
      ?.slice(0, 256) ?? [],
  );

/** Preserve original text while centering a bounded excerpt on the most query terms. */
export function matchedMemoryExcerpt(
  text: string,
  terms: readonly string[],
  maxChars: number,
): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - 2);
  if (budget === 0) return "";

  let normalized: string;
  let originalOffsets: number[] | undefined;
  let originalEnds: number[] | undefined;
  if (/^[\s\x20-\x7E\uAC00-\uD7A3]*$/u.test(text)) {
    normalized = text.toLowerCase();
  } else {
    normalized = "";
    originalOffsets = [];
    originalEnds = [];
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const { segment, index } of segmenter.segment(text)) {
      const part = segment.normalize("NFKC").toLowerCase();
      normalized += part;
      for (let indexInPart = 0; indexInPart < part.length; indexInPart++) {
        originalOffsets.push(index);
        originalEnds.push(index + segment.length);
      }
    }
  }

  const hits: Array<{ start: number; end: number; term: string }> = [];
  for (const term of new Set(terms)) {
    if (!term) continue;
    let position = normalized.indexOf(term);
    while (position >= 0) {
      hits.push({
        start: originalOffsets?.[position] ?? position,
        end: originalEnds?.[position + term.length - 1] ?? position + term.length,
        term,
      });
      position = normalized.indexOf(term, position + 1);
    }
  }
  const maxStart = text.length - budget;
  const events: Array<{ position: number; term: string; change: 1 | -1 }> = [];
  for (const hit of hits) {
    const first = Math.max(0, hit.end - budget);
    const last = Math.min(hit.start, maxStart);
    if (first > last) continue;
    events.push({ position: first, term: hit.term, change: 1 });
    events.push({ position: last + 1, term: hit.term, change: -1 });
  }
  events.sort((a, b) => a.position - b.position);
  let bestStart = 0;
  let bestEnd = 0;
  let bestCoverage = 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < events.length; ) {
    const position = events[index]!.position;
    while (index < events.length && events[index]!.position === position) {
      const event = events[index++]!;
      const count = (counts.get(event.term) ?? 0) + event.change;
      if (count === 0) counts.delete(event.term);
      else counts.set(event.term, count);
    }
    const intervalEnd = Math.min(maxStart, (events[index]?.position ?? maxStart + 1) - 1);
    if (position <= maxStart && counts.size > bestCoverage) {
      bestCoverage = counts.size;
      bestStart = position;
      bestEnd = intervalEnd;
    } else if (counts.size === bestCoverage && bestEnd + 1 === position) {
      bestEnd = intervalEnd;
    }
  }
  bestStart = Math.floor((bestStart + bestEnd) / 2);
  if (bestStart > 0 && /[\uDC00-\uDFFF]/u.test(text[bestStart] ?? "")) bestStart++;
  let end = Math.min(text.length, bestStart + budget);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
  return `${bestStart > 0 ? "…" : ""}${text.slice(bestStart, end)}${end < text.length ? "…" : ""}`;
}

/** Rank a bounded evidence pool; originals remain addressable and historical queries retain repetitions. */
export function selectMemoryEvidence<A extends MemoryEvidence>(
  rows: readonly A[],
  query: string,
  limit: number,
  now: number,
) {
  const historical = historicalQuery.test(query);
  const unique = new Map<
    string,
    { row: A; rank: number; supportingIds: string[]; additionalSources: number }
  >();
  rows.slice(0, 64).forEach((row, rank) => {
    const key = historical
      ? row.id
      : JSON.stringify([
          row.project_id,
          row.scope,
          row.origin,
          row.verification,
          row.status === "observed" ? "session" : "curated",
          normalize(row.text),
        ]);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, { row, rank, supportingIds: [], additionalSources: 0 });
    } else {
      previous.rank = Math.min(previous.rank, rank);
      previous.additionalSources++;
      if (row.created_at > previous.row.created_at) {
        if (previous.supportingIds.length < 4) previous.supportingIds.push(previous.row.id);
        previous.row = row;
      } else if (previous.supportingIds.length < 4) previous.supportingIds.push(row.id);
    }
  });
  const candidates = [...unique.values()].map((entry) => {
    const timestamp = Date.parse(entry.row.created_at);
    const ageDays = Number.isFinite(timestamp) ? Math.max(0, now - timestamp) / 86_400_000 : 0;
    const recency =
      !historical && entry.row.status === "observed" ? 0.5 + 0.5 * 2 ** (-ageDays / 30) : 1;
    const userStatement = entry.row.origin === "user" || entry.row.origin === "user-requested";
    const authority = userStatement ? 1.25 : 1;
    const corrected = !historical && userStatement && correction.test(entry.row.text) ? 1.15 : 1;
    return {
      ...entry,
      tokens: words(entry.row.text),
      score: (1 / (1 + entry.rank * 0.1)) * recency * authority * corrected,
    };
  });
  const selected: typeof candidates = [];
  while (candidates.length && selected.length < Math.min(limit, 64)) {
    const score = (candidate: (typeof candidates)[number]) => {
      let redundancy = 0;
      for (const previous of selected) {
        let intersection = 0;
        for (const token of candidate.tokens) if (previous.tokens.has(token)) intersection++;
        const union = candidate.tokens.size + previous.tokens.size - intersection;
        redundancy = Math.max(redundancy, union ? intersection / union : 0);
      }
      return 0.7 * candidate.score - 0.3 * redundancy;
    };
    candidates.sort(
      (left, right) =>
        score(right) - score(left) ||
        left.rank - right.rank ||
        left.row.id.localeCompare(right.row.id),
    );
    selected.push(candidates.shift()!);
  }
  return selected.map(({ row, supportingIds, additionalSources }) => ({
    ...row,
    ...(additionalSources ? { supportingIds, additionalSources } : {}),
  }));
}
