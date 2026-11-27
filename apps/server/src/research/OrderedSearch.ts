// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  WorkspaceResearchError,
  type WorkspaceResearchCall,
  type WorkspaceResearchInput,
  type WorkspaceSearchModel,
  type WorkspaceSearchOutcome,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export class SearchCandidateUnavailable extends WorkspaceResearchError {
  readonly orderedFailure = "unavailable";
}
export class SearchCandidateInsufficient extends WorkspaceResearchError {
  readonly orderedFailure = "insufficient";
}
export function candidateFailure(error: WorkspaceResearchError) {
  if (
    "orderedFailure" in error &&
    (error.orderedFailure === "unavailable" || error.orderedFailure === "insufficient")
  )
    return error.orderedFailure;
  return undefined;
}
const encodeId = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
function attemptRequestId(requestId: string, candidate: WorkspaceSearchModel) {
  const { provider, model, apiInstanceId } = candidate;
  return (
    "ordered-" +
    NodeCrypto.createHash("sha256")
      .update(encodeId([requestId, provider, model, apiInstanceId ?? ""]))
      .digest("hex")
  );
}

// Check native refusal fields before adapters discard them while extracting visible text.
function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
export function nativeSearchRefused(value: unknown) {
  const raw = fields(value);
  if (raw.stop_reason === "refusal" || fields(raw.incomplete_details).reason === "content_filter")
    return true;
  if (
    Array.isArray(raw.choices) &&
    raw.choices.some(
      (choice) =>
        fields(choice).finish_reason === "content_filter" ||
        Boolean(fields(fields(choice).message).refusal),
    )
  )
    return true;
  return (
    Array.isArray(raw.output) &&
    raw.output.some((item) => {
      const content = fields(item).content;
      return Array.isArray(content) && content.some((part) => fields(part).type === "refusal");
    })
  );
}

export function nativeSearchTruncated(value: unknown) {
  const raw = fields(value);
  return (
    raw.stop_reason === "max_tokens" ||
    fields(raw.incomplete_details).reason === "max_output_tokens" ||
    (Array.isArray(raw.choices) && fields(raw.choices[0]).finish_reason === "length")
  );
}

export const orderedSearchInstructions =
  "답변에서 각 핵심 주장 바로 옆에 그 주장을 뒷받침하는 실제 검색 출처 URL을 인용하세요. 질문의 일부만 확인했거나 근거가 부족하면 SEARCH_INSUFFICIENT를 표시하고 확인된 부분만 출처와 함께 작성하세요. 권한 또는 안전 정책으로 요청을 거절하면 SEARCH_REFUSED를 표시하세요.";

