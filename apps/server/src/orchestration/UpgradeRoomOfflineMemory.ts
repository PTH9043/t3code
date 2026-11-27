// @effect-diagnostics nodeBuiltinImport:off - The detached worker writes this file without the backend.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WATCHDOG_OFFLINE_MEMORY_FILE } from "../mcp/WatchdogOfflineTools.ts";

const OfflineMemoryRecord = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("workspace_memory.remember"),
  projectId: ProjectId,
  threadId: ThreadId,
  providerInstanceId: Schema.optional(Schema.String),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  topic: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  scope: Schema.Literals(["project", "global"]),
  folder: Schema.NullOr(Schema.String),
  recordedAt: Schema.String,
});
export type UpgradeRoomOfflineMemoryRecord = typeof OfflineMemoryRecord.Type;
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(OfflineMemoryRecord));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Imports memories the detached worker queued while the backend was away.
 * The queue file is first renamed so worker appends land in a fresh file; a
 * leftover `.importing` file from an interrupted import is replayed, which is
 * safe because `remember` is idempotent per (projectId, requestId). Lines that
 * cannot be imported are kept in `.rejected` instead of being retried forever.
 */
export const importUpgradeRoomOfflineMemory = <A, E>(input: {
  readonly stateDir: string;
  readonly remember: (record: UpgradeRoomOfflineMemoryRecord) => Effect.Effect<A, E>;
}) =>
  Effect.gen(function* () {
    const file = NodePath.join(input.stateDir, WATCHDOG_OFFLINE_MEMORY_FILE);
    const importing = `${file}.importing`;
    const rejectedFile = `${file}.rejected`;
    let imported = 0;
    let rejected = 0;
    const seen = new Set<string>();
    const reject = (line: string, reason: string) =>
      Effect.sync(() => {
        rejected += 1;
        NodeFS.appendFileSync(rejectedFile, `${encodeJson({ line, reason })}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      });
    for (let pass = 0; pass < 2; pass += 1) {
      const ready = yield* Effect.sync(() => {
        if (NodeFS.existsSync(importing)) return true;
        if (!NodeFS.existsSync(file)) return false;
        NodeFS.renameSync(file, importing);
        return true;
      });
      if (!ready) break;
      const lines = yield* Effect.sync(() => NodeFS.readFileSync(importing, "utf8").split("\n"));
      for (const line of lines) {
        if (!line.trim()) continue;
        let record: UpgradeRoomOfflineMemoryRecord;
        try {
          record = decodeRecord(line);
        } catch {
          yield* reject(line, "invalid-record");
          continue;
        }
        const key = `${record.projectId}\u0000${record.requestId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const result = yield* Effect.exit(input.remember(record));
        if (result._tag === "Success") imported += 1;
        else if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.interrupt;
        else yield* reject(line, Cause.pretty(result.cause).slice(0, 500));
      }
      yield* Effect.sync(() => NodeFS.rmSync(importing, { force: true }));
    }
    return { imported, rejected };
  });
