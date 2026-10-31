import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { writeFileStringAtomically } from "./atomicWrite.ts";

const renameFailure = (code: string) =>
  PlatformError.systemError({
    _tag: code === "EACCES" ? "PermissionDenied" : "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: "/tmp/target.json.abc/contents.tmp",
    cause: Object.assign(new Error(`${code}: operation not permitted, rename`), { code }),
  });

const makeFileSystem = (renameOutcomes: ReadonlyArray<string | null>) => {
  const renames: Array<readonly [string, string]> = [];
  const layer = FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    makeTempDirectoryScoped: () => Effect.succeed("/tmp/target.json.abc"),
    writeFileString: () => Effect.void,
    // Suspend so each retry re-runs the stub rather than replaying the
    // outcome captured when the effect value was first built.
    rename: (from, to) =>
      Effect.suspend(() => {
        renames.push([from, to] as const);
        const outcome = renameOutcomes[renames.length - 1] ?? null;
        return outcome === null ? Effect.void : Effect.fail(renameFailure(outcome));
      }),
  });
  return { layer, renames };
};

describe("writeFileStringAtomically", () => {
  it.effect("writes hash-named artifacts near the Windows path limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-path-" });
      const directory = path.join(root, "n".repeat(Math.max(1, 180 - root.length)));
      const filePath = path.join(directory, "a".repeat(64) + ".json");
      yield* writeFileStringAtomically({ filePath, contents: "first", mode: 0o600 });
      yield* writeFileStringAtomically({ filePath, contents: "replacement", mode: 0o600 });
      assert.strictEqual(yield* fs.readFileString(filePath), "replacement");
      assert.deepStrictEqual(yield* fs.readDirectory(directory), ["a".repeat(64) + ".json"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  // The retry backoff sleeps on the Clock, so these two run on the live
  // clock rather than the TestClock `it.effect` installs.
  it.live("retries the final rename while Windows reports the target as in use", () =>
    Effect.gen(function* () {
      const fs = makeFileSystem(["EPERM", "EBUSY", null]);
      yield* writeFileStringAtomically({ filePath: "/tmp/target.json", contents: "{}" }).pipe(
        Effect.provide(fs.layer),
      );
      assert.strictEqual(fs.renames.length, 3);
      // The temp path is joined by the host Path service (backslashes on
      // Windows), so only pin the file names.
      assert.ok(fs.renames[0]?.[0].endsWith("contents.tmp"));
      assert.strictEqual(fs.renames[0]?.[1], "/tmp/target.json");
      assert.ok(
        fs.renames.every(([from, to]) => from === fs.renames[0]?.[0] && to === "/tmp/target.json"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("gives up after the retry budget so a stuck target still surfaces", () =>
    Effect.gen(function* () {
      const fs = makeFileSystem(Array.from({ length: 20 }, () => "EPERM"));
      const result = yield* writeFileStringAtomically({
        filePath: "/tmp/target.json",
        contents: "{}",
      }).pipe(Effect.provide(fs.layer), Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(fs.renames.length, 11);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not retry rename failures that are not transient", () =>
    Effect.gen(function* () {
      const fs = makeFileSystem(["ENOENT", null]);
      const result = yield* writeFileStringAtomically({
        filePath: "/tmp/target.json",
        contents: "{}",
      }).pipe(Effect.provide(fs.layer), Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(fs.renames.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
