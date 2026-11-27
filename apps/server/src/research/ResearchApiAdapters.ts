import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { NonNegativeInt, type WorkspaceResearchInput } from "@t3tools/contracts";

const ClaudeResponse = Schema.Struct({
  id: Schema.String,
  stop_reason: Schema.NullOr(Schema.String),
  content: Schema.Array(Schema.Unknown),
  usage: Schema.optionalKey(
    Schema.Struct({
      input_tokens: Schema.optionalKey(NonNegativeInt),
      output_tokens: Schema.optionalKey(NonNegativeInt),
      cache_read_input_tokens: Schema.optionalKey(NonNegativeInt),
    }),
  ),
});
const ClaudeText = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  citations: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
const ClaudeCitation = Schema.Struct({
  type: Schema.Literal("web_search_result_location"),
  url: Schema.String,
});
const ClaudeToolError = Schema.Struct({
  type: Schema.Literal("web_search_tool_result"),
  content: Schema.Struct({ type: Schema.Literal("web_search_tool_result_error") }),
});
const HistoryMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
});
const HistoryOutput = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.optionalKey(Schema.String),
  content: Schema.Array(
    Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String }),
  ),
});
const GeminiResponse = Schema.Struct({
  responseId: Schema.optionalKey(Schema.String),
  candidates: Schema.Array(
    Schema.Struct({
      finishReason: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(
        Schema.Struct({
          parts: Schema.Array(
            Schema.Struct({
              text: Schema.optionalKey(Schema.String),
              thought: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        }),
      ),
      groundingMetadata: Schema.optionalKey(
        Schema.Struct({
          searchEntryPoint: Schema.optionalKey(
            Schema.Struct({ renderedContent: Schema.optionalKey(Schema.String) }),
          ),
          groundingChunks: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({ web: Schema.optionalKey(Schema.Struct({ uri: Schema.String })) }),
            ),
          ),
          groundingSupports: Schema.optionalKey(Schema.Array(Schema.Unknown)),
        }),
      ),
    }),
  ),
  usageMetadata: Schema.optionalKey(
    Schema.Struct({
      promptTokenCount: Schema.optionalKey(NonNegativeInt),
      candidatesTokenCount: Schema.optionalKey(NonNegativeInt),
      cachedContentTokenCount: Schema.optionalKey(NonNegativeInt),
    }),
  ),
});
const ChatCompletion = Schema.Struct({
  id: Schema.String,
  choices: Schema.Array(
    Schema.Struct({
      finish_reason: Schema.NullOr(Schema.String),
      message: Schema.Struct({
        content: Schema.NullOr(Schema.String),
        annotations: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      }),
    }),
  ),
  citations: Schema.optionalKey(Schema.Array(Schema.String)),
  search_results: Schema.optionalKey(Schema.Array(Schema.Struct({ url: Schema.String }))),
  usage: Schema.optionalKey(
    Schema.Struct({
      prompt_tokens: Schema.optionalKey(NonNegativeInt),
      completion_tokens: Schema.optionalKey(NonNegativeInt),
      prompt_tokens_details: Schema.optionalKey(
        Schema.Struct({ cached_tokens: Schema.optionalKey(NonNegativeInt) }),
      ),
    }),
  ),
});
const decodeClaudeResponse = Schema.decodeUnknownSync(ClaudeResponse);
const decodeClaudeText = Schema.decodeUnknownOption(ClaudeText);
const decodeClaudeCitation = Schema.decodeUnknownOption(ClaudeCitation);
const decodeClaudeToolError = Schema.decodeUnknownOption(ClaudeToolError);
const decodeHistoryMessage = Schema.decodeUnknownOption(HistoryMessage);
const decodeHistoryOutput = Schema.decodeUnknownOption(HistoryOutput);
const decodeGeminiResponse = Schema.decodeUnknownSync(GeminiResponse);
const decodeGroundingSupport = Schema.decodeUnknownOption(
  Schema.Struct({
    segment: Schema.Struct({
      partIndex: Schema.optionalKey(NonNegativeInt),
      startIndex: Schema.optionalKey(NonNegativeInt),
      endIndex: NonNegativeInt,
      text: Schema.optionalKey(Schema.String),
    }),
    groundingChunkIndices: Schema.Array(NonNegativeInt),
  }),
);
const decodeChatCompletion = Schema.decodeUnknownSync(ChatCompletion);
const decodeNestedUrlCitation = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("url_citation"),
    url_citation: Schema.Struct({
      url: Schema.String,
      start_index: Schema.optionalKey(NonNegativeInt),
      end_index: Schema.optionalKey(NonNegativeInt),
    }),
  }),
);
const decodeFlatUrlCitation = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("url_citation"),
    url: Schema.String,
    start_index: Schema.optionalKey(NonNegativeInt),
    end_index: Schema.optionalKey(NonNegativeInt),
  }),
);
const decodeCustomHistoryMessage = Schema.decodeUnknownOption(
  Schema.Struct({ role: Schema.Literals(["system", "user", "assistant"]), content: Schema.String }),
);

