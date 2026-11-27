// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetch:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

/**
 * Windows High(rid=12288) ↔ Medium(rid=8192) UIPI 관통 로컬 루프백 OAuth 콜백 릴레이.
 *
 * 브라우저(Medium)가 `t3code://app/?...` 딥링크로 띄운 2차 Electron은 Windows Shell이 실행하므로
 * `T3CODE_HOME` 환경변수가 없을 수 있다.
 * - 주 앱(High): `stateDir/clerk-callback-relay.json`과 OS 공용 고정 경로
 *   (`%LOCALAPPDATA%\t3code\clerk-callback-relay-<scheme>.json`) 두 곳에 릴레이 정보를 원자적 기록.
 * - 2차 프로세스(Medium): `main.ts` 부트스트랩 최상단에서 공용 고정 경로·`stateDir` 후보를 순서대로
 *   탐색해 주 앱 릴레이에 POST 후 즉시 `app.exit(0)`으로 무창 종료.
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
  readonly sharedRelayFilePath: string | null;
  readonly close: () => Promise<void>;
}

export function resolveSharedRelayFilePath(scheme: string): string {
  const safeScheme = scheme.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const base =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? NodePath.join(process.env.LOCALAPPDATA, "t3code")
      : NodePath.join(NodeOs.tmpdir(), "t3code");
  return NodePath.join(base, `clerk-callback-relay-${safeScheme}.json`);
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

export function extractAnyDesktopCallbackFromArgv(
  argv: ReadonlyArray<string>,
  schemes: ReadonlyArray<string> = ["t3code", "t3code-dev"],
  host = "app",
): { readonly scheme: string; readonly url: string } | null {
  for (const scheme of schemes) {
    const url = extractClerkCallbackUrl(argv, scheme, host);
    if (url) return { scheme, url };
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

function writeRelayFileAtomically(
  filePath: string,
  descriptor: ClerkCallbackRelayDescriptor,
): void {
  NodeFs.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  NodeFs.writeFileSync(tmpPath, JSON.stringify(descriptor, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  NodeFs.renameSync(tmpPath, filePath);
}

function removeRelayFileIfOwned(filePath: string, expectedToken: string): void {
  try {
    if (!NodeFs.existsSync(filePath)) return;
    const current = JSON.parse(
      NodeFs.readFileSync(filePath, "utf8"),
    ) as Partial<ClerkCallbackRelayDescriptor>;
    if (current.token === expectedToken) {
      NodeFs.rmSync(filePath, { force: true });
    }
  } catch {
    // ignore cleanup error
  }
}

export async function startDesktopClerkCallbackRelay(input: {
  readonly stateDir: string;
  readonly scheme: string;
  readonly host?: string;
  readonly writeSharedCopy?: boolean;
  readonly onCallback: (url: string) => void;
}): Promise<StartedClerkCallbackRelay> {
  const host = input.host ?? "app";
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const relayFilePath = NodePath.join(input.stateDir, CLERK_CALLBACK_RELAY_FILENAME);
  const sharedRelayFilePath =
    input.writeSharedCopy === false ? null : resolveSharedRelayFilePath(input.scheme);

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

  writeRelayFileAtomically(relayFilePath, descriptor);
  if (
    sharedRelayFilePath &&
    NodePath.resolve(sharedRelayFilePath) !== NodePath.resolve(relayFilePath)
  ) {
    try {
      writeRelayFileAtomically(sharedRelayFilePath, descriptor);
    } catch {
      // Best-effort shared locator mirror
    }
  }

  const close = async () => {
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
    removeRelayFileIfOwned(relayFilePath, token);
    if (sharedRelayFilePath) {
      removeRelayFileIfOwned(sharedRelayFilePath, token);
    }
  };

  return { descriptor, relayFilePath, sharedRelayFilePath, close };
}

export async function tryForwardClerkCallbackFromArgv(input: {
  readonly argv: ReadonlyArray<string>;
  readonly stateDir?: string;
  readonly extraRelayFiles?: ReadonlyArray<string>;
  readonly scheme: string;
  readonly host?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
  readonly checkPidAlive?: (pid: number) => boolean;
}): Promise<boolean> {
  const host = input.host ?? "app";
  const callbackUrl = extractClerkCallbackUrl(input.argv, input.scheme, host);
  if (!callbackUrl) return false;

  const candidateFiles: string[] = [];
  if (input.stateDir) {
    candidateFiles.push(NodePath.join(input.stateDir, CLERK_CALLBACK_RELAY_FILENAME));
  }
  candidateFiles.push(resolveSharedRelayFilePath(input.scheme));
  if (input.extraRelayFiles) {
    for (const p of input.extraRelayFiles) candidateFiles.push(p);
  }
  const uniqueFiles = [...new Set(candidateFiles.map((p) => NodePath.resolve(p)))];
  const aliveFn = input.checkPidAlive ?? isProcessAlive;

  for (const relayFilePath of uniqueFiles) {
    if (!NodeFs.existsSync(relayFilePath)) continue;

    let descriptor: Partial<ClerkCallbackRelayDescriptor>;
    try {
      descriptor = JSON.parse(
        NodeFs.readFileSync(relayFilePath, "utf8"),
      ) as Partial<ClerkCallbackRelayDescriptor>;
    } catch {
      continue;
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
      continue;
    }

    if (!aliveFn(descriptor.pid)) continue;

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
      if (res.ok) return true;
    } catch {
      // try next candidate
    } finally {
      clearTimeout(timer);
    }
  }

  return false;
}
