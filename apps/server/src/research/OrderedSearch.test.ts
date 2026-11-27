import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  type WorkspaceResearchCall,
  type WorkspaceResearchInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { assessSearchEvidence, runOrderedSearch } from "./OrderedSearch.ts";

const input: WorkspaceResearchInput = {
  query: "What changed in Beacon?",
  requestId: "request",
  projectId: ProjectId.make("project"),
  source: "web",
};
const models = [
  { provider: "xai", model: "a" },
  { provider: "openai", model: "b" },
] as const;
const source = "https://example.org/notes";

it("attaches only the cited English or Korean claim, preserving Markdown and dotted or bracketed URLs", () => {
  const url = "https://docs.example.org/v1.2/notes/[release]";
  for (const [query, fact, price] of [
    ["Beacon launch", "Beacon launched on May 9.", "The price is $99."],
    ["비콘 출시", "비콘은 5월 9일 출시됐습니다.", "가격은 99원입니다."],
  ] as const) {
    for (const link of [url, "[Official v1.2 [release]](" + url + ")"]) {
      const cited = fact + " " + link;
      const complete = (text: string) =>
        assessSearchEvidence({ ...input, query }, call(text, { sources: [url] }));
      expect(complete(cited)).toEqual({ answered: true, text: cited, sources: [url] });
      expect(complete(cited + " " + price)).toEqual({
        answered: false,
        text: cited,
        sources: [url],
      });
    }
    const text = fact + " " + price;
    expect(
      assessSearchEvidence(
        { ...input, query },
        call(text, {
          citations: [{ start: 0, end: fact.length, url: source }],
        }),
      ),
    ).toEqual({ answered: false, text: fact + " " + source, sources: [source] });
    const clause = fact.slice(0, -1);
    const compound = clause + ", " + price;
    expect(
      assessSearchEvidence(
        { ...input, query },
        call(compound, {
          citations: [{ start: 0, end: clause.length, url: source }],
        }),
      ),
    ).toEqual({ answered: false, text: clause + " " + source, sources: [source] });
    expect(
      assessSearchEvidence(
        { ...input, query },
        call(text, {
          citations: [{ start: 0, end: text.length, url: source }],
        }),
      ),
    ).toEqual({ answered: false, text: "", sources: [] });
  }
});

it("retains a qualified finding and a translated native citation as partial evidence", () => {
  const qualified = "Beacon added a checksum, but I could not verify the date. " + source;
  expect(assessSearchEvidence(input, call(qualified))).toEqual({
    answered: false,
    text: qualified,
    sources: [source],
  });
  const translated = "체크섬 검사가 추가되었습니다.";
  expect(
    assessSearchEvidence(
      input,
      call(translated, {
        citations: [{ start: 0, end: translated.length, url: source }],
      }),
    ),
  ).toEqual({ answered: false, text: translated + " " + source, sources: [source] });
});
function call(text: string, overrides: Partial<WorkspaceResearchCall> = {}): WorkspaceResearchCall {
  return {
    ...input,
    text,
    sources: [source],
    responseId: "answer",
    kind: "research",
    status: "complete",
    createdAt: "2026-01-01T00:00:00Z",
    day: "2026-01-01",
    costTicks: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    itemId: null,
    message: null,
    ...overrides,
  };
}

it("requires linked topical evidence and excludes bibliography-only, unrelated and out-of-scope URLs", () => {
  for (const text of [
    source,
    "Beacon changed.\nSources: " + source,
    "See [Beacon changelog](" + source + ")",
    "Lighthouse acquired a lens. " + source,
    "Beacon changed. " + source + "/unreported",
  ]) {
    expect(assessSearchEvidence(input, call(text))).toMatchObject({
      answered: false,
      text: "",
      sources: [],
    });
  }
  const text = "Beacon added a checksum.";
  const result = call(text, { citations: [{ start: 0, end: text.length, url: source }] });
  expect(assessSearchEvidence(input, result)).toEqual({
    answered: true,
    text: text + " " + source,
    sources: [source],
  });
  expect(assessSearchEvidence({ ...input, allowedDomains: ["other.org"] }, result).sources).toEqual(
    [],
  );
  expect(assessSearchEvidence({ ...input, source: "x" }, result).sources).toEqual([]);
});

it.effect(
  "does not return display-only text, suggestions or sources even if a candidate returns them",
  () =>
    Effect.gen(function* () {
      const result = yield* runOrderedSearch(input, models, () =>
        Effect.succeed(
          call("private display only", {
            displayOnly: true,
            searchSuggestionsHtml: "<p>private</p>",
          }),
        ),
      );
      expect(result.status).toBe("search-directly");
      expect(result.text).toBe("");
      expect(result.sources).toEqual([]);
      expect(result.attempts.map((a) => a.result)).toEqual(["unavailable", "unavailable"]);
    }),
);

it.effect("interrupts the active attempt without launching the next model", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const attempted: string[] = [];
    const fiber = yield* runOrderedSearch(input, models, (_input, candidate) =>
      Effect.gen(function* () {
        attempted.push(candidate.model);
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(attempted).toEqual(["a"]);
  }),
);
