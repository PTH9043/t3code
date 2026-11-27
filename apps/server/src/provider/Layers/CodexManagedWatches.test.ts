import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Wire from "effect-codex-app-server/schema";
import { makeCodexManagedWatches } from "./CodexManagedWatches.ts";

type Item = Extract<Wire.V2ItemCompletedNotification["item"], { type: "mcpToolCall" }>;
function item(id: string, tool: string, output: string, args: object = {}): Item {
  return {
    id,
    type: "mcpToolCall",
    server: "t3-claude-tools",
    tool,
    status: "completed",
    arguments: args,
    result: { content: [{ type: "text", text: output }] },
  };
}

it.effect(
  "targets acknowledged monitor IDs on the originating native thread, including late completions",
  () =>
    Effect.gen(function* () {
      let enabled = true;
      const calls: Wire.V2McpServerToolCallParams[] = [];
      const make = () =>
        makeCodexManagedWatches(
          (request) =>
            Effect.sync(() => {
              calls.push(request);
              return {
                content: [],
                structuredContent:
                  request.tool === "ScheduleWakeup" ? { stopped: true } : request.arguments,
              };
            }),
          Effect.sync(() => enabled),
        );
      const room = make(),
        other = make();
      const monitor = item(
        "first",
        "Monitor",
        '{"taskId":"known","status":"running","timeoutMs":60000}',
      );
      yield* room.observe("native-child", monitor, "item/completed");
      yield* other.observe("other-native", monitor, "item/completed");
      yield* room.observe("native", { ...monitor, server: "another-server" }, "item/completed");
      yield* room.observe(
        "native",
        item("shell", "Bash", '{"taskId":"background-shell"}'),
        "item/completed",
      );
      yield* room.observe(
        "native",
        item("bad", "Monitor", '{"taskId":"invalid","error":"failed"}'),
        "item/completed",
      );
      yield* room.observe(
        "native",
        item("wake", "ScheduleWakeup", '{"scheduledFor":9007199254740991}', { delaySeconds: 60 }),
        "item/completed",
      );
      const late = item("pending", "Monitor", '{"taskId":"late","persistent":true,"timeoutMs":0}');
      yield* room.observe("native", late, "item/started");
      enabled = false;
      yield* room.stop;
      enabled = true;
      yield* room.observe("native", late, "item/completed");
      yield* room.stop;
      expect(calls).toEqual([
        {
          threadId: "native-child",
          server: "t3-claude-tools",
          tool: "TaskStop",
          arguments: { task_id: "known" },
        },
        {
          threadId: "native",
          server: "t3-claude-tools",
          tool: "ScheduleWakeup",
          arguments: { stop: true },
        },
        {
          threadId: "native",
          server: "t3-claude-tools",
          tool: "TaskStop",
          arguments: { task_id: "late" },
        },
      ]);
    }),
);

it.effect("retains an unconfirmed stop for retry and forgets a confirmed native TaskStop", () =>
  Effect.gen(function* () {
    let success = false;
    const stopped: unknown[] = [];
    const room = makeCodexManagedWatches(
      (request) =>
        Effect.sync(() => {
          stopped.push(request.arguments);
          return {
            content: [],
            structuredContent: success ? request.arguments : { success: false },
          };
        }),
      Effect.succeed(true),
    );
    yield* room.observe(
      "n",
      item("a", "Monitor", '{"taskId":"a","timeoutMs":60000}'),
      "item/completed",
    );
    yield* room.observe(
      "n",
      item("b", "Monitor", '{"taskId":"b","timeoutMs":60000}'),
      "item/completed",
    );
    yield* room.observe(
      "n",
      item("stop", "TaskStop", '{"task_id":"b"}', { task_id: "b" }),
      "item/completed",
    );
    expect((yield* Effect.exit(room.stop))._tag).toBe("Failure");
    success = true;
    yield* room.stop;
    yield* room.stop;
    expect(stopped).toEqual([{ task_id: "a" }, { task_id: "a" }]);
  }),
);
