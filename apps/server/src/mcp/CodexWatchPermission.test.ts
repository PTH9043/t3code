// @effect-diagnostics nodeBuiltinImport:off - Exercise the real stdio boundary with a Node fixture.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { expect, it } from "vite-plus/test";
import { guardCodexWatchTools, openCodexWatchPermission } from "./CodexWatchPermission.ts";

it("checks the current room at execution, passes other native tools, and fails closed if the gate disappears", async () => {
  let enabled = false;
  let checks = 0;
  const gate = await openCodexWatchPermission(async () => {
    checks++;
    return enabled;
  });
  const echo = {
    name: "t3-claude-tools",
    transport: "stdio" as const,
    command: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
  };
  const other = { ...echo, name: "other" };
  const [guard, untouched] = guardCodexWatchTools([echo, other], gate.address);
  expect(untouched).toBe(other);
  if (guard?.transport !== "stdio") throw new Error("Expected stdio");
  const child = spawn(guard.command, guard.args, {
    windowsHide: true,
    shell: false,
    stdio: "pipe",
  });
  const exited = once(child, "exit");
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let closed = false;
  const call = async (name: string, args: object = {}) => {
    const request = {
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: args },
    };
    child.stdin.write(JSON.stringify(request) + "\n");
    const line = await replies.next();
    expect(line.done).toBe(false);
    return JSON.parse(line.value!);
  };
  try {
    expect(await call("Monitor")).toMatchObject({ id: "Monitor", result: { isError: true } });
    expect(await call("ScheduleWakeup", { delaySeconds: 60 })).toHaveProperty(
      "result.isError",
      true,
    );
    for (const name of ["Bash", "Read", "TaskStop"]) {
      expect(await call(name, { fixture: "한글" })).toHaveProperty(
        "params.arguments.fixture",
        "한글",
      );
    }
    expect(await call("ScheduleWakeup", { stop: true })).toHaveProperty(
      "params.arguments.stop",
      true,
    );
    expect(checks).toBe(2);
    enabled = true;
    expect(await call("Monitor", { description: "fixture" })).toHaveProperty(
      "params.name",
      "Monitor",
    );
    expect(await call("ScheduleWakeup", { delaySeconds: 120 })).toHaveProperty(
      "params.arguments.delaySeconds",
      120,
    );
    enabled = false;
    expect(await call("Monitor")).toHaveProperty("result.isError", true);
    await gate.close();
    closed = true;
    expect(await call("Monitor")).toHaveProperty("result.isError", true);
    expect(await call("Read")).toHaveProperty("params.name", "Read");
  } finally {
    child.stdin.end();
    if (!closed) await gate.close();
    await exited;
  }
});