const insufficient =
  /SEARCH_INSUFFICIENT|\b(?:insufficient (?:information|evidence|sources)|(?:could not|couldn't|unable to|cannot) (?:verify|confirm|find|determine)|no (?:reliable|relevant|credible|supporting) (?:evidence|sources))\b|(?:출처|자료|근거|정보)(?:가|는|를|이)?\s*(?:부족|불충분|없)|(?:확인|검증|찾을|답할)(?:할)?\s*수\s*없/iu;
const policyRefusal =
  /SEARCH_REFUSED|\b(?:cannot|can['’]t|unable to)\s+(?:comply with|assist(?: you)? with|help(?: you)? with)\b|\b(?:not (?:permitted|authorized|allowed) to|violates? (?:our|my) (?:safety|content) polic)|(?:안전|정책|권한).{0,35}(?:허용되지 않|할 수 없|차단)|도와드릴 수 없/iu;
const generic = new Set(
  "a an and are as at be by can do does did for from how i in is it of on or that the this to what when where which who why will with would please search find tell about information source sources according reference references official evidence confirmed 검색 조사 알려줘 대한 관련 공식 문서 출처 참고 결과 확인 자료 정보".split(
    " ",
  ),
);

function terms(text: string) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((word) =>
      word.replace(/(?<=[가-힣])(?:에서는|에서|으로|에는|은|는|이|가|을|를|의|에)$/u, ""),
    )
    .filter((word) => !generic.has(word));
}

function permittedSource(value: string, input: WorkspaceResearchInput): boolean {
  const url = URL.parse(value);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password)
    return false;
  const host = url.hostname.toLowerCase();
  const isX = ["x.com", "twitter.com"].some(
    (domain) => host === domain || host.endsWith("." + domain),
  );
  if (isX && input.source !== "web") {
    return (
      !input.allowedHandles?.length ||
      input.allowedHandles.some(
        (handle) => url.pathname.split("/")[1]?.toLowerCase() === handle.toLowerCase(),
      )
    );
  }
  return (
    input.source !== "x" &&
    (!input.allowedDomains?.length ||
      input.allowedDomains.some(
        (domain) => host === domain.toLowerCase() || host.endsWith("." + domain.toLowerCase()),
      ))
  );
}

// Keep UTF-16 offsets aligned with provider citations while masking punctuation inside links.
function* searchClaims(text: string, citations: NonNullable<WorkspaceResearchCall["citations"]>) {
  for (const row of text.matchAll(/[^\r\n]+/gu)) {
    const line = row[0];
    const links: Array<{ start: number; end: number; url: string | undefined }> = [];
    const chunks: string[] = [];
    let cursor = 0;
    const pattern = /(?:\[(?:[^[\]]|\[[^[\]]*\])*\]\(\s*)?<?(https?:\/\/[^\s<>"。！？]+)/gu;
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      const raw = match[1]!;
      const urlStart = match.index + match[0].length - raw.length;
      let length = 0;
      const closing: string[] = [];
      for (const char of raw) {
        if (char === "(" || char === "[") closing.push(char === "(" ? ")" : "]");
        if ((char === ")" || char === "]") && closing.pop() !== char) break;
        length += char.length;
      }
      const address = raw.slice(0, length).replace(/[.,;:!?]+$/u, "");
      let end = urlStart + address.length;
      if (line[end] === ">") end++;
      if (match[0].startsWith("[") && line[end] === ")") end++;
      links.push({ start: match.index, end, url: URL.parse(address)?.href });
      chunks.push(line.slice(cursor, match.index), " ".repeat(end - match.index));
      cursor = end;
      pattern.lastIndex = end;
    }
    chunks.push(line.slice(cursor));
    const masked = chunks.join("").replace(/\[\d+\]/gu, (marker) => " ".repeat(marker.length));
    const ends = new Set<number>([line.length]);
    for (const stop of masked.matchAll(
      /(?:[.!?]+(?=["'”’)\]]*(?:\s|\p{Script=Hangul}|$))|[。！？;；]+)["'”’)\]]*\s*/gu,
    ))
      ends.add(stop.index + stop[0].length);
    // A citation before more prose cannot vouch for the continuation of the sentence.
    const firstWord = masked.search(/[\p{L}\p{N}]/u);
    const citationEnds = [
      ...links.map((link) => link.end),
      ...citations
        .filter(
          (citation) => citation.start >= row.index && citation.end <= row.index + line.length,
        )
        .map((citation) => citation.end - row.index),
    ];
    for (const offset of citationEnds) {
      if (
        firstWord >= 0 &&
        firstWord < offset &&
        /^\s*[,，:：—–-]?\s*[\p{L}\p{N}$₩€£]/u.test(masked.slice(offset))
      )
        ends.add(offset);
    }
    let start = 0;
    let nextLink = 0;
    for (const end of [...ends].sort((left, right) => left - right)) {
      const inline: (string | undefined)[] = [];
      while (nextLink < links.length && links[nextLink]!.start < end)
        inline.push(links[nextLink++]!.url);
      yield {
        text: line.slice(start, end).trim(),
        body: masked.slice(start, end).trim(),
        start: row.index + start,
        end: row.index + end,
        inline,
      };
      start = end;
    }
  }
}

// Each returned claim must have its own source.
export function assessSearchEvidence(input: WorkspaceResearchInput, record: WorkspaceResearchCall) {
  const passages: string[] = [];
  const sources = new Set<string>();
  let unsupported = false;
  if (record.displayOnly || record.status !== "complete")
    return { answered: false, text: "", sources: [] };
  const queryTerms = new Set(terms(input.query));
  const explicitlyInsufficient = insufficient.test(record.text);
  const permitted = record.sources.filter((url) => permittedSource(url, input));
  for (const claim of searchClaims(record.text, record.citations ?? [])) {
    const { text: line, inline } = claim;
    if (/^\s*#|[:：]\s*$/u.test(line)) continue;
    if (inline.some((url) => !url || !permitted.includes(url))) {
      unsupported = true;
      continue;
    }
    const urls = new Set(permitted.filter((url) => inline.includes(url)));
    let nativeCitation = false;
    for (const citation of record.citations ?? []) {
      if (
        citation.start < claim.start ||
        citation.end > claim.end ||
        citation.end <= citation.start ||
        !permitted.includes(citation.url)
      )
        continue;
      urls.add(citation.url);
      nativeCitation = true;
    }
    const body = claim.body.replace(/SEARCH_INSUFFICIENT/gu, "").trim();
    const words = terms(body);
    if (!words.length || /[?？]\s*$/u.test(body)) continue;
    if (!urls.size) {
      unsupported = true;
      continue;
    }
    if (!words.some((word) => !queryTerms.has(word))) continue;
    if (!words.some((word) => queryTerms.has(word))) {
      if (!nativeCitation && !explicitlyInsufficient) continue;
      // A translated or indirect citation can still be checked by the caller.
      unsupported = true;
    }
    for (const url of urls) sources.add(url);
    passages.push([line.trim(), ...[...urls].filter((url) => !line.includes(url))].join(" "));
  }
  return {
    answered: passages.length > 0 && !unsupported && !explicitlyInsufficient,
    text: passages.join("\n"),
    sources: [...sources],
  };
}

export function searchResponseRefused(text: string) {
  return policyRefusal.test(text);
}

type Attempt = WorkspaceSearchOutcome["attempts"][number];
type RunCandidate = (
  input: WorkspaceResearchInput,
  candidate: WorkspaceSearchModel,
  legacyRequestId?: string,
) => Effect.Effect<WorkspaceResearchCall, WorkspaceResearchError>;

export const runOrderedSearch = Effect.fn("runOrderedSearch")(function* (
  input: WorkspaceResearchInput,
  models: readonly WorkspaceSearchModel[],
  run: RunCandidate,
): Effect.fn.Return<WorkspaceSearchOutcome, WorkspaceResearchError> {
  const attempts: Attempt[] = [];
  const partial = new Set<string>();
  const sources = new Set<string>();
  const seen = new Set<string>();
  for (const candidate of models) {
    const requestId = attemptRequestId(input.requestId, candidate);
    if (seen.has(requestId)) continue;
    seen.add(requestId);
    const { provider, model, apiInstanceId } = candidate;
    const attempt = { provider, model };
    if (
      provider === "gemini" ||
      ((provider === "custom" || provider === "baidu" || provider === "openrouter") &&
        !apiInstanceId)
    ) {
      attempts.push({
        ...attempt,
        result: "unavailable",
        message:
          provider === "gemini"
            ? "Google 표시 전용 검색 결과는 자동 조사에 사용할 수 없습니다."
            : "검색할 API 계정을 지정하세요.",
      });
      continue;
    }
    const result = yield* Effect.result(
      run(
        {
          projectId: input.projectId,
          query: input.query,
          requestId,
          source: input.source,
          provider: provider === "baidu" || provider === "openrouter" ? "custom" : provider,
          model,
          ...(apiInstanceId ? { apiInstanceId } : {}),
          ...(provider === "custom" || provider === "baidu" || provider === "openrouter"
            ? { customMode: "search" as const }
            : {}),
          ...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}),
          ...(input.allowedHandles ? { allowedHandles: input.allowedHandles } : {}),
          ...(input.fromDate ? { fromDate: input.fromDate } : {}),
          ...(input.toDate ? { toDate: input.toDate } : {}),
          ...(input.followUpId ? { followUpId: input.followUpId } : {}),
        },
        candidate,
        provider === "baidu" || provider === "openrouter"
          ? attemptRequestId(input.requestId, { ...candidate, provider: "custom" })
          : undefined,
      ),
    );
    if (Result.isFailure(result)) {
      const failure = candidateFailure(result.failure);
      if (!failure) return yield* result.failure;
      attempts.push({ ...attempt, result: failure, message: result.failure.message });
      continue;
    }
    const call = result.success;
    if (call.displayOnly) {
      attempts.push({ ...attempt, result: "unavailable", message: "화면 전용 응답입니다." });
      continue;
    }
    if (searchResponseRefused(call.text))
      return yield* new WorkspaceResearchError({
        message: "제공자가 요청을 거절하여 순차 검색을 중단했습니다.",
      });
    const evidence = assessSearchEvidence(input, call);
    attempts.push({
      ...attempt,
      result: evidence.answered ? "answered" : "insufficient",
      message: evidence.answered
        ? "질문과 관련된 출처 인용을 확인했습니다."
        : "답을 뒷받침하는 출처와 본문이 충분하지 않습니다.",
    });
    if (evidence.answered)
      return { status: "answered", attempts, text: evidence.text, sources: evidence.sources };
    if (evidence.text) partial.add(evidence.text);
    for (const url of evidence.sources) sources.add(url);
  }
  return {
    status: "search-directly",
    attempts,
    text: [...partial].join("\n\n"),
    sources: [...sources],
  };
});
