// @effect-diagnostics nodeBuiltinImport:off - Standalone stdio transport launched by Codex.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";

const [address, command, ...args] = process.argv.slice(2);
if (!address || !command) throw new Error("Missing managed MCP transport arguments");

function allowed(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(address!);
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      answer += chunk;
    });
    socket.on("error", () => resolve(false));
    socket.on("close", () => resolve(answer === "1"));
  });
}

// Codex supplies the normal MCP process environment and working directory.
// Only a one-bit permission response crosses the local control socket.
// Tool results are relayed without decoding their contents.
const child = spawn(command, args, {
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdin.on("error", () => process.stdin.destroy());
process.once("SIGTERM", () => child.kill());
process.once("SIGINT", () => child.kill());

function writeResponse(line: string) {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(line + "\n", (error) => (error ? reject(error) : resolve()));
  });
}
// Serialize entire frames on one writer so a local denial cannot split a
// concurrently arriving native tool result in the middle of its JSON line.
const relayOutput = (async () => {
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    await writeResponse(line);
  }
})();
child.on("exit", (code, signal) => {
  process.stdin.destroy();
  process.exitCode = code ?? (signal ? 1 : 0);
});
child.on("error", () => {
  process.stdin.destroy();
  process.exitCode = 1;
});

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    /* The downstream MCP parser handles invalid frames. */
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (
    record(frame) &&
    frame.method === "tools/call" &&
    record(frame.params) &&
    (frame.params.name === "Monitor" ||
      (frame.params.name === "ScheduleWakeup" &&
        !(record(frame.params.arguments) && frame.params.arguments.stop === true))) &&
    !(await allowed())
  ) {
    if (frame.id != null) {
      await writeResponse(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            isError: true,
            content: [{ type: "text", text: "이 대화의 백그라운드 감시가 꺼져 있습니다." }],
          },
        }),
      );
    }
    continue;
  }
  // Await the write callback for backpressure and preserve request order.
  if (child.stdin.destroyed) break;
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(line + "\n", (error) => (error ? reject(error) : resolve()));
  });
}
child.stdin.end();
await relayOutput;
