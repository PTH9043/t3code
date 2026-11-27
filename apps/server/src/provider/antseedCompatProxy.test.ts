// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeHttp from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createAntseedCompatProxyServer,
  createAntseedSseStreamNormalizer,
  normalizeAntseedJsonText,
  normalizeAntseedSseEvent,
  type AntseedCompatProxyHandle,
} from "./antseedCompatProxy.ts";

const observedAntseedThinkingChunk = {
  id: "83181b9393d24b038b240f6d1d9a9301",
  object: "chat.completion.chunk",
  created: 1795265901,
  model: "deepseek-v4.1-flash-1017",
  choices: [
    {
      index: 0,
      delta: {
        index: 0,
        content: [
          {
            type: "thinking",
            thinking: [{ type: "text", text: "Let" }],
            closed: true,
          },
        ],
      },
      finish_reason: null,
    },
  ],
};

describe("antseedCompatProxy", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) {
      await close();
    }
  });

  it("rewrites Antseed array-valued thinking delta.content into standard reasoning_content + null content", () => {
    const raw = JSON.stringify(observedAntseedThinkingChunk);
    const normalized = JSON.parse(normalizeAntseedJsonText(raw)) as {
      choices: Array<{ delta: { content: unknown; reasoning_content?: string } }>;
    };
    expect(normalized.choices[0]?.delta.content).toBeNull();
    expect(normalized.choices[0]?.delta.reasoning_content).toBe("Let");
  });

  it("handles mixed thinking and text blocks in both streaming delta and non-streaming message", () => {
    const mixedChunk = {
      id: "chunk-2",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            content: [
              { type: "thinking", thinking: [{ type: "text", text: "Check math." }] },
              { type: "text", text: "통과했습니다." },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const parsedChunk = JSON.parse(normalizeAntseedJsonText(JSON.stringify(mixedChunk))) as {
      choices: Array<{ delta: { content: unknown; reasoning_content?: string } }>;
    };
    expect(parsedChunk.choices[0]?.delta.content).toBe("통과했습니다.");
    expect(parsedChunk.choices[0]?.delta.reasoning_content).toBe("Check math.");

    const nonStreaming = {
      id: "resp-1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Step 1" }],
          },
          finish_reason: "stop",
        },
      ],
    };
    const parsedResp = JSON.parse(normalizeAntseedJsonText(JSON.stringify(nonStreaming))) as {
      choices: Array<{ message: { content: unknown; reasoning_content?: string } }>;
    };
    expect(parsedResp.choices[0]?.message.content).toBe("");
    expect(parsedResp.choices[0]?.message.reasoning_content).toBe("Step 1");
  });

  it("passes standard string content and [DONE] SSE frames through unchanged", () => {
    const standardFrame = `data: ${JSON.stringify({
      id: "ok-1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
    })}`;
    expect(normalizeAntseedSseEvent(standardFrame)).toBe(standardFrame);
    expect(normalizeAntseedSseEvent("data: [DONE]")).toBe("data: [DONE]");
  });

  it("normalizes SSE events cleanly across arbitrary TCP chunk boundaries", () => {
    const normalizer = createAntseedSseStreamNormalizer();
    const sse =
      `data: ${JSON.stringify(observedAntseedThinkingChunk)}\n\n` +
      `data: ${JSON.stringify({
        id: "ok-2",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "검증 완료" }, finish_reason: "stop" }],
      })}\n\n` +
      "data: [DONE]\n\n";

    let assembled = "";
    for (let i = 0; i < sse.length; i += 17) {
      assembled += normalizer.push(sse.slice(i, i + 17));
    }
    assembled += normalizer.flush();

    const dataLines = assembled
      .split("\n\n")
      .map((frame) => frame.trim())
      .filter((frame) => frame.startsWith("data:"))
      .map((frame) => frame.slice(5).trim());

    expect(dataLines).toHaveLength(3);
    const first = JSON.parse(dataLines[0]!) as {
      choices: Array<{ delta: { content: unknown; reasoning_content?: string } }>;
    };
    expect(first.choices[0]?.delta.content).toBeNull();
    expect(first.choices[0]?.delta.reasoning_content).toBe("Let");
    const second = JSON.parse(dataLines[1]!) as {
      choices: Array<{ delta: { content: unknown } }>;
    };
    expect(second.choices[0]?.delta.content).toBe("검증 완료");
    expect(dataLines[2]).toBe("[DONE]");
  });

  it("proxies live HTTP SSE and JSON requests while normalizing Antseed thinking chunks end-to-end", async () => {
    let observedAuth: string | undefined;
    let observedPath: string | undefined;

    const upstream = NodeHttp.createServer((req, res) => {
      observedAuth = req.headers.authorization;
      observedPath = req.url;
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write(`data: ${JSON.stringify(observedAntseedThinkingChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp-2",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: [{ type: "text", text: "Think" }] },
                  { type: "text", text: "Result" },
                ],
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    closers.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Expected TCP upstream address");
    }

    const proxy: AntseedCompatProxyHandle = await createAntseedCompatProxyServer(
      `http://127.0.0.1:${upstreamAddress.port}/v1`,
    );
    closers.push(proxy.close);

    // 1. Streaming SSE request
    const sseResponse = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-antseed-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash-1017", stream: true }),
    });
    expect(sseResponse.status).toBe(200);
    expect(observedAuth).toBe("Bearer test-antseed-key");
    expect(observedPath).toBe("/v1/chat/completions");
    const sseBody = await sseResponse.text();
    const firstPayload = JSON.parse(
      sseBody
        .split("\n\n")[0]!
        .replace(/^data:\s*/, "")
        .trim(),
    ) as { choices: Array<{ delta: { content: unknown; reasoning_content?: string } }> };
    expect(firstPayload.choices[0]?.delta.content).toBeNull();
    expect(firstPayload.choices[0]?.delta.reasoning_content).toBe("Let");

    // 2. Non-streaming JSON request
    const jsonResponse = await fetch(`${proxy.baseUrl}/other`, { method: "GET" });
    expect(jsonResponse.status).toBe(200);
    const jsonBody = (await jsonResponse.json()) as {
      choices: Array<{ message: { content: unknown; reasoning_content?: string } }>;
    };
    expect(jsonBody.choices[0]?.message.content).toBe("Result");
    expect(jsonBody.choices[0]?.message.reasoning_content).toBe("Think");
  });
});
