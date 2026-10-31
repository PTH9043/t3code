import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "tool-fixture", version: "1.0.0" },
        }
      : message.method === "tools/list"
        ? message.params?.cursor
          ? { tools: [{ name: "second_tool", inputSchema: { type: "object" } }] }
          : {
              tools: [{ name: "first_tool", inputSchema: { type: "object" } }],
              nextCursor: "second",
            }
        : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
