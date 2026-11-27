import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildToolActivityFacts,
  partitionToolActivityGroups,
  toolActivityCallIdentity,
  groupToolActivities,
  projectToolActivityOperation,
  selectToolActivitySummaryFamily,
} from "./toolActivity.ts";

const turnId = TurnId.make("turn");
function row(
  id: string,
  kind: string,
  payload: unknown,
  sequence: number,
  turn: TurnId | null = turnId,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    turnId: turn,
    kind,
    summary: "Tool",
    payload,
    tone: "tool",
    createdAt: "2026-11-19T00:00:00Z",
    sequence,
  };
}
const shell = (id: string, command: string) => ({
  itemType: "command_execution",
  data: { toolCallId: id, item: { command } },
});

describe("tool call history", () => {
  it("resolves unbound Claude receipts only from one native call in the same account and scope", () => {
    const p = {
      provider: "claudeAgent",
      providerInstanceId: "work",
      toolCallId: "toolu_example",
      itemType: "command_execution",
    };
    const assign = row(
      "assigned",
      "conversation.turn-assigned",
      { instanceId: "work", model: "assigned-model" },
      0,
    );
    const start = row("start", "tool.started", p, 1, null);
    const update = row("update", "tool.updated", p, 2, null);
    const end = row("end", "tool.completed", p, 3);
    const [bound] = groupToolActivities([assign, start, update, end]);
    expect(bound).toMatchObject({
      turnId,
      phase: "completed",
      eventIds: ["start", "update", "end"],
      executorSource: "turn-assigned",
    });
    expect(bound?.executorLabel).toContain("work · assigned-model");
    expect(start.turnId).toBeNull();
    for (const conflict of [
      row("collision", "tool.started", p, 4),
      row("other-turn", "tool.updated", p, 4, TurnId.make("other")),
    ]) {
      expect(
        groupToolActivities([assign, start, end, conflict]).find((g) => g.id === start.id),
      ).toMatchObject({ turnId: null, eventIds: ["start"], executorSource: "unknown" });
    }
    for (const changed of [
      { providerInstanceId: "different" },
      { agentId: "child" },
      { providerSessionId: "other" },
      { toolCallId: "local-id" },
    ]) {
      const groups = groupToolActivities([
        assign,
        start,
        { ...end, payload: { ...p, ...changed } },
      ]);
      expect(groups).toHaveLength(2);
      expect(groups[0]?.executorSource).toBe("unknown");
    }
    expect(
      groupToolActivities([
        assign,
        { ...end, payload: { ...p, providerInstanceId: "different" } },
      ])[0]?.executorSource,
    ).toBe("unknown");
  });
  it("keeps the reported failure diagnostics, exit codes and separate later command outcomes on raw and compact receipts", () => {
    const errors = [
      "Exit code 2\n/usr/bin/bash: -c: line 1: unexpected EOF while looking for matching " +
        String.fromCharCode(96) +
        "''",
      "Exit code 1\nTraceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory: '/private/path'",
    ];
    const calls = [...errors, "ok"].flatMap((content, index) => {
      const id = "toolu_" + index;
      const p = {
        provider: "claudeAgent",
        providerInstanceId: "work",
        toolCallId: id,
        itemType: "command_execution",
      };
      const result = { type: "tool_result", is_error: index < 2, tool_use_id: id, content };
      return ["tool.started", "tool.updated", "tool.completed"].map((kind, j) => {
        const n = index * 3 + j;
        const payload =
          j === 0
            ? p
            : {
                ...p,
                data: { toolName: "Bash", input: { command: "cat src/a.ts && other" }, result },
              };
        return {
          ...row("event-" + n, kind, payload, n),
          createdAt: "2026-01-01T00:00:0" + n + "Z",
        };
      });
    });
    const compact = calls.map((e) => ({
      ...e,
      payload: {
        itemType: "command_execution",
        provider: "claudeAgent",
        providerInstanceId: "work",
        ...toolActivityCallIdentity(e.payload),
        toolActivityOperation: projectToolActivityOperation(e),
      },
    }));
    for (const input of [calls, compact]) {
      const groups = groupToolActivities(input);
      expect(groups).toHaveLength(3);
      expect(groups.map((g) => g.events.length)).toEqual([3, 3, 3]);
      expect(groups[0]?.summary).toContain("종료 코드 2 · 셸 오류 출력 · 닫는 따옴표 누락");
      expect(groups[0]?.commandFailureNote).toContain("별도 명령 · 실패");
      expect(groups[1]?.summary).toContain(
        "종료 코드 1 · 실행 오류 출력 · 파일 또는 경로를 찾지 못함",
      );
      expect(groups[1]?.commandFailureNote).toBe(
        "이후 시작한 별도 명령 · 종료 · 이 명령의 복구 여부 미확인",
      );
      expect(JSON.stringify(groups)).not.toContain("/private");
      expect(groups[2]?.commandFailureNote).toBeUndefined();
    }
    const proseOnly = {
      itemType: "command_execution",
      status: "failed",
      detail: errors[0],
      data: { toolName: "Bash", input: { command: errors[1] } },
    };
    expect(
      groupToolActivities([row("unknown", "tool.completed", proseOnly, 0)])[0]?.summary,
    ).toContain("구체적 원인 미확인");
    const codexWinMissing = {
      itemType: "command_execution",
      provider: "codex",
      providerInstanceId: "codex",
      toolCallId: "exec-win-missing",
      status: "completed",
      data: {
        item: {
          command:
            '"C:\\Windows\\system32\\cmd.exe" /c "certutil -hashfile \\"E:\\missing.txt\\" SHA256"',
          exitCode: -2147024894,
          aggregatedOutput:
            "CertUtil: -hashfile failed. 0x80070002 (WIN32: 2 ERROR_FILE_NOT_FOUND)\r\n",
        },
      },
    };
    expect(
      groupToolActivities([row("win-missing", "tool.completed", codexWinMissing, 0)])[0]?.summary,
    ).toContain("종료 코드 -2147024894 · 실행 오류 출력 · 파일 또는 경로를 찾지 못함");
    const success = {
      itemType: "command_execution",
      data: {
        toolName: "Bash",
        result: { type: "tool_result", is_error: false, content: errors[0] },
      },
    };
    expect(groupToolActivities([row("success", "tool.completed", success, 0)])[0]?.phase).toBe(
      "completed",
    );
  });
  it("groups interleaved and late receipts by execution, message, attempt and call without a turn ID", () => {
    const scope = {
      executionId: "exec",
      messageId: "msg",
      attempt: 1,
      toolCallId: "call",
      itemType: "command_execution",
    };
    const groups = groupToolActivities([
      row("progress", "tool.updated", scope, 1, null),
      row("other", "tool.started", { ...scope, toolCallId: "other" }, 2, null),
      row("failed", "tool.completed", { ...scope, exitCode: 2 }, 3, null),
      row("late-start", "tool.started", scope, 4, null),
      row("retry", "tool.started", { ...scope, attempt: 2 }, 5, null),
      row("separate-exec", "tool.started", { ...scope, executionId: "exec-2" }, 6, null),
      row("separate-message", "tool.started", { ...scope, messageId: "msg-2" }, 7, null),
      row("missing-owner", "tool.updated", { ...scope, messageId: undefined }, 8, null),
      row("missing-owner-2", "tool.updated", { ...scope, messageId: undefined }, 9, null),
      row("missing-call", "tool.updated", { ...scope, toolCallId: undefined }, 10, null),
      row("missing-call-2", "tool.updated", { ...scope, toolCallId: undefined }, 11, null),
    ]);
    expect(groups).toHaveLength(9);
    expect(groups[0]).toMatchObject({
      phase: "failed",
      eventIds: ["progress", "failed", "late-start"],
    });
    expect(groups[0]?.events[1]?.exitCode).toBe(2);
    const conflicting = groupToolActivities([
      row("error", "tool.updated", { ...scope, status: "failed" }, 1, null),
      row("done", "tool.completed", scope, 2, null),
    ])[0]!;
    expect(conflicting.summary).toContain("실패 기록 있음");
    expect(conflicting.phase).toBe("completed");
    const reused = groupToolActivities(
      ["tool.started", "tool.completed", "tool.started", "tool.completed"].map((kind, i) =>
        row("retry-" + i, kind, scope, i, null),
      ),
    );
    expect(reused.map((g) => g.eventIds)).toEqual([
      ["retry-0", "retry-1"],
      ["retry-2", "retry-3"],
    ]);
  });
  it("keeps a foreground worker call on one row when its receipts are timestamped out of order", () => {
    // A detached worker's rows have no sequence, and OpenCode stamps the start after the progress.
    const call = (id: string, tool: string, input: unknown) => {
      const payload = (status: string) => ({
        provider: "opencode",
        providerInstanceId: "opencode",
        toolCallId: id,
        status,
        itemType: "dynamic_tool_call",
        data: { tool, state: { status, input } },
      });
      const event = (kind: string, status: string, time: string) => {
        const { sequence: _sequence, ...base } = row(
          `orchestra:upgrade-room-turn-1:1:${id}-${kind}`,
          kind,
          payload(status),
          0,
        );
        return { ...base, summary: tool, createdAt: "2026-11-19T12:04:06." + time + "Z" };
      };
      return [
        event("tool.updated", "inProgress", "861"),
        event("tool.completed", "completed", "919"),
        event("tool.started", "inProgress", "925"),
      ];
    };
    const groups = groupToolActivities([
      ...call("call_read", "read", { filePath: "D:\\repo\\apps\\web\\ChatView.tsx", limit: 49 }),
      ...call("call_grep", "grep", { path: "D:\\repo", pattern: "token=abc" }),
    ]);
    expect(groups.map((group) => [group.summary, group.phase, group.events.length])).toEqual([
      ["파일 읽기 종료 · ChatView.tsx", "completed", 3],
      ["자료 검색 종료 · repo", "completed", 3],
    ]);
    // The same receipts in an ordinary thread keep the strict start/retry handling.
    const ordinary = call("call_read", "read", {}).map((event, index) => ({
      ...event,
      id: EventId.make("ordinary-" + index),
    }));
    expect(groupToolActivities(ordinary)).toHaveLength(2);
  });
  it("keeps a simultaneous unsequenced update on its explicit finished call in either delivery order", () => {
    const p = shell("id", "git log");
    function event(id: string, kind: string, time: string, payload: unknown = p) {
      const { sequence: _sequence, ...base } = row(id, kind, payload, 0);
      return { ...base, createdAt: "2026-11-19T04:" + time + "Z" };
    }
    const start = event("s", "tool.started", "47:15.010"),
      done = event("a", "tool.completed", "47:16.058"),
      update = event("z", "tool.updated", "47:16.058"),
      other = event("o", "tool.updated", "47:16.058", shell("other", "git log")),
      retry = event("r", "tool.started", "47:17.010");
    for (const input of [
      [start, done, update, other, retry],
      [retry, other, update, done, start],
    ]) {
      const groups = groupToolActivities(input);
      expect(groups).toHaveLength(3);
      expect(groups[0]).toMatchObject({ id: "s", eventIds: ["s", "z", "a"], phase: "completed" });
      expect(groups[1]).toMatchObject({ id: "o", phase: "running" });
      expect(groups[2]).toMatchObject({ id: "r", phase: "started" });
    }
    const model = { ...p, reportedModel: "provider-model" };
    const receipts = [
      event("a-end", "tool.completed", "48:05.100", model),
      event("b-update", "tool.updated", "48:05.100", model),
      event("z-start", "tool.started", "48:05.100", model),
    ];
    expect(groupToolActivities(receipts)).toMatchObject([
      {
        eventIds: ["z-start", "b-update", "a-end"],
        id: "z-start",
        phase: "completed",
        executorSource: "provider-reported",
      },
    ]);
    const collision = [...receipts, event("retry-start", "tool.started", "48:05.100", model)];
    expect(groupToolActivities(collision).map((g) => g.eventIds.length)).toEqual([1, 1, 1, 1]);
  });
  it("recognizes a SELECT on a literal read-only Python connection, excluding comments, quoted code, other handles and rebinding", () => {
    const prefix = "cd cache && python -I -B -X utf8 - <<'CODE'\n";
    const connect =
      "import sqlite3, os\ndb = sqlite3.connect('file:cache/items.sqlite?mode=ro', uri=True, timeout=2)\nc = db.cursor()\n";
    const query = "rows = c.execute('''SELECT name FROM items''').fetchall()";
    const classify = (body: string) =>
      groupToolActivities([
        row("db", "tool.completed", shell("db", prefix + body + "\nCODE"), 1),
      ])[0]!;
    expect(classify(connect + query)).toMatchObject({
      action: "read",
      subject: "database-read",
      compound: true,
      targetPaths: ["cache/items.sqlite"],
      confirmedDiffPaths: [],
    });
    for (const body of [
      connect.replace("mode=ro", "mode=rw") + query,
      connect + query.replace("c.execute", "other.execute"),
      connect + "c = other.cursor()\n" + query,
      connect + "# " + query,
      connect + '"""c.execute(\'SELECT 1\')"""',
    ])
      expect(classify(body).subject).toBeUndefined();
  });
  it("uses an explicit shell diagnostic on a terminal receipt, excluding arbitrary output and successful exit codes", () => {
    const payload = {
      itemType: "command_execution",
      status: "completed",
      detail: "zsh: command not found: missing",
    };
    const [bad, good, prose] = groupToolActivities([
      row("bad", "tool.completed", payload, 1),
      row("good", "tool.completed", { ...payload, exitCode: 0 }, 2),
      row("prose", "tool.completed", { ...payload, detail: "the log mentions an error" }, 3),
    ]);
    expect(bad?.phase).toBe("failed");
    expect(good?.phase).toBe("completed");
    expect(prose?.phase).toBe("completed");
  });

  it("classifies only evidenced parts of compound reads, searches and sqlite queries, also on old Bash details", () => {
    const commands = [
      "cd work && sed -n 200,400p README.md | grep -Ei 'one|two'; echo heading; cat SECURITY.md | head -n 4; rg -n pattern src/project.ts",
      "cd example && sed -n '3,45p' README.md; grep -e pattern -- SECURITY.md src/project.ts; unsupported_program",
    ];
    for (const command of commands) {
      for (const payload of [
        shell("native", command),
        { itemType: "command_execution", detail: "Bash: " + command },
        {
          itemType: "command_execution",
          toolActivityOperation: projectToolActivityOperation(
            row("raw", "tool.completed", shell("native", command), 1),
          ),
        },
      ]) {
        const [g] = groupToolActivities([row("e", "tool.completed", payload, 1)]);
        expect(g).toMatchObject({
          action: "search",
          subject: "read-search",
          compound: true,
          confirmedDiffPaths: [],
          targetPaths: ["README.md", "SECURITY.md", "src/project.ts"],
        });
        expect(g!.summary).toContain("요청에 파일 읽기·검색 포함");
        expect(g!.summary).not.toMatch(/수정|편집|성공|적용/u);
        expect(JSON.stringify(buildToolActivityFacts([g!]))).not.toMatch(
          /README|heading|pattern|unsupported_program/u,
        );
      }
    }
    const read = (cmd: string) =>
      groupToolActivities([row("r", "tool.completed", shell("shell", cmd), 1)])[0]!;
    expect(read("cd work && grep -n -e needle -- src/main.ts | head -4")).toMatchObject({
      action: "search",
      targetPaths: ["src/main.ts"],
    });
    expect(read("cat 'example config.txt'")).toMatchObject({
      action: "read",
      targetPaths: ["example config.txt"],
    });
    expect(
      read("cd data && sqlite3 -readonly saved.db 'SELECT count(*) FROM events;'"),
    ).toMatchObject({
      action: "read",
      subject: "database-read",
      targetPaths: ["saved.db"],
      confirmedDiffPaths: [],
    });
    expect(read("sqlite3 saved.db 'SELECT count(*) FROM events;'").subject).toBeUndefined();
    expect(read("sqlite3 -readonly saved.db 'SELECT 1; DELETE FROM t;'").subject).toBeUndefined();
    expect(read("sed -i 's/x/y/' file.txt")).toMatchObject({
      action: "command",
      targetPaths: [],
      confirmedDiffPaths: [],
    });
    expect(
      read("cat known.ts; python - <<'PY'\nprint('cat pretend.ts; git fetch')\nPY"),
    ).toMatchObject({ action: "read", compound: true, targetPaths: ["known.ts"] });
    expect(read("printf 'cat pretend.ts | git fetch' | head -1")).toMatchObject({
      action: "command",
      targetPaths: [],
    });
    const unrelated = groupToolActivities([
      row(
        "x",
        "tool.updated",
        {
          itemType: "command_execution",
          detail: "Tool output: cat pretend.ts",
          data: { result: { content: "Bash: cat pretend.ts" } },
        },
        1,
      ),
    ])[0]!;
    expect(unrelated).toMatchObject({ action: "command", targetPaths: [] });
  });
  it("archives only ungrounded intermediate signals for a settled turn, preserving every original ID", () => {
    const another = TurnId.make("still-running");
    const events = [
      row("orphan-a", "tool.started", { itemType: "command_execution" }, 1),
      row("orphan-b", "tool.updated", { itemType: "command_execution" }, 2),
      row("live", "tool.started", { itemType: "command_execution" }, 3, another),
      row("identified-a", "tool.started", shell("a", "unknown"), 4),
      row("identified-b", "tool.started", shell("b", "unknown"), 5),
      row(
        "read",
        "tool.updated",
        { itemType: "command_execution", detail: "Bash: cat src/file.ts" },
        6,
      ),
      row("terminal", "tool.completed", { itemType: "command_execution" }, 7),
      row("exit", "tool.updated", { itemType: "command_execution", exitCode: 1 }, 8),
      row("unscoped", "tool.started", {}, 9, null),
      row(
        "history",
        "tool.updated",
        { itemType: "command_execution", detail: "Bash: git log -- src/file.ts" },
        10,
      ),
      row(
        "database",
        "tool.updated",
        { itemType: "command_execution", detail: "Bash: sqlite3 -readonly saved.db 'SELECT 1'" },
        11,
      ),
    ];
    const groups = groupToolActivities(events);
    expect(partitionToolActivityGroups(groups, new Set()).visible).toEqual(groups);
    const { visible, technicalByTurn } = partitionToolActivityGroups(groups, new Set([turnId]));
    expect(visible.map((g) => g.id)).toEqual([
      "live",
      "identified-a",
      "identified-b",
      "terminal",
      "exit",
      "unscoped",
    ]);
    expect(technicalByTurn.size).toBe(1);
    expect(technicalByTurn.get(turnId)?.map((g) => g.eventIds)).toEqual([
      ["orphan-a"],
      ["orphan-b"],
      ["read"],
      ["history"],
      ["database"],
    ]);
    expect(technicalByTurn.get(turnId)?.at(-1)).toMatchObject({
      subject: "database-read",
      targetPaths: ["saved.db"],
    });
    const partial = groupToolActivities(
      [row("written", "tool.updated", { itemType: "file_change" }, 1)],
      {
        confirmedDiffs: [{ turnId, eventId: "written", paths: ["src/partial.ts"] }],
      },
    );
    expect(partitionToolActivityGroups(partial, new Set([turnId])).visible).toMatchObject([
      {
        id: "written",
        phase: "running",
        evidence: "confirmed-diff",
        confirmedDiffPaths: ["src/partial.ts"],
      },
    ]);
  });
  it("never guesses between conflicting historical IDs, even after a compact projection", () => {
    const conflict = { itemId: "a", data: { item: { id: "b" } } };
    for (const payload of [
      conflict,
      { toolCallIdAmbiguous: true, toolCallId: "a", data: { item: { id: "a" } } },
    ]) {
      expect(toolActivityCallIdentity(payload)).toEqual({ toolCallIdAmbiguous: true });
      expect(
        groupToolActivities([
          row("s", "tool.started", payload, 1),
          row("e", "tool.completed", payload, 2),
        ]).map((g) => g.eventIds),
      ).toEqual([["s"], ["e"]]);
    }
    expect(toolActivityCallIdentity({ ...conflict, toolCallId: "verified" })).toEqual({
      toolCallId: "verified",
    });
    expect(
      toolActivityCallIdentity({
        data: { result: { type: "text", tool_use_id: "not-a-tool-result" } },
      }),
    ).toEqual({});
  });

  it("keeps native edit evidence on the terminal call and recognizes previews and test commands", () => {
    const update = {
      type: "fileChange",
      status: "completed",
      changes: [{ path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }],
    };
    const end = row(
      "e",
      "tool.completed",
      {
        itemId: "p",
        itemType: "file_change",
        data: { item: update, input: { path: "src/unrelated.ts" } },
      },
      2,
    );
    const stamp = projectToolActivityOperation(end)!;
    expect(stamp.confirmedDiffPaths).toEqual(["src/a.ts"]);
    expect(JSON.stringify(stamp)).not.toContain("old");
    const g = groupToolActivities([
      { ...end, payload: { itemId: "p", toolActivityOperation: stamp } },
    ])[0]!;
    expect(g).toMatchObject({
      action: "edit",
      evidence: "confirmed-diff",
      confirmedDiffPaths: ["src/a.ts"],
    });
    expect(
      groupToolActivities([
        row(
          "s",
          "tool.started",
          { itemType: "file_change", data: { item: { ...update, status: "inProgress" } } },
          1,
        ),
      ])[0]?.confirmedDiffPaths,
    ).toEqual([]);
    for (const cmd of [
      "node --test check.test.js",
      "vitest run",
      "npm run test",
      "python -m unittest",
    ]) {
      const g = groupToolActivities([row("test", "tool.completed", shell("t", cmd), 1)])[0]!;
      expect(g.summary).toContain("테스트 실행");
      expect(buildToolActivityFacts([g])[0]?.subject).toBe("test");
    }
  });
  it("keeps executor reporting bound to the tool, withholds conflicting assignments, and preserves earlier command evidence", () => {
    const g = groupToolActivities([
      row("as1", "conversation.turn-assigned", { model: "first" }, 1),
      row("as2", "conversation.turn-assigned", { model: "second" }, 2),
      row(
        "a",
        "tool.started",
        { ...shell("explicit", "git log"), reportedModel: "actual-model" },
        3,
      ),
      row("b", "tool.completed", { itemId: "explicit", itemType: "command_execution" }, 4),
      row("c", "tool.completed", { itemId: "other" }, 5),
    ]);
    expect(g[0]).toMatchObject({ subject: "history-read", executorSource: "provider-reported" });
    expect(g[0]!.executorLabel).toContain("actual-model");
    expect(g[1]!.executorSource).toBe("unknown");
  });
  it("describes compound history operations as attempts and does not infer fetch success or file edits", () => {
    for (const command of [
      "git fetch --unshallow 2>&1 | tail -1; git log --oneline -- component.ts",
      "git -C repo fetch origin && git -C repo rev-list HEAD",
      "git fetch upstream || git log -10",
    ]) {
      const [g] = groupToolActivities([
        row("history", "tool.completed", { ...shell("c", command), exitCode: 0 }, 1),
      ]);
      expect(g).toMatchObject({
        action: "command",
        phase: "completed",
        subject: "history-fetch-read",
        compound: true,
        confirmedDiffPaths: [],
      });
      expect(g!.summary).toContain("Git 이력 가져오기·조회 시도");
      expect(g!.summary).not.toMatch(/성공|수정|편집/);
      expect(selectToolActivitySummaryFamily(buildToolActivityFacts([g!])[0]!, "h")).toBe(
        "granite",
      );
    }
    const [quoted] = groupToolActivities([
      row("q", "tool.completed", shell("q", `echo 'git fetch | tail; git log'`), 1),
    ]);
    expect(quoted?.subject).toBeUndefined();
    expect(quoted?.compound).toBeUndefined();
  });
  it("joins only the matching invocation despite interleaving, repeated commands and reordered input", () => {
    const a = shell("a", "git status"),
      b = shell("b", "git status");
    const groups = groupToolActivities([
      row("e5", "tool.completed", b, 5),
      row("e1", "tool.started", a, 1),
      row("e4", "tool.completed", a, 4),
      row("e2", "tool.started", b, 2),
      row("e3", "tool.updated", a, 3),
      row("e6", "tool.started", a, 6),
      row("e7", "tool.completed", a, 7),
    ]);
    expect(groups.map((g) => g.eventIds)).toEqual([
      ["e1", "e3", "e4"],
      ["e2", "e5"],
      ["e6", "e7"],
    ]);
    expect(groups[0]).toMatchObject({
      id: "e1",
      phase: "completed",
      action: "read",
      summarySource: "local",
    });
  });
  it("does not join unidentified historical rows by title or time, or reuse an ID across turns, actors or attempts", () => {
    const p = { itemType: "command_execution", data: { command: "rg needle src" } };
    const withId = { ...p, itemId: "x" };
    const groups = groupToolActivities([
      row("i", "tool.started", p, 1),
      row("j", "tool.completed", p, 2),
      row("a", "tool.started", { ...withId, attemptId: "1" }, 3),
      row("b", "tool.completed", { ...withId, attemptId: "2" }, 4),
      row("c", "tool.started", withId, 5),
      row("d", "tool.completed", { ...withId, agentId: "child" }, 6),
      row("e", "tool.completed", withId, 7, TurnId.make("next")),
    ]);
    expect(groups).toHaveLength(7);
  });
  it("retains delegation caller attribution on compact receipts", () => {
    const delegate = row(
      "delegate",
      "tool.completed",
      {
        toolCallId: "id",
        data: { toolName: "mcp__t3-code__workspace_delegate" },
        reportedModel: "Claude",
      },
      1,
    );
    const stamp = projectToolActivityOperation(delegate);
    const compact = {
      ...delegate,
      payload: { toolCallId: "id", reportedModel: "Claude", toolActivityOperation: stamp },
    };
    expect(groupToolActivities([compact])[0]?.executorLabel).toBe(
      "위임 호출자 · 제공자 보고 · Claude",
    );
  });
  it("joins native Claude tool results without using the enclosing task ID as call ID", () => {
    const p = {
      agentId: "child",
      data: {
        toolName: "Read",
        input: { file_path: "src/data.ts" },
        result: { type: "tool_result", tool_use_id: "native" },
      },
    };
    const groups = groupToolActivities([
      row("a", "tool.updated", p, 1),
      row("b", "tool.completed", p, 2),
      row("c", "tool.progress", { taskId: "task-only" }, 3),
      row("d", "tool.progress", { taskId: "task-only" }, 4),
    ]);
    expect(groups.map((g) => g.eventIds)).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(groups[0]).toMatchObject({
      action: "read",
      targetPaths: ["src/data.ts"],
      confirmedDiffPaths: [],
    });
  });
  it("distinguishes requested edits, failed edits, tool-reported changes and a diff bound to a call", () => {
    const p = {
      itemId: "edit",
      itemType: "file_change",
      data: { input: { path: "lib/a.ts", patch: "UNSAFE raw blob" } },
    };
    expect(groupToolActivities([row("a", "tool.started", p, 1)])[0]).toMatchObject({
      action: "edit",
      evidence: "planned",
      confirmedDiffPaths: [],
    });
    expect(
      groupToolActivities([row("a", "tool.completed", { ...p, status: "failed" }, 1)])[0],
    ).toMatchObject({ phase: "failed", evidence: "observed" });
    const done = row("b", "tool.completed", { ...p, status: "completed" }, 2);
    expect(groupToolActivities([done])[0]).toMatchObject({
      evidence: "tool-reported",
      confirmedDiffPaths: [],
    });
    expect(
      groupToolActivities([done], {
        confirmedDiffs: [{ turnId, eventId: "elsewhere", paths: ["lib/a.ts"] }],
      })[0]?.confirmedDiffPaths,
    ).toEqual([]);
    expect(
      groupToolActivities([done], {
        confirmedDiffs: [{ turnId, eventId: "b", paths: ["lib/a.ts"] }],
      })[0],
    ).toMatchObject({ evidence: "confirmed-diff", confirmedDiffPaths: ["lib/a.ts"] });
  });
  it("keeps model assignment separate from an unknown child executor and from the summary author", () => {
    const options = {
      assignedModels: new Map([[turnId, { model: "worker-a", instanceId: "account-1" }]]),
    };
    const [main, child] = groupToolActivities(
      [row("a", "tool.started", {}, 1), row("b", "tool.started", { parentToolUseId: "parent" }, 2)],
      options,
    );
    expect(main).toMatchObject({ executorSource: "turn-assigned", summarySource: "local" });
    expect(main!.executorLabel).toContain("worker-a");
    expect(child!.executorSource).toBe("unknown");
    expect(child!.executorLabel).not.toContain("worker-a");
  });
  it("uses only closed fields for inference, classifies read-only diff separately and balances neutral IDs reproducibly", () => {
    const events = [
      row("a", "tool.completed", shell("c", "git diff -- config.ts"), 1),
      row("b", "tool.updated", shell("d", "cat .env"), 2),
      row(
        "c",
        "tool.completed",
        {
          itemId: "e",
          data: {
            toolName: "Read",
            input: { path: "https://invalid/?token=FAKE_PRIVATE" },
            result: { content: "FAKE_PRIVATE" },
          },
        },
        3,
      ),
    ];
    const groups = groupToolActivities(events);
    const facts = buildToolActivityFacts(groups);
    expect(JSON.stringify(groups)).not.toContain("FAKE_PRIVATE");
    expect(JSON.stringify(facts)).not.toContain("config.ts");
    expect(facts[0]).toMatchObject({ action: "read", subject: "diff", confirmedDiffCount: 0 });
    expect(selectToolActivitySummaryFamily(facts[0]!, "a")).toBe("qwen-coder");
    expect(selectToolActivitySummaryFamily(facts[1]!, "b")).toBe("granite");
    const neutral = { ...facts[1]!, action: "other" as const };
    const routes = Array.from({ length: 32 }, (_, i) =>
      selectToolActivitySummaryFamily(neutral, String(i)),
    );
    expect(new Set(routes)).toEqual(new Set(["granite", "qwen-coder"]));
    expect(routes).toEqual(
      routes.map((_, i) => selectToolActivitySummaryFamily(neutral, String(i))),
    );
  });
});
