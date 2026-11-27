import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import type * as NodeWorkerThreads from "node:worker_threads";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type { IPty } from "node-pty";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const windowsTest = it.skipIf(HostProcessPlatform.defaultValue() !== "win32");

async function observeProgram(
  source: string,
  afterSpawn?: (terminal: IPty, signal: AbortSignal) => Promise<void>,
) {
  const pty: typeof import("node-pty") = require("node-pty");
  const terminal = pty.spawn(process.execPath, ["-e", source], {
    cols: 120,
    rows: 30,
    useConptyDll: true,
  });
  // Observe the actual forwarding thread in the pinned node-pty dependency.
  const { _worker: worker } = (
    terminal as IPty & { _agent: { _conoutSocketWorker: { _worker: NodeWorkerThreads.Worker } } }
  )._agent._conoutSocketWorker;
  let output = "";
  const data = terminal.onData((chunk) => {
    output += chunk;
  });
  let exited = false;
  let exitCode: number | undefined;
  const exit = terminal.onExit((event) => {
    exited = true;
    exitCode = event.exitCode;
  });
  const signal = AbortSignal.timeout(10_000);
  try {
    await Promise.all([
      NodeEvents.EventEmitter.once(worker, "exit", { signal }),
      afterSpawn?.(terminal, signal),
    ]);
    expect(exited).toBe(true);
    expect(worker.threadId).toBe(-1);
    return { exitCode, output };
  } catch (failure) {
    if (!exited) {
      try {
        process.kill(terminal.pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    throw failure;
  } finally {
    if (worker.threadId !== -1) await worker.terminate();
    data.dispose();
    exit.dispose();
  }
}

windowsTest(
  "releases the output worker when a silent ConPTY program is stopped",
  async () => {
    // Confirm the child is running without writing a readiness marker to the PTY.
    const pipe = `\\\\.\\pipe\\conpty-worker-test-${NodeCrypto.randomUUID()}`;
    const ready = NodeNet.createServer((socket) => socket.end());
    try {
      ready.listen(pipe);
      await NodeEvents.EventEmitter.once(ready, "listening");
      const source = `require("node:net").connect(${JSON.stringify(pipe)}); setTimeout(() => {}, 60000)`;
      await observeProgram(source, async (terminal, signal) => {
        await NodeEvents.EventEmitter.once(ready, "connection", { signal });
        terminal.kill();
      });
    } finally {
      ready.close();
    }
  },
  15_000,
);

windowsTest(
  "delivers final output and releases the worker after a natural ConPTY exit",
  async () => {
    const lines = Array.from(
      { length: 512 },
      (_, index) => `output-${String(index).padStart(4, "0")}`,
    );
    const source = `
    for (let i = 0; i < ${lines.length}; i++) process.stdout.write("output-" + String(i).padStart(4, "0") + "\\r\\n");
    process.exitCode = 23;
  `;
    const { exitCode, output } = await observeProgram(source);
    expect(exitCode).toBe(23);
    expect(output.match(/output-\d{4}/g)).toEqual(lines);
  },
  15_000,
);
