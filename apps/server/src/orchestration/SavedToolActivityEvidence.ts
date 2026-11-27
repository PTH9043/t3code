// @effect-diagnostics nodeBuiltinImport:off
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { OrchestrationThreadActivity as Activity, ThreadId } from "@t3tools/contracts";
import { toolActivityCallIdentity } from "@t3tools/shared/toolActivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/u.test(value)
    ? value
    : undefined;
}
interface Canonical {
  event: string;
  turn: string;
  kind: string;
  call: string;
  provider: string;
  instance?: string | undefined;
  session?: string | undefined;
  parent?: string | undefined;
}
interface Evidence {
  calls: Canonical[];
  models: Map<string, string | null>;
}
function unique<T>(map: Map<string, T | null>, key: string, value: T) {
  if (!map.has(key)) map.set(key, value);
  else if (map.get(key) !== value) map.set(key, null);
}
function modelKey(turn: string, session: string, parent: string | undefined, call: string) {
  return JSON.stringify([turn, session, parent, call]);
}

function collect(evidence: Evidence, threadId: ThreadId, line: string) {
  const canonical = line.startsWith("] CANON: ", 25);
  const native = line.startsWith("] NTIVE: ", 25);
  if (!(canonical || native) || !line.includes('"turnId"')) return;
  if (canonical && !line.includes('"itemId"')) return;
  if (
    native &&
    !line.includes('"tool_use"') &&
    !line.includes('"server_tool_use"') &&
    !line.includes('"mcp_tool_use"')
  )
    return;
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(line.slice(34)));
  } catch {
    return;
  }
  if (canonical) {
    const kinds: Record<string, string> = {
      "item.started": "tool.started",
      "item.updated": "tool.updated",
      "item.completed": "tool.completed",
    };
    const kind = kinds[String(body.type)];
    const turn = identifier(body.turnId),
      event = identifier(body.eventId);
    const call = identifier(body.itemId),
      provider = identifier(body.provider);
    if (!kind || body.threadId !== threadId || !event || !turn || !call || !provider) return;
    const raw = record(record(body.raw).payload);
    evidence.calls.push({
      event,
      turn,
      call,
      kind,
      provider,
      instance: identifier(body.providerInstanceId),
      session: identifier(raw.session_id),
      parent: identifier(raw.parent_tool_use_id),
    });
  } else {
    const entry = record(body.event),
      payload = record(entry.payload),
      message = record(payload.message);
    const session = identifier(payload.session_id),
      turn = identifier(entry.turnId),
      model = identifier(message.model);
    if (
      entry.provider !== "claudeAgent" ||
      payload.type !== "assistant" ||
      !session ||
      !turn ||
      !model ||
      !Array.isArray(message.content)
    )
      return;
    for (const value of message.content) {
      const block = record(value),
        call = identifier(block.id);
      if (
        call &&
        (block.type === "tool_use" ||
          block.type === "server_tool_use" ||
          block.type === "mcp_tool_use")
      ) {
        unique(
          evidence.models,
          modelKey(turn, session, identifier(payload.parent_tool_use_id), call),
          model,
        );
      }
    }
  }
}

// Only allowlisted metadata survives parsing. Immutable rotations can serve repeated detail and RPC reads.
const cache = new Map<string, Promise<Evidence>>();
async function readShard(path: string, thread: ThreadId, earliest: string, latest: string) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) return;
  if (metadata.mtime.toISOString().slice(0, 19) < earliest) return;
  const file = await open(path, "r");
  try {
    const prefix = Buffer.alloc(25);
    await file.read(prefix, 0, prefix.length, 0);
    const first = prefix.toString("ascii").slice(1, 20);
    if (first > latest) return;
    const key = JSON.stringify([path, thread, metadata.ino, metadata.size, metadata.mtimeMs]);
    const cached = cache.get(key);
    if (cached) return await cached;
    const read = async (): Promise<Evidence> => {
      const evidence: Evidence = { calls: [], models: new Map() };
      const stream = file.createReadStream({ start: 0, end: metadata.size - 1, autoClose: false });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) collect(evidence, thread, line);
      } finally {
        lines.close();
        stream.destroy();
      }
      return evidence;
    };
    const job = read();
    cache.set(key, job);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
    try {
      return await job;
    } catch (cause) {
      cache.delete(key);
      throw cause;
    }
  } finally {
    await file.close();
  }
}

