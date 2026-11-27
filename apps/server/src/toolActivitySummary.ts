import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import {
  TOOL_ACTIVITY_SUMMARY_MODELS,
  ToolActivitySummaryFact,
  type ToolActivitySummaryInput,
  type ToolActivitySummaryResult,
} from "@t3tools/contracts";
import { selectToolActivitySummaryFamily } from "@t3tools/shared/toolActivity";
import * as Schema from "effect/Schema";

export const factualToolActivitySummary = { summary: null, model: null } as const;

type LocalPost = (
  path: "/api/show" | "/api/generate",
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

// The native HTTP layer owns a direct agent and returns redirects to filterStatusOk.
// It does not inherit a proxy, an account, or the configurable embedding endpoint.
const postLocalOllama: LocalPost = (path, body, signal) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const req = yield* HttpClientRequest.post(`http://127.0.0.1:11434${path}`).pipe(
        HttpClientRequest.bodyJson(body),
      );
      const response = yield* http
        .execute(req)
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      return yield* response.json;
    }).pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(1024 * 1024)),
      Effect.provide(NodeHttpClient.layerNodeHttp),
    ),
    { signal },
  );

const localModel = Schema.Struct({
  capabilities: Schema.Array(Schema.String),
  details: Schema.Struct({
    format: Schema.Literal("gguf"),
    remote_model: Schema.optionalKey(Schema.Never),
    remote_host: Schema.optionalKey(Schema.Never),
  }),
  model_info: Schema.Struct({
    "general.parameter_count": Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  remote_model: Schema.optionalKey(Schema.Never),
  remote_host: Schema.optionalKey(Schema.Never),
});

const generation = Schema.Struct({
  model: Schema.String,
  done: Schema.Literal(true),
  done_reason: Schema.optionalKey(Schema.Literal("stop")),
  response: Schema.String,
});
const line = Schema.Struct({ summary: Schema.String.check(Schema.isMaxLength(240)) });
// Neither description uses the command, its output, or a path.
const operations = {
  read: ["파일에 어떤 내용이 있는지 살펴보는", "파일 읽기"],
  search: ["자료에서 필요한 내용을 찾는", "자료에 찾는 내용이 있는지 확인하는"],
  list: ["목록에 어떤 항목이 있는지 확인하는", "목록에 포함된 항목을 살펴보는"],
  edit: ["기존 내용을 바꾸려는", "편집을 적용하려는"],
  command: ["요청된 명령을 실행하는", "전달된 명령을 처리하는"],
  other: ["도구에 요청을 전달하는", "요청된 도구를 실행하는"],
} as const;

const subjects = {
  diff: ["기존 내용과 변경 내용을 비교하는", "변경 전후의 차이를 살펴보는"],
  test: ["테스트를 실행해 동작을 점검하는", "테스트로 동작을 확인하는"],
  "read-search": [
    "문서나 소스의 내용을 읽고 필요한 문구를 찾는",
    "파일 내용을 읽으며 찾는 표현이 있는지 살펴보는",
  ],
  "database-read": [
    "저장된 자료를 읽기 전용으로 조회하는",
    "데이터베이스의 내용을 읽기 전용으로 살펴보는",
  ],
  "repository-status": [
    "저장소에 어떤 변경이 있는지 살펴보는",
    "저장소의 현재 변경 상태를 확인하는",
  ],
  "history-fetch": ["원격 변경 이력을 가져오려는", "원격 저장소에서 변경 기록을 받아오려는"],
  "history-read": ["저장소의 최근 변경 기록을 살펴보는", "최근에 어떤 변경이 기록됐는지 조회하는"],
  "history-fetch-read": [
    "원격 변경 이력 가져오기와 최근 기록 조회를 시도하는",
    "원격 이력을 가져와 최근 변경 기록을 살펴보려는",
  ],
} as const;

const phases = {
  started: ["시작됐습니다", "시작됐으며"],
  running: ["진행 중입니다", "진행 중이며"],
  completed: ["끝났습니다", "끝났으며"],
  failed: ["실패했습니다", "실패했으며"],
  stopped: ["중단됐습니다", "중단됐으며"],
  declined: ["거절됐습니다", "거절됐으며"],
} as const;

// Constrain decoding and validate the reply against the same fact-specific choices.
// A compound command's recorded outcome applies only to the command as a whole.
function summaryChoices(fact: ToolActivitySummaryFact): string[] {
  const purposes = fact.subject ? subjects[fact.subject] : operations[fact.action];
  const unit = fact.compound ? "동작을 포함한 복합 명령" : fact.subject ? "명령" : "작업";
  const count = fact.targetCount > 0 ? `대상 ${fact.targetCount}개에 대해 ` : "";
  const [ended, linked] = phases[fact.phase];
  return purposes.map((purpose) => {
    const description = `${count}${purpose} ${unit}`;
    const subject = description + (fact.phase === "declined" ? " 요청이" : "이");
    if (fact.evidence === "confirmed-diff" && fact.confirmedDiffCount > 0) {
      return `${subject} ${linked} 실제 변경 차이가 확인된 대상은 ${fact.confirmedDiffCount}개입니다.`;
    }
    if (fact.evidence === "planned") {
      return `${subject} ${linked} 변경 적용 여부는 확인되지 않았습니다.`;
    }
    if (
      fact.evidence === "tool-reported" &&
      fact.action === "edit" &&
      fact.phase === "completed" &&
      !fact.compound
    ) {
      return `도구는 ${description}을 마쳤다고 보고했습니다.`;
    }
    return `${subject} ${ended}.`;
  });
}

const decodeFact = Schema.decodeUnknownSync(ToolActivitySummaryFact);
const decodeShow = Schema.decodeUnknownSync(localModel);
const decodeGeneration = Schema.decodeUnknownSync(generation);
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(line));

async function generate(
  activityId: string,
  fact: ToolActivitySummaryFact,
  post: LocalPost,
): Promise<ToolActivitySummaryResult> {
  const model = TOOL_ACTIVITY_SUMMARY_MODELS[selectToolActivitySummaryFamily(fact, activityId)];
  const signal = AbortSignal.timeout(120_000);
  const installed = decodeShow(await post("/api/show", { model }, signal));
  if (!installed.capabilities.includes("completion")) return factualToolActivitySummary;
  const choices = summaryChoices(fact);
  const result = decodeGeneration(
    await post(
      "/api/generate",
      {
        model,
        system:
          "정제된 사실에 맞게 무엇을 확인하려 했고 어떤 상태인지 가장 구체적으로 알려 주는 한국어 표현 하나를 고르세요. 후보 문장을 바꾸지 말고 JSON의 summary로 반환하세요.\n" +
          choices.join("\n"),
        prompt: JSON.stringify(fact),
        stream: false,
        format: {
          type: "object",
          properties: { summary: { type: "string", enum: choices } },
          required: ["summary"],
          additionalProperties: false,
        },
      },
      signal,
    ),
  );
  if (result.model !== model) return factualToolActivitySummary;
  const summary = decodeLine(result.response).summary;
  if (!choices.includes(summary)) return factualToolActivitySummary;
  return { model, summary };
}

type Entry = { result: Promise<ToolActivitySummaryResult>; active: boolean };

export function makeToolActivitySummarizer(post: LocalPost = postLocalOllama) {
  const recent = new Map<string, Entry>();
  let active = 0;
  return async (input: ToolActivitySummaryInput): Promise<ToolActivitySummaryResult> => {
    let fact: ToolActivitySummaryFact;
    try {
      // Struct decoding strips surplus properties even for in-process callers.
      fact = decodeFact(input.fact);
    } catch {
      return factualToolActivitySummary;
    }
    const key = JSON.stringify([input.threadId, input.activityId, fact]);
    const prior = recent.get(key);
    if (prior) return prior.result;
    if (active >= 2) return factualToolActivitySummary;
    if (recent.size >= 256) {
      for (const [oldKey, entry] of recent) {
        if (!entry.active) {
          recent.delete(oldKey);
          break;
        }
      }
    }
    active++;
    const result = generate(input.activityId, fact, post).catch(() => factualToolActivitySummary);
    const entry: Entry = { result, active: true };
    recent.set(key, entry);
    try {
      const answer = await result;
      if (answer.summary === null) recent.delete(key);
      return answer;
    } finally {
      active--;
      entry.active = false;
    }
  };
}