export function anthropicResearchRequest(input: {
  model: string;
  history: readonly unknown[];
  instructions: string;
  allowedDomains: WorkspaceResearchInput["allowedDomains"];
}) {
  const messages = input.history.flatMap((item) => {
    const message = decodeHistoryMessage(item);
    if (Option.isSome(message)) return [message.value];
    const output = decodeHistoryOutput(item);
    return Option.isSome(output)
      ? [
          {
            role: "assistant" as const,
            content: output.value.content.map((part) => part.text).join("\n"),
          },
        ]
      : [];
  });
  return {
    model: input.model,
    system: input.instructions,
    max_tokens: 4000,
    messages,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        ...(input.allowedDomains?.length ? { allowed_domains: input.allowedDomains } : {}),
      },
    ],
  };
}

export function anthropicResearchResponse(value: unknown, includeCitationSpans = false) {
  const parsed = decodeClaudeResponse(value);
  const text: string[] = [];
  const annotations: {
    type: "url_citation";
    url: string;
    start_index?: number;
    end_index?: number;
  }[] = [];
  let offset = 0;
  let toolError = false;
  for (const item of parsed.content) {
    if (Option.isSome(decodeClaudeToolError(item))) toolError = true;
    const part = decodeClaudeText(item);
    if (Option.isNone(part)) continue;
    text.push(part.value.text);
    for (const raw of part.value.citations ?? []) {
      const citation = decodeClaudeCitation(raw);
      if (Option.isSome(citation))
        annotations.push({
          type: "url_citation",
          url: citation.value.url,
          ...(includeCitationSpans
            ? { start_index: offset, end_index: offset + part.value.text.length }
            : {}),
        });
    }
    offset += part.value.text.length + 1;
  }
  return {
    id: parsed.id,
    status: parsed.stop_reason === "end_turn" && !toolError ? "completed" : "incomplete",
    usage: {
      ...(parsed.usage?.input_tokens !== undefined
        ? { input_tokens: parsed.usage.input_tokens }
        : {}),
      ...(parsed.usage?.output_tokens !== undefined
        ? { output_tokens: parsed.usage.output_tokens }
        : {}),
      ...(parsed.usage?.cache_read_input_tokens !== undefined
        ? { input_tokens_details: { cached_tokens: parsed.usage.cache_read_input_tokens } }
        : {}),
    },
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: text.join("\n"), annotations }],
      },
    ],
  };
}

export function geminiResearchRequest(input: {
  history: readonly unknown[];
  instructions: string;
  google: boolean;
}) {
  const contents = input.history.flatMap((item) => {
    const message = decodeHistoryMessage(item);
    return Option.isSome(message)
      ? [
          {
            role: message.value.role === "assistant" ? "model" : "user",
            parts: [{ text: message.value.content }],
          },
        ]
      : [];
  });
  return {
    system_instruction: { parts: [{ text: input.instructions }] },
    contents,
    ...(input.google ? { tools: [{ google_search: {} }] } : {}),
  };
}

