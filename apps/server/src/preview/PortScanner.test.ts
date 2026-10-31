import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";
const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: (input) =>
    Effect.fail(
      new ProcessRunner.ProcessSpawnError({
        command: input.command,
        argumentCount: input.args.length,
        cwd: input.cwd,
        cause: PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "The process probe is unavailable in the test environment",
        }),
      }),
    ),
});

effectIt("uses native Windows commands and preserves process and terminal ownership", () =>
  Effect.gen(function* () {
    const commands: string[] = [];
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) => {
              commands.push(input.command);
              const stdout =
                input.command === "netstat.exe"
                  ? "  TCP    0.0.0.0:53123    0.0.0.0:0    LISTENING    1234\r\n  TCP    127.0.0.1:53124    127.0.0.1:443    ESTABLISHED    1234\r\n"
                  : '"node.exe","1234","Console","1","100 K"\r\n';
              return Effect.succeed({
                stdout,
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            },
          }),
          Net.layer,
          Layer.succeed(HostProcessPlatform, "win32"),
        ),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.registerTerminalProcesses({
        threadId: "thread-one",
        terminalId: "terminal-one",
        processIds: [1234],
      });
      return yield* scanner.scan();
    }).pipe(Effect.provide(layer), Effect.scoped);
    expect(commands).toEqual(["netstat.exe", "tasklist.exe"]);
    expect(result).toEqual([
      expect.objectContaining({
        port: 53123,
        pid: 1234,
        processName: "node",
        terminal: { threadId: "thread-one", terminalId: "terminal-one" },
      }),
    ]);
  }),
);

const makeProbeFailureLayer = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(TestProcessRunner, Net.layer, Layer.succeed(HostProcessPlatform, "win32")),
  ),
);

const openServer = (port: number): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer();
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
) {
  for (const port of ports) {
    const server = yield* openServer(port);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS),
  ({ server }) => closeServer(server),
);

effectIt("discovers a real Windows listener with native commands", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) !== "win32") return;
    const { port } = yield* commonDevServer;
    const scanner = yield* PortScanner.PortDiscovery;
    const found = (yield* scanner.scan()).find((entry) => entry.port === port);
    expect(found?.pid).toBe(process.pid);
    expect(found?.processName?.toLowerCase()).toBe("node");
  }).pipe(
    Effect.provide(
      PortScanner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
            Net.layer,
            Layer.succeed(HostProcessPlatform, "win32"),
          ),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

/**
 * Integration tests against a real TCP listener. We provide the Windows host
 * platform so the tests exercise the TCP-probe fallback without depending on
 * `lsof` being installed.
 */
effectIt.layer(TestPortDiscoveryLive)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns a server we just opened on a curated dev port",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      expect(found).toBeDefined();
      expect(found?.host).toBe("localhost");
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe((servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

effectIt("does not swallow process probe defects", () =>
  Effect.gen(function* () {
    const defect = new Error("unexpected process probe defect");
    const layer = makeProbeFailureLayer(() => Effect.die(defect));

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  }),
);

effectIt("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = makeProbeFailureLayer(() => Effect.interrupt);

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);
