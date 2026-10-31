import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import { makeProviderTurnHistory } from "./ProviderTurnHistory.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const turn = (value: string) => TurnId.make(value);
const make = (directory: string) =>
  makeProviderTurnHistory({
    directory,
    provider: ProviderDriverKind.make("claudeAgent"),
    threadId: ThreadId.make("한글/../thread"),
  });

describe("ProviderTurnHistory", () => {
  it.effect(
    "keeps active items out of completed snapshots and reads every completed source exactly",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const history = yield* make(directory);
        const raw = {
          role: "user",
          content: [{ type: "tool_result", text: '원문\n\u0000\\"🙂'.repeat(100_000) }],
        };
        yield* history.append(turn("one"), raw);
        expect(history.count()).toBe(0);
        expect(yield* history.read).toEqual([]);
        yield* history.complete(turn("one"));
        yield* history.append(turn("one"), { steering: "later result" });
        yield* history.complete(turn("one"));
        expect(history.count()).toBe(1);
        expect(yield* history.read).toEqual([
          { id: "one", items: [raw, { steering: "later result" }] },
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves rollback sources on disk and gives a reused turn id a fresh file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const history = yield* make(directory);
      for (const id of ["one", "two", "three"]) {
        yield* history.append(turn(id), { text: id });
        yield* history.complete(turn(id));
      }
      yield* history.rollback(2);
      expect(history.count()).toBe(1);
      expect(yield* history.read).toEqual([{ id: "one", items: [{ text: "one" }] }]);
      yield* history.append(turn("two"), { text: "replacement" });
      yield* history.complete(turn("two"));
      expect(yield* history.read).toEqual([
        { id: "one", items: [{ text: "one" }] },
        { id: "two", items: [{ text: "replacement" }] },
      ]);
      const [session] = yield* fs.readDirectory(directory);
      const files = yield* fs.readDirectory(path.join(directory, session!));
      expect(files.filter((file) => file !== "index.ndjson")).toHaveLength(4);
      const rolledBack = yield* fs.readFileString(path.join(directory, session!, "1.ndjson"));
      expect(yield* decodeJson(rolledBack)).toEqual({ text: "two" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("supports empty turns, excessive rollback and independent sessions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const first = yield* make(directory);
      const second = yield* make(directory);
      yield* first.complete(turn("empty"));
      yield* second.append(turn("empty"), { private: "second" });
      yield* second.complete(turn("empty"));
      expect(yield* first.read).toEqual([{ id: "empty", items: [] }]);
      expect(yield* second.read).toEqual([{ id: "empty", items: [{ private: "second" }] }]);
      yield* first.rollback(100);
      expect(yield* first.read).toEqual([]);
      expect(second.count()).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not report a completed turn when disk storage fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const blocked = path.join(directory, "file-not-directory");
      yield* fs.writeFileString(blocked, "occupied");
      const history = yield* make(blocked);
      const appended = yield* history.append(turn("one"), { text: "preserve" }).pipe(Effect.result);
      expect(appended._tag).toBe("Failure");
      const completed = yield* history.complete(turn("one")).pipe(Effect.result);
      expect(completed._tag).toBe("Failure");
      expect(history.count()).toBe(0);
      expect(yield* history.read).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