export async function recoverSavedToolActivityEvidence(
  dir: string,
  thread: ThreadId,
  rows: readonly Activity[],
) {
  const segment = toSafeThreadAttachmentSegment(thread);
  const legacy = rows.filter(
    (row) => row.turnId && row.kind.startsWith("tool.") && !record(row.payload).provider,
  );
  if (!segment || !legacy.length) return rows;
  const times = legacy.map((row) => row.createdAt.slice(0, 19)).sort();
  const events = new Map<string, Activity>(legacy.map((row) => [row.id, row]));
  const byEvent = new Map<string, Canonical | null>();
  const sources = new Map<string, Canonical | null>();
  const models = new Map<string, string | null>();
  const scope = (turn: string, parent: unknown, call: string) =>
    JSON.stringify([turn, parent ?? null, call]);
  for (let rotation = 0; ; rotation++) {
    const path = join(dir, `events.${segment}.log${rotation ? "." + rotation : ""}`);
    let evidence;
    try {
      evidence = await readShard(path, thread, times[0]!, times.at(-1)!);
    } catch {
      break;
    }
    if (!evidence) continue;
    for (const [key, model] of evidence.models) {
      if (model === null) models.set(key, null);
      else unique(models, key, model);
    }
    for (const c of evidence.calls) {
      const linked = events.get(c.event);
      if (!linked || linked.turnId !== c.turn || linked.kind !== c.kind) continue;
      const old = byEvent.get(c.event);
      if (old === undefined) byEvent.set(c.event, c);
      else if (!old || JSON.stringify(old) !== JSON.stringify(c)) byEvent.set(c.event, null);
      const key = scope(c.turn, c.parent, c.call),
        prior = sources.get(key);
      if (prior === undefined) sources.set(key, c);
      else if (
        !prior ||
        prior.provider !== c.provider ||
        prior.instance !== c.instance ||
        prior.session !== c.session
      )
        sources.set(key, null);
    }
  }
  return rows.map((row) => {
    if (!row.turnId || !events.has(row.id)) return row;
    const p = record(row.payload),
      stored = toolActivityCallIdentity(p),
      direct = byEvent.get(row.id);
    if (stored.toolCallIdAmbiguous) return row;
    if (direct === null || (direct && stored.toolCallId && stored.toolCallId !== direct.call)) {
      return { ...row, payload: { ...p, toolCallIdAmbiguous: true } };
    }
    const src =
      direct ??
      (stored.toolCallId
        ? sources.get(scope(row.turnId, p.parentToolUseId, stored.toolCallId))
        : undefined);
    if (src === null) return { ...row, payload: { ...p, toolCallIdAmbiguous: true } };
    if (!src || (p.parentToolUseId && src.parent !== p.parentToolUseId)) return row;
    const model =
      src.session && src.provider === "claudeAgent"
        ? models.get(modelKey(src.turn, src.session, src.parent, src.call))
        : undefined;
    return {
      ...row,
      payload: {
        ...p,
        toolCallId: src.call,
        provider: src.provider,
        ...(src.parent ? { parentToolUseId: src.parent } : {}),
        ...(src.instance ? { providerInstanceId: src.instance } : {}),
        ...(model && !p.reportedModel ? { reportedModel: model } : {}),
      },
    };
  });
}

const encodeTurnIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Read terminal states from the same SQLite snapshot as this page, including interrupted turns
 * without a checkpoint. A missing row or a running turn carries no terminal signal. */
export const withSavedToolTurnStates = Effect.fn("withSavedToolTurnStates")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  rows: readonly Activity[],
) {
  const turnIds = new Set<string>();
  for (const row of rows) {
    if (row.turnId && row.kind.startsWith("tool.")) turnIds.add(row.turnId);
  }
  if (turnIds.size === 0) return rows;
  const ids = yield* encodeTurnIds([...turnIds]);
  const states = yield* sql<{ turnId: string; state: "completed" | "interrupted" | "error" }>`
    SELECT turn_id AS turnId, state FROM projection_turns
    WHERE thread_id = ${threadId} AND turn_id IN (SELECT value FROM json_each(${ids}))
      AND state IN ('completed', 'interrupted', 'error')
  `;
  const terminal = new Map(states.map((row) => [row.turnId, row.state]));
  return rows.map((row) => {
    if (!row.kind.startsWith("tool.")) return row;
    const payload = record(row.payload);
    const state = row.turnId ? terminal.get(row.turnId) : undefined;
    if (state) return { ...row, payload: { ...payload, toolActivityTurnState: state } };
    if (!("toolActivityTurnState" in payload)) return row;
    const { toolActivityTurnState: _, ...rest } = payload;
    return { ...row, payload: rest };
  });
});

export const withSavedToolActivityEvidence = Effect.fn("withSavedToolActivityEvidence")(function* (
  threadId: ThreadId,
  rows: readonly Activity[],
) {
  const config = yield* Effect.serviceOption(ServerConfig);
  if (Option.isNone(config)) return rows;
  return yield* Effect.tryPromise(() =>
    recoverSavedToolActivityEvidence(config.value.providerLogsDir, threadId, rows),
  ).pipe(Effect.orElseSucceed(() => rows));
});
