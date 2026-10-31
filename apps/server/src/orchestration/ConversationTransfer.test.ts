import { describe, expect, it } from "vite-plus/test";
import { parseConversation } from "./ConversationTransfer.ts";

describe("native conversation formats", () => {
  it("imports Codex messages once and retains the source session ID", () => {
    const source = [
      { type: "session_meta", payload: { id: "cli-123" } },
      { type: "event_msg", payload: { type: "user_message", message: "fix" } },
      {
        type: "response_item",
        timestamp: "2026-10-05T01:00:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix" }] },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "exec", arguments: "test" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n");
    expect(parseConversation("codex", source)).toMatchObject({
      sourceSessionId: "cli-123",
      messages: [
        { role: "user", text: "fix" },
        { role: "assistant", text: "done" },
      ],
    });
  });
  it("accepts Claude tool-containing turns without treating tool output as spoken text", () => {
    const source = [
      { type: "user", sessionId: "claude-123", message: { role: "user", content: "fix" } },
      {
        type: "assistant",
        uuid: "one",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "testing" },
            { type: "tool_use", name: "Bash", input: { command: "test" } },
          ],
        },
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "big result" }] },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n");
    expect(parseConversation("claude", source).messages).toMatchObject([
      { role: "user", text: "fix" },
      { role: "assistant", text: "testing" },
    ]);
  });
  it("keeps Grok code-fenced speaker headings inside the message", () => {
    expect(
      parseConversation(
        "grok",
        "# Session\n## User\nfix\n## Grok\n```md\n## User\nliteral\n```\ndone",
      ).messages,
    ).toMatchObject([
      { role: "user", text: "fix" },
      { role: "assistant", text: "```md\n## User\nliteral\n```\ndone" },
    ]);
  });
  it("round trips T3 text and rejects unsupported or broken files", () => {
    expect(
      parseConversation(
        "t3",
        JSON.stringify({
          format: "t3-conversation",
          thread: {
            id: "old",
            messages: [{ role: "user", text: "keep", createdAt: "2026-10-05T01:00:00Z" }],
          },
        }),
      ).messages[0]?.text,
    ).toBe("keep");
    expect(() => parseConversation("grok", "just random markdown")).toThrow("읽을 수 있는 대화");
    expect(() => parseConversation("codex", "{}\nwrong")).toThrow("2번째 줄");
    expect(() =>
      parseConversation(
        "t3",
        JSON.stringify({
          messages: Array.from({ length: 1001 }, () => ({ role: "user", text: "keep" })),
        }),
      ),
    ).toThrow();
  });
});
