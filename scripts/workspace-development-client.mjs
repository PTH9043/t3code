import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";

// Uses the official local pairing CLI and typed RPC wire format. Credentials stay in memory.
export async function connectDevelopmentEnvironment(home) {
  const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
    process.execPath,
    [
      "apps/server/src/bin.ts",
      "pair",
      "--base-dir",
      home,
      "--label",
      "Persistent workspace verification",
    ],
    { cwd: NodePath.resolve(import.meta.dirname, ".."), windowsHide: true, timeout: 60_000 },
  );
  const pairing = new URL(stdout.match(/Pairing URL:\s+(\S+)/u)?.[1] ?? "missing");
  const origin = pairing.origin;
  const session = await fetch(`${origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: new URLSearchParams(pairing.hash.slice(1)).get("token") }),
  });
  if (!session.ok) throw new Error(`Pairing failed: ${session.status}`);
  const cookie = session.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  const { ticket } = await ticketResponse.json();
  const endpoint = new URL("/ws", origin.replace("http", "ws"));
  endpoint.searchParams.set("wsTicket", ticket);
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const requests = new Map();
  const subscriptions = new Map();
  let sequence = 0;
  socket.addEventListener("message", ({ data }) => {
    const decoded = JSON.parse(data);
    for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
      if (frame._tag === "Chunk") {
        for (const value of frame.values) subscriptions.get(String(frame.requestId))?.(value);
        socket.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
      } else if (frame._tag === "Exit") {
        const pending = requests.get(String(frame.requestId));
        if (!pending) continue;
        requests.delete(String(frame.requestId));
        clearTimeout(pending.timer);
        if (frame.exit._tag === "Success") pending.resolve(frame.exit.value);
        else pending.reject(new Error(`${pending.tag}: ${JSON.stringify(frame.exit)}`));
      }
    }
  });
  const ping = setInterval(() => socket.send(JSON.stringify({ _tag: "Ping" })), 15_000);
  return {
    origin,
    rpc: (tag, payload) =>
      new Promise((resolve, reject) => {
        const requestId = sequence++;
        const timer = setTimeout(() => reject(new Error(`${tag}: timed out`)), 60_000);
        requests.set(String(requestId), { tag, timer, resolve, reject });
        socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
      }),
    subscribe: (tag, payload, callback) => {
      const requestId = sequence++;
      subscriptions.set(String(requestId), callback);
      socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
      return () => {
        subscriptions.delete(String(requestId));
        socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
      };
    },
    close: () => {
      clearInterval(ping);
      for (const request of requests.values()) clearTimeout(request.timer);
      socket.close();
    },
  };
}
