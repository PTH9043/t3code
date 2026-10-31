// @effect-diagnostics nodeBuiltinImport:off -- This small process forwards inherited stdio pipes.
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";

const MAX_BOOTSTRAP_BYTES = 1024 * 1024;

/** Forward Windows-side stdin/stdout through wsl.exe to a server's private pipes. */
export function runWslDirectBridge(serverEntry: string, serverArgs: readonly string[]): void {
  let buffered = Buffer.alloc(0);
  let launched = false;

  const fail = (message: string) => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    process.stdin.destroy();
  };

  const launch = (bootstrap: Buffer, firstData: Buffer) => {
    launched = true;
    process.stdin.pause();
    process.stdin.removeListener("data", onBootstrapData);
    const child = NodeChildProcess.spawn(
      process.execPath,
      [serverEntry, "--bootstrap-fd", "3", ...serverArgs],
      {
        stdio: ["ignore", "pipe", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe"],
        shell: false,
      },
    );
    const streams: ReadonlyArray<NodeStream.Readable | NodeStream.Writable | null | undefined> =
      child.stdio;
    const bootstrapInput = streams[3] as NodeStream.Writable | null | undefined;
    const directInput = streams[6] as NodeStream.Writable | null | undefined;
    const directOutput = streams[7] as NodeStream.Readable | null | undefined;
    if (!bootstrapInput || !directInput || !directOutput || !child.stdout || !child.stderr) {
      child.kill("SIGTERM");
      fail("WSL backend process pipes were not available.");
      return;
    }
    const pipeFailed = (error: Error) => {
      child.kill("SIGTERM");
      fail(`WSL backend process pipe failed: ${error.message}`);
    };
    bootstrapInput.once("error", pipeFailed);
    directInput.once("error", pipeFailed);
    directOutput.once("error", pipeFailed);
    child.stdout.pipe(process.stderr, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    directOutput.pipe(process.stdout, { end: false });
    bootstrapInput.end(Buffer.concat([bootstrap, Buffer.from("\n")]));
    if (firstData.length > 0) directInput.write(firstData);
    process.stdin.pipe(directInput);
    process.stdin.resume();
    process.stdin.once("end", () => child.kill("SIGTERM"));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => child.kill("SIGTERM"));
    }
    child.once("error", (error) => fail(`WSL backend failed to start: ${error.message}`));
    child.once("exit", (code, signal) => {
      process.stdin.destroy();
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  };

  const onBootstrapData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(10);
    if (newline < 0) {
      if (buffered.length > MAX_BOOTSTRAP_BYTES) fail("WSL bootstrap envelope is too large.");
      return;
    }
    if (newline > MAX_BOOTSTRAP_BYTES) {
      fail("WSL bootstrap envelope is too large.");
      return;
    }
    launch(buffered.subarray(0, newline), buffered.subarray(newline + 1));
    buffered = Buffer.alloc(0);
  };

  process.stdin.on("data", onBootstrapData);
  process.stdin.once("end", () => {
    if (!launched) fail("WSL bootstrap envelope was not received.");
  });
}
