import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

const spawn = vi.fn(() => ({
  pid: 42,
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("node-pty", () => ({ spawn }));

const testLayer = NodePtyAdapter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HostProcessPlatform, "win32"),
      Layer.succeed(HostProcessArchitecture, "x64"),
    ),
  ),
);

it.effect("spawns through the public adapter with the provided host references", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "cmd.exe",
      args: ["/d", "/q"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "cmd.exe",
      ["/d", "/q"],
      {
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: {},
        name: "xterm-color",
      },
    ]);
    process.kill("SIGTERM");
    process.kill("SIGKILL");
    assert.deepEqual(spawn.mock.results[0]?.value.kill.mock.calls, [[undefined], [undefined]]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native binding could not be loaded");
    const exit = yield* NodePtyAdapter.make(() => Promise.reject(cause)).pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
      });
      assert.equal(error.message, "Failed to load node-pty for win32-x64.");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(HostProcessArchitecture, "x64"),
      ),
    ),
  ),
);

it.effect("reads the current native pid after ConPTY becomes ready", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "cmd.exe",
      args: ["/d", "/q"],
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: {},
    });
    const native = spawn.mock.results.at(-1)!.value;
    native.pid = 0;
    assert.equal(process.pid, 0);
    native.pid = 1234;
    assert.equal(process.pid, 1234);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves CMD arguments and Unicode working directories for native quoting", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const args = ["/d", "/s", "/c", 'node.exe "C:\\작업 폴더\\worker.mjs" "a b" ""'];
    yield* adapter.spawn({
      useConptyDll: true,
      shell: "cmd.exe",
      args,
      cwd: "C:\\작업 폴더",
      cols: 80,
      rows: 24,
      env: { T3_TEST_VALUE: "한글 value" },
    });
    assert.deepEqual(spawn.mock.lastCall, [
      "cmd.exe",
      args,
      {
        cwd: "C:\\작업 폴더",
        cols: 80,
        rows: 24,
        env: { T3_TEST_VALUE: "한글 value" },
        name: "xterm-color",
        useConptyDll: true,
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);
