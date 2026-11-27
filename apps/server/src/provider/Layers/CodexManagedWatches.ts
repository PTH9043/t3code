import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as Wire from "effect-codex-app-server/schema";

const keyOf = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.NullOr(Schema.String)])),
);
type Item = Extract<Wire.V2ItemCompletedNotification["item"], { type: "mcpToolCall" }>;
type Call = (
  params: Wire.V2McpServerToolCallParams,
) => Effect.Effect<Wire.V2McpServerToolCallResponse, CodexErrors.CodexAppServerError>;
const outputSchema = Schema.Struct({
  task_id: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Int),
  persistent: Schema.optionalKey(Schema.Boolean),
  scheduledFor: Schema.optionalKey(Schema.Number),
  stopped: Schema.optionalKey(Schema.Boolean),
  taskId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Unknown),
  status: Schema.optionalKey(Schema.String),
  success: Schema.optionalKey(Schema.Boolean),
});
const decodeOutput = Schema.decodeUnknownOption(Schema.fromJsonString(outputSchema));
const decodeStructured = Schema.decodeUnknownOption(outputSchema);
const isText = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));
const isArgs = Schema.is(
  Schema.Struct({
    task_id: Schema.optionalKey(Schema.String),
    stop: Schema.optionalKey(Schema.Boolean),
    delaySeconds: Schema.optionalKey(Schema.Number),
  }),
);
type Result = Wire.V2McpServerToolCallResponse;
function output(result: Result | null | undefined) {
  if (!result || result.isError) return undefined;
  const structured = decodeStructured(result.structuredContent);
  if (Option.isSome(structured)) return structured.value;
  if (result.content.length !== 1 || !isText(result.content[0])) return undefined;
  return Option.getOrUndefined(decodeOutput(result.content[0].text));
}
function stopConfirmed(result: Result, taskId: string | null) {
  const value = output(result);
  if (!value || value.error != null || value.success === false) return false;
  return taskId === null ? value.stopped === true : value.task_id === taskId;
}

/** One tracker per actual Codex app-server, keyed by its native thread and MCP task IDs. */
export function makeCodexManagedWatches(call: Call, allowed: Effect.Effect<boolean>) {
  const starts = new Map<string, number>();
  const live = new Map<
    string,
    {
      request: Wire.V2McpServerToolCallParams;
      taskId: string | null;
      expiresAt: number | null;
    }
  >();
  const serial = Semaphore.makeUnsafe(1);
  let generation = 0;

  const cancel = Effect.fn("CodexManagedWatches.cancel")(function* (key: string) {
    const watch = live.get(key);
    if (!watch) return;
    if (watch.expiresAt !== null && watch.expiresAt <= (yield* Clock.currentTimeMillis)) {
      live.delete(key);
      return;
    }
    const result = yield* call(watch.request);
    if (!stopConfirmed(result, watch.taskId)) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "The managed Claude MCP server did not confirm cancellation.",
        undefined,
        { method: "mcpServer/tool/call" },
      );
    }
    live.delete(key);
  });
  const observe = Effect.fn("CodexManagedWatches.observe")(function* (
    threadId: string,
    item: Item,
    phase: "item/started" | "item/completed",
  ) {
    if (
      item.server !== "t3-claude-tools" ||
      !["Monitor", "ScheduleWakeup", "TaskStop"].includes(item.tool)
    )
      return;
    const itemKey = keyOf([threadId, item.id]);
    if (phase === "item/started") {
      starts.set(itemKey, generation);
      return;
    }
    const started = starts.get(itemKey);
    starts.delete(itemKey);
    if (item.status !== "completed" || item.error != null || !item.result) return;
    const value = output(item.result);
    if (
      !value ||
      value.error != null ||
      value.success === false ||
      value.status === "error" ||
      value.status === "failed"
    )
      return;
    const args = isArgs(item.arguments) ? item.arguments : undefined;
    let taskId: string | null = null;
    let expiresAt: number | null = null;
    const now = yield* Clock.currentTimeMillis;
    if (item.tool === "Monitor") {
      if (!value.taskId?.trim() || (value.status !== undefined && value.status !== "running"))
        return;
      if (value.timeoutMs !== undefined && value.timeoutMs > 0) {
        expiresAt = now - (item.durationMs ?? 0) + value.timeoutMs;
      } else if (!value.persistent) return;
      taskId = value.taskId;
    } else if (item.tool === "TaskStop") {
      if (args?.task_id && stopConfirmed(item.result, args.task_id))
        live.delete(keyOf([threadId, args.task_id]));
      return;
    } else if (args?.stop === true) {
      if (stopConfirmed(item.result, null)) live.delete(keyOf([threadId, null]));
      return;
    } else {
      if (
        args?.delaySeconds === undefined ||
        value.scheduledFor === undefined ||
        !Number.isFinite(value.scheduledFor) ||
        value.stopped
      )
        return;
      expiresAt = value.scheduledFor;
    }
    if (expiresAt !== null && expiresAt <= now) return;
    const key = keyOf([threadId, taskId]);
    live.set(key, {
      taskId,
      expiresAt,
      request: {
        threadId,
        server: item.server,
        tool: taskId === null ? "ScheduleWakeup" : "TaskStop",
        arguments: taskId === null ? { stop: true } : { task_id: taskId },
      },
    });
    if ((started !== undefined && started !== generation) || !(yield* allowed)) yield* cancel(key);
  });
  const stop = Effect.gen(function* () {
    generation++;
    const results = yield* Effect.forEach([...live.keys()], (key) => Effect.exit(cancel(key)));
    for (const result of results)
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
  });
  return {
    observe: (...args: Parameters<typeof observe>) => serial.withPermits(1)(observe(...args)),
    stop: serial.withPermits(1)(stop),
  };
}
