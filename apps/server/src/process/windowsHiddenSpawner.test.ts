// @effect-diagnostics nodeBuiltinImport:off - Verify the actual Node spawn options.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

const nodeChildProcess = NodeModule.createRequire(import.meta.url)(
  "node:child_process",
) as typeof NodeChildProcess;

it.effect("hides the console for processes spawned by the Node Effect service", () =>
  Effect.gen(function* () {
    const spawn = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const spy = vi.spyOn(nodeChildProcess, "spawn");
        NodeModule.syncBuiltinESMExports();
        return spy;
      }),
      (spy) =>
        Effect.sync(() => {
          spy.mockRestore();
          NodeModule.syncBuiltinESMExports();
        }),
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", ""]));
    const exitCode = yield* child.exitCode;
    expect(exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["-e", ""],
      expect.objectContaining({ windowsHide: true }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
