// @effect-diagnostics nodeBuiltinImport:off - Private, session-scoped IPC for the stdio transport.
import { randomUUID } from "node:crypto";
import { mkdtemp, rmdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedMcpServer } from "./ManagedMcpTools.ts";

export async function openCodexWatchPermission(read: () => Promise<boolean>) {
  const directory =
    process.platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "t3-watch-"));
  const address = directory ? join(directory, "gate") : "\\\\.\\pipe\\t3-watch-" + randomUUID();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    void read().then(
      (enabled) => socket.end(enabled ? "1" : "0"),
      () => socket.end("0"),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, resolve);
    });
  } catch (error) {
    if (directory) await rmdir(directory);
    throw error;
  }
  return {
    address,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      if (directory) await rmdir(directory);
    },
  };
}

export const isManagedClaudeStdio = (server: ManagedMcpServer) =>
  server.transport === "stdio" && server.name === "t3-claude-tools";

export function guardCodexWatchTools(servers: readonly ManagedMcpServer[], address: string) {
  const entry = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./codex-watch-stdio.ts" : "./codex-watch-stdio.mjs",
      import.meta.url,
    ),
  );
  return servers.map(
    (server): ManagedMcpServer =>
      isManagedClaudeStdio(server) && server.transport === "stdio"
        ? {
            ...server,
            command: process.execPath,
            args: [entry, address, server.command, ...server.args],
            ...(process.versions.electron
              ? { env: { ...server.env, ELECTRON_RUN_AS_NODE: "1" } }
              : {}),
          }
        : server,
  );
}
