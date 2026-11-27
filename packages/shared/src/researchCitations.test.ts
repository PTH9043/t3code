import { describe, expect, it } from "vite-plus/test";
import { researchCitationMarkers, researchCitationSegments } from "./researchCitations.ts";

describe("researchCitationSegments", () => {
  it("keeps the original text while linking valid non-overlapping citations", () => {
    const segments = researchCitationSegments("A source B", [
      { start: 2, end: 8, url: "https://example.com" },
      { start: 3, end: 5, url: "https://overlap.example" },
      { start: 9, end: 10, url: "javascript:alert(1)" },
    ]);
    expect(segments).toEqual([
      { text: "A " },
      { text: "source", url: "https://example.com", start: 2 },
      { text: " B" },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe("A source B");
  });
});

it("places every distinct source at the cited position without changing the report text", () => {
  const text = "한글 문장. 다음 문장.";
  const sources = ["https://example.org/one", "https://example.org/two", "javascript:alert(1)"];
  const segments = researchCitationMarkers(
    text,
    [
      { start: 0, end: 6, url: sources[0]! },
      { start: 0, end: 6, url: sources[1]! },
      { start: 0, end: 6, url: sources[1]! },
      { start: 7, end: text.length, url: sources[0]! },
      { start: 1, end: 2, url: "javascript:alert(1)" },
    ],
    sources,
  );
  expect(segments.map((part) => part.text).join("")).toBe(text);
  expect(segments[0]?.links).toEqual([
    { url: sources[0], number: 1 },
    { url: sources[1], number: 2 },
  ]);
  expect(segments[1]?.links).toEqual([{ url: sources[0], number: 1 }]);
});
