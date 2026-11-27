// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetch:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

/**
 * Windows High(rid=12288) ↔ Medium(rid=8192) UIPI 관통 로컬 루프백 OAuth 콜백 릴레이.
 *
 * 브라우저(Medium)가 `t3code://app/?...` 딥링크로 2차 Electron(Medium)을 열면,
 * Windows UIPI로 인해 2차 프로세스의 `WM_COPYDATA`(`second-instance`)가 관리자 주 앱(High)에
 * 전달되지 않을 수 있다.
 * - 주 앱(High): `127.0.0.1:0` 로컬 HTTP 릴레이 + 32바이트 Bearer 토큰을 `stateDir/clerk-callback-relay.json`에 기록.
 * - 2차 프로세스(Medium): 부트스트랩 최상단에서 argv의 딥링크를 릴레이에 POST 후 즉시 `app.exit(0)`.
 */

export const CLERK_CALLBACK_RELAY_FILENAME = "clerk-callback-relay.json";
const MAX_BODY_BYTES = 8 * 1024;

export interface ClerkCallbackRelayDescriptor {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly scheme: string;
  readonly host: string;
}

export interface StartedClerkCallbackRelay {
  readonly descriptor: ClerkCallbackRelayDescriptor;
  readonly relayFilePath: string;
  readonly close: () => Promise<void>;
}

export function isMatchingDesktopCallbackUrl(
  candidate: string,
  scheme: string,
  host = "app",
): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol.toLowerCase() === `${scheme.toLowerCase()}:` &&
      parsed.hostname.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function extractClerkCallbackUrl(
  argv: ReadonlyArray<string>,
  scheme: string,
  host = "app",
): string | null {
  for (const arg of argv) {
    if (typeof arg !== "string") continue;
    const trimmed = arg.trim();
    if (!trimmed) continue;
    if (isMatchingDesktopCallbackUrl(trimmed, scheme, host)) {
      return trimmed;
    }
  }
  return null;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Medium(rid=8192) 프로세스가 High(rid=12288) 주 앱 PID를 조회할 때 EPERM이 발생하며,
    // 이는 해당 PID가 실제로 살아있음을 뜻한다.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "EPERM";
  }
}

function timingSafeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.byteLength !== bufB.byteLength) return false;
  return NodeCrypto.timingSafeEqual(bufA, bufB);
}

export async function startDesktopClerkCallbackRelay(input: {
  readonly stateDir: string;
  readonly scheme: string;
  readonly host?: string;
  readonly onCallback: (url: string) => void;
}): Promise<StartedClerkCallbackRelay> {
  const host = input.host ?? "app";
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const relayFilePath = NodePath.join(input.stateDir, CLERK_CALLBACK_RELAY_FILENAME);

  const server = NodeHttp.createServer((req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    if (req.method !== "POST" || req.url !== "/callback") {
      res.writeHead(404).end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    const prefix = "Bearer ";
    const presented = authHeader.startsWith(prefix) ? authHeader.slice(prefix.length) : "";
    if (!presented || !timingSafeEqualUtf8(presented, token)) {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        exceeded = true;
        res.writeHead(413).end(JSON.stringify({ ok: false, error: "payload_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (exceeded || res.writableEnded) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          readonly url?: unknown;
        };
        if (
          typeof parsed.url !== "string" ||
          !isMatchingDesktopCallbackUrl(parsed.url, input.scheme, host)
        ) {
          res.writeHead(400).end(JSON.stringify({ ok: false, error: "invalid_callback_url" }));
          return;
        }
        input.onCallback(parsed.url);
        res.writeHead(200).end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: "invalid_json" }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Clerk callback relay failed to bind loopback port.");
  }

  const descriptor: ClerkCallbackRelayDescriptor = {
    port: addr.port,
    token,
    pid: process.pid,
    scheme: input.scheme,
    host,
  };

  NodeFs.mkdirSync(input.stateDir, { recursive: true });
  const tmpPath = `${relayFilePath}.${process.pid}.tmp`;
  NodeFs.writeFileSync(tmpPath, JSON.stringify(descriptor, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  NodeFs.renameSync(tmpPath, relayFilePath);

  const close = async () => {
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
    try {
      if (NodeFs.existsSync(relayFilePath)) {
        const current = JSON.parse(
          NodeFs.readFileSync(relayFilePath, "utf8"),
        ) as Partial<ClerkCallbackRelayDescriptor>;
        if (current.token === token) {
          NodeFs.rmSync(relayFilePath, { force: true });
        }
      }
    } catch {
      // ignore cleanup error
    }
  };

  return { descriptor, relayFilePath, close };
}

export async function tryForwardClerkCallbackFromArgv(input: {
  readonly argv: ReadonlyArray<string>;
  readonly stateDir: string;
  readonly scheme: string;
  readonly host?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
  readonly checkPidAlive?: (pid: number) => boolean;
}): Promise<boolean> {
  const host = input.host ?? "app";
  const callbackUrl = extractClerkCallbackUrl(input.argv, input.scheme, host);
  if (!callbackUrl) return false;

  const relayFilePath = NodePath.join(input.stateDir, CLERK_CALLBACK_RELAY_FILENAME);
  if (!NodeFs.existsSync(relayFilePath)) return false;

  let descriptor: Partial<ClerkCallbackRelayDescriptor>;
  try {
    descriptor = JSON.parse(
      NodeFs.readFileSync(relayFilePath, "utf8"),
    ) as Partial<ClerkCallbackRelayDescriptor>;
  } catch {
    return false;
  }

  if (
    typeof descriptor.port !== "number" ||
    descriptor.port <= 0 ||
    descriptor.port > 65535 ||
    typeof descriptor.token !== "string" ||
    !descriptor.token ||
    typeof descriptor.pid !== "number" ||
    descriptor.scheme?.toLowerCase() !== input.scheme.toLowerCase() ||
    (descriptor.host ?? "app").toLowerCase() !== host.toLowerCase()
  ) {
    return false;
  }

  const aliveFn = input.checkPidAlive ?? isProcessAlive;
  if (!aliveFn(descriptor.pid)) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 2_000);
  try {
    const res = await (input.fetcher ?? fetch)(`http://127.0.0.1:${descriptor.port}/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${descriptor.token}`,
      },
      body: JSON.stringify({ url: callbackUrl }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
