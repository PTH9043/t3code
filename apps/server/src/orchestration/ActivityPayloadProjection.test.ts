import { describe, expect, it } from "vite-plus/test";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { groupToolActivities } from "@t3tools/shared/toolActivity";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload agent-field survival", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps an OpenCode tool's target file and call identity, and none of its arguments", () => {
    const projected = projectActivityPayload(
      activity({
        provider: "opencode",
        toolCallId: "call_read",
        status: "completed",
        itemType: "dynamic_tool_call",
        detail: "<path>D:\\repo\\apps\\web\\ChatView.tsx</path>",
        data: {
          tool: "grep",
          state: {
            status: "completed",
            input: { path: "D:\\repo\\apps\\web\\ChatView.tsx", pattern: "token=abc" },
            output: "secret output",
          },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.toolCallId).toBe("call_read");
    expect(payload.toolActivityOperation).toMatchObject({ targetPaths: ["ChatView.tsx"] });
    expect(JSON.stringify(payload.data)).not.toMatch(/token=abc|secret output/);
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload({ ...source, kind: "task.started" });
    expect(projected.payload).toEqual(source.payload);
  });

  it("preserves Antigravity ACP rawInput.Path and locations filenames through projection and grouping", () => {
    const turnId = TurnId.make("turn-gemini-1");
    const assigned: OrchestrationThreadActivity = {
      id: EventId.make(`turn-assigned:${turnId}`),
      tone: "info",
      kind: "conversation.turn-assigned",
      summary: "이번 요청에 지정한 모델",
      payload: { instanceId: "gemini", model: "gemini-4-neon" },
      turnId,
      createdAt: "2026-11-20T00:00:00.000Z",
    };
    const readActivity = projectActivityPayload({
      ...activity({
        provider: "gemini",
        providerInstanceId: "gemini",
        toolCallId: "call_read_1",
        status: "completed",
        itemType: "dynamic_tool_call",
        detail: "/D:/__job/00_통합자료_한화면.html",
        data: {
          toolCallId: "call_read_1",
          kind: "read",
          rawInput: { Path: "D:/__job/00_통합자료_한화면.html", StartLine: 1, EndLine: 300 },
          locations: [{ path: "/D:/__job/00_통합자료_한화면.html" }],
        },
      }),
      id: EventId.make("act-read"),
      summary: "Read file",
      turnId,
      createdAt: "2026-11-20T00:00:01.000Z",
    });
    const editActivity = projectActivityPayload({
      ...activity({
        provider: "gemini",
        providerInstanceId: "gemini",
        toolCallId: "call_edit_1",
        status: "completed",
        itemType: "file_change",
        detail: "/D:/__job/00_모바일_공부_예비군.html",
        data: {
          toolCallId: "call_edit_1",
          kind: "edit",
          rawInput: {
            Path: "D:/__job/00_모바일_공부_예비군.html",
            Target: "old",
            Replacement: "new",
          },
          locations: [{ path: "/D:/__job/00_모바일_공부_예비군.html" }],
        },
      }),
      id: EventId.make("act-edit"),
      summary: "Changed files",
      turnId,
      createdAt: "2026-11-20T00:00:02.000Z",
    });

    const groups = groupToolActivities([assigned, readActivity, editActivity]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      executorSource: "turn-assigned",
      executorLabel: "턴 배정 · gemini · gemini-4-neon",
      summary: "파일 읽기 · 00_통합자료_한화면.html (L1-L300)",
      targetPaths: ["00_통합자료_한화면.html"],
      preview: { lineRange: "L1-L300" },
    });
    expect(groups[1]).toMatchObject({
      executorSource: "turn-assigned",
      executorLabel: "턴 배정 · gemini · gemini-4-neon",
      summary: "파일 수정 · 00_모바일_공부_예비군.html (+1/-1줄)",
      targetPaths: ["00_모바일_공부_예비군.html"],
      preview: { editSummary: { mode: "edit", addedLines: 1, removedLines: 1 } },
    });
  });

  it("projects Antigravity CommandLine, toolSummary, duration, exitCode, and redacted outputSnippet", () => {
    const turnId = TurnId.make("turn-gemini-cmd");
    const cmdActivity = projectActivityPayload({
      ...activity({
        provider: "gemini",
        providerInstanceId: "gemini",
        toolCallId: "call_cmd_1",
        status: "completed",
        itemType: "command_execution",
        data: {
          toolCallId: "call_cmd_1",
          kind: "execute",
          rawInput: {
            toolSummary: "Collect real historical cliff unlocks from DefiLlama",
            CommandLine: "cmd.exe /c python collect_unlock_events.py --api-key=sk-secret1234567890",
          },
          rawOutput: {
            output: [
              "Created At: 2026-11-21T01:28:53+09:00",
              "Completed At: 2026-11-21T01:28:57+09:00",
              "Command exited with code 0.",
              "",
              "Command output:",
              "Fetching 197 protocols...",
              "DONE: deduped_events=1049 across 94 symbols",
            ].join("\n"),
          },
        },
      }),
      id: EventId.make("act-cmd-1"),
      summary: "Ran command",
      turnId,
      createdAt: "2026-11-21T01:28:57.000Z",
    });

    const [group] = groupToolActivities([cmdActivity]);
    expect(group).toMatchObject({
      action: "command",
      phase: "completed",
      summary: "명령 실행 · Collect real historical cliff unlocks from DefiLlama",
      preview: {
        intent: "Collect real historical cliff unlocks from DefiLlama",
        durationMs: 4000,
        outputSnippet: "DONE: deduped_events=1049 across 94 symbols",
      },
    });
    expect(group?.preview?.commandSnippet).toContain("collect_unlock_events.py");
    expect(JSON.stringify(cmdActivity)).not.toContain("sk-secret1234567890");
    expect(JSON.stringify(group)).not.toContain("sk-secret1234567890");
  });
});