export function geminiResearchResponse(value: unknown, fallbackId: string, google: boolean) {
  const parsed = decodeGeminiResponse(value);
  const candidate = parsed.candidates[0];
  const text =
    candidate?.content?.parts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? "")
      .join("") ?? "";
  const suggestions = candidate?.groundingMetadata?.searchEntryPoint?.renderedContent;
  const urls =
    candidate?.groundingMetadata?.groundingChunks?.flatMap((chunk) =>
      chunk.web ? [chunk.web.uri] : [],
    ) ?? [];
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const parts = candidate?.content?.parts ?? [];
  let offset = 0;
  const partOffsets = parts.map((part) => {
    const start = offset;
    if (part.thought || !part.text) return undefined;
    offset += part.text.length;
    const boundaries = new Map<number, number>([[0, 0]]);
    let bytes = 0;
    let codeUnits = 0;
    for (const char of part.text) {
      const codePoint = char.codePointAt(0)!;
      bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      codeUnits += char.length;
      boundaries.set(bytes, codeUnits);
    }
    return { start, text: part.text, boundaries };
  });
  const annotations = urls.map((url) => ({ type: "url_citation" as const, url }));
  const inline = (candidate?.groundingMetadata?.groundingSupports ?? []).flatMap((raw) => {
    const support = decodeGroundingSupport(raw);
    if (Option.isNone(support)) return [];
    const { segment, groundingChunkIndices } = support.value;
    const part = partOffsets[segment.partIndex ?? 0];
    const start = part?.boundaries.get(segment.startIndex ?? 0);
    const end = part?.boundaries.get(segment.endIndex);
    if (!part || start === undefined || end === undefined || start >= end) return [];
    if (segment.text !== undefined && part.text.slice(start, end) !== segment.text) return [];
    return groundingChunkIndices.flatMap((index) => {
      const url = chunks[index]?.web?.uri;
      return url
        ? [
            {
              type: "url_citation" as const,
              url,
              start_index: part.start + start,
              end_index: part.start + end,
            },
          ]
        : [];
    });
  });
  const completed =
    candidate?.finishReason === "STOP" &&
    text.length > 0 &&
    (!google ||
      Boolean(
        text.length <= 60_000 && suggestions && suggestions.length <= 100_000 && urls.length,
      ));
  return {
    id: parsed.responseId ?? fallbackId,
    status: completed ? "completed" : "incomplete",
    usage: {
      ...(parsed.usageMetadata?.promptTokenCount !== undefined
        ? { input_tokens: parsed.usageMetadata.promptTokenCount }
        : {}),
      ...(parsed.usageMetadata?.candidatesTokenCount !== undefined
        ? { output_tokens: parsed.usageMetadata.candidatesTokenCount }
        : {}),
      ...(parsed.usageMetadata?.cachedContentTokenCount !== undefined
        ? { input_tokens_details: { cached_tokens: parsed.usageMetadata.cachedContentTokenCount } }
        : {}),
    },
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: [...annotations, ...inline],
          },
        ],
      },
    ],
    ...(suggestions ? { searchSuggestionsHtml: suggestions } : {}),
  };
}

export function customChatRequest(model: string, history: readonly unknown[], search: boolean) {
  return {
    model,
    messages: history.flatMap((item) => {
      const message = decodeCustomHistoryMessage(item);
      return Option.isSome(message) ? [message.value] : [];
    }),
    ...(search ? { web_search_options: {} } : {}),
  };
}

export function customChatResponse(value: unknown) {
  const parsed = decodeChatCompletion(value);
  const first = parsed.choices[0];
  const citations: Array<{
    type: "url_citation";
    url: string;
    start_index?: number;
    end_index?: number;
  }> = [
    ...(parsed.citations ?? []),
    ...(parsed.search_results?.map((result) => result.url) ?? []),
  ].map((url) => ({ type: "url_citation" as const, url }));
  for (const raw of first?.message.annotations ?? []) {
    const flat = decodeFlatUrlCitation(raw);
    const nested = decodeNestedUrlCitation(raw);
    if (Option.isSome(flat)) citations.push(flat.value);
    else if (Option.isSome(nested))
      citations.push({ type: "url_citation", ...nested.value.url_citation });
  }
  return {
    id: parsed.id,
    status: first?.finish_reason === "stop" ? "completed" : "incomplete",
    usage: {
      ...(parsed.usage?.prompt_tokens !== undefined
        ? { input_tokens: parsed.usage.prompt_tokens }
        : {}),
      ...(parsed.usage?.completion_tokens !== undefined
        ? { output_tokens: parsed.usage.completion_tokens }
        : {}),
      ...(parsed.usage?.prompt_tokens_details?.cached_tokens !== undefined
        ? {
            input_tokens_details: {
              cached_tokens: parsed.usage.prompt_tokens_details.cached_tokens,
            },
          }
        : {}),
    },
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: first?.message.content ?? "",
            annotations: citations,
          },
        ],
      },
    ],
  };
}
