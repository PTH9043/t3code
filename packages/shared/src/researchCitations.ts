export function researchCitationSegments(
  text: string,
  citations: readonly { readonly start: number; readonly end: number; readonly url: string }[] = [],
) {
  const segments: Array<{ text: string; url?: string; start?: number }> = [];
  let cursor = 0;
  for (const citation of [...citations].toSorted((a, b) => a.start - b.start || a.end - b.end)) {
    if (
      !Number.isInteger(citation.start) ||
      !Number.isInteger(citation.end) ||
      citation.start < cursor ||
      citation.end <= citation.start ||
      citation.end > text.length
    )
      continue;
    try {
      const url = new URL(citation.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    } catch {
      continue;
    }
    if (citation.start > cursor) segments.push({ text: text.slice(cursor, citation.start) });
    segments.push({
      text: text.slice(citation.start, citation.end),
      url: citation.url,
      start: citation.start,
    });
    cursor = citation.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

export function researchCitationMarkers(
  text: string,
  citations: readonly { readonly start: number; readonly end: number; readonly url: string }[] = [],
  sources: readonly string[] = [],
) {
  const markers = new Map<number, Set<string>>();
  for (const citation of citations) {
    if (
      !Number.isInteger(citation.start) ||
      !Number.isInteger(citation.end) ||
      citation.start < 0 ||
      citation.end <= citation.start ||
      citation.end > text.length ||
      !sources.includes(citation.url)
    )
      continue;
    try {
      const url = new URL(citation.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    } catch {
      continue;
    }
    const group = markers.get(citation.end) ?? new Set<string>();
    group.add(citation.url);
    markers.set(citation.end, group);
  }
  let cursor = 0;
  const segments = [...markers]
    .toSorted(([a], [b]) => a - b)
    .map(([end, urls]) => {
      const result = {
        text: text.slice(cursor, end),
        end,
        links: [...urls].map((url) => ({ url, number: sources.indexOf(url) + 1 })),
      };
      cursor = end;
      return result;
    });
  if (cursor < text.length)
    segments.push({ text: text.slice(cursor), end: text.length, links: [] });
  return segments;
}
