import type { ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ProviderAdapterProcessError } from "./Errors.ts";
import type { ProviderThreadTurnSnapshot } from "./Services/ProviderAdapter.ts";

interface TurnEntry {
  readonly id: TurnId;
  readonly file: string;
  bytes: number;
}

interface ProviderTurnHistoryInput {
  readonly directory: string;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
}

export interface ProviderTurnHistory {
  readonly count: () => number;
  readonly append: (
    turnId: TurnId,
    item: unknown,
  ) => Effect.Effect<void, ProviderAdapterProcessError>;
  readonly complete: (turnId: TurnId) => Effect.Effect<void, ProviderAdapterProcessError>;
  readonly read: Effect.Effect<
    ReadonlyArray<ProviderThreadTurnSnapshot>,
    ProviderAdapterProcessError
  >;
  readonly rollback: (numTurns: number) => Effect.Effect<void, ProviderAdapterProcessError>;
}

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Native snapshots live on disk; sessions retain only turn identities and file boundaries. */
export const makeProviderTurnHistory = Effect.fn("makeProviderTurnHistory")(function* (
  input: ProviderTurnHistoryInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const gate = yield* Semaphore.make(1);
  const entries = new Map<TurnId, TurnEntry>();
  let completed: TurnEntry[] = [];
  let directory: string | undefined;
  let nextFile = 0;

  const failure = (cause: unknown) =>
    new ProviderAdapterProcessError({
      provider: input.provider,
      threadId: input.threadId,
      detail: "Could not store or read the provider's native turn history.",
      cause,
    });

  const ensureDirectory = Effect.fnUntraced(function* () {
    if (directory !== undefined) return directory;
    const hash = yield* crypto.digest("SHA-256", new TextEncoder().encode(input.threadId));
    yield* fs.makeDirectory(input.directory, { recursive: true, mode: 0o700 });
    const created = yield* fs.makeTempDirectory({
      directory: input.directory,
      prefix: `${Encoding.encodeHex(hash).slice(0, 20)}-`,
    });
    yield* fs.writeFileString(
      path.join(created, "index.ndjson"),
      `${yield* encode({ version: 1, provider: input.provider, threadId: input.threadId })}\n`,
      { mode: 0o600 },
    );
    directory = created;
    return created;
  });

  const entryFor = Effect.fnUntraced(function* (turnId: TurnId) {
    const existing = entries.get(turnId);
    if (existing !== undefined) return existing;
    const root = yield* ensureDirectory();
    const entry = { id: turnId, file: path.join(root, `${nextFile++}.ndjson`), bytes: 0 };
    entries.set(turnId, entry);
    return entry;
  });

  const append: ProviderTurnHistory["append"] = (turnId, item) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const entry = yield* entryFor(turnId);
          const line = `${yield* encode(item)}\n`;
          yield* fs
            .writeFileString(entry.file, line, { flag: "a", mode: 0o600 })
            .pipe(Effect.onError(() => fs.truncate(entry.file, entry.bytes).pipe(Effect.ignore)));
          entry.bytes += new TextEncoder().encode(line).byteLength;
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.mapError(failure));

  const complete: ProviderTurnHistory["complete"] = (turnId) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          if (completed.some((entry) => entry.id === turnId)) return;
          const entry = yield* entryFor(turnId);
          const root = yield* ensureDirectory();
          yield* fs.writeFileString(
            path.join(root, "index.ndjson"),
            `${yield* encode({ type: "complete", turnId, file: path.basename(entry.file), bytes: entry.bytes })}\n`,
            { flag: "a", mode: 0o600 },
          );
          completed.push(entry);
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.mapError(failure));

  // Capture byte boundaries under the write lock. Disk reads then leave ongoing turns unblocked.
  const read: ProviderTurnHistory["read"] = gate
    .withPermit(Effect.sync(() => completed.map((entry) => ({ ...entry }))))
    .pipe(
      Effect.flatMap((snapshot) =>
        Effect.forEach(
          snapshot,
          (entry) =>
            (entry.bytes === 0
              ? Effect.succeed([])
              : fs.stream(entry.file, { bytesToRead: entry.bytes }).pipe(
                  Stream.decodeText(),
                  Stream.splitLines,
                  Stream.filter((line) => line.length > 0),
                  Stream.mapEffect((line) => decode(line)),
                  Stream.runCollect,
                )
            ).pipe(Effect.map((items) => ({ id: entry.id, items }))),
          { concurrency: 1 },
        ),
      ),
      Effect.mapError(failure),
    );

  const rollback: ProviderTurnHistory["rollback"] = (numTurns) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const keep = Math.max(0, completed.length - numTurns);
          if (keep === completed.length) return;
          const removed = completed.slice(keep);
          const root = yield* ensureDirectory();
          yield* fs.writeFileString(
            path.join(root, "index.ndjson"),
            `${yield* encode({ type: "rollback", turnIds: removed.map((entry) => entry.id) })}\n`,
            { flag: "a", mode: 0o600 },
          );
          completed = completed.slice(0, keep);
          for (const entry of removed) entries.delete(entry.id);
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.mapError(failure));

  return {
    count: () => completed.length,
    append,
    complete,
    read,
    rollback,
  } satisfies ProviderTurnHistory;
});

export const makeProviderTurnHistoryFactory = Effect.context<
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
>().pipe(
  Effect.map(
    (context) => (input: ProviderTurnHistoryInput) =>
      makeProviderTurnHistory(input).pipe(Effect.provide(context)),
  ),
);
