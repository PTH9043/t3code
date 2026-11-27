// @effect-diagnostics nodeBuiltinImport:off
// The Windows account helper needs execFile's hidden-window and pipe controls.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as Schema from "effect/Schema";
import type { PageRequest } from "./summary.ts";

const configuration = Schema.Struct({
  accountDirectory: Schema.String,
  sessionFile: Schema.String,
});
const envelope = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.String,
      retryable: Schema.Boolean,
      retryAfterSeconds: Schema.optionalKey(Schema.Int),
    }),
  }),
]);
const resolved = Schema.Struct({
  peers: Schema.Array(Schema.Struct({ peerId: Schema.String, title: Schema.String })),
});
const descriptions: Record<string, string> = {
  session_busy: "기존 텔레그램 로그인을 다른 프로그램이 사용 중입니다.",
  session_unavailable: "등록한 텔레그램 세션 파일을 열 수 없습니다.",
  unauthorized: "등록한 텔레그램 로그인이 만료되었습니다.",
  access_denied: "현재 텔레그램 계정으로 이 채널을 읽을 수 없습니다.",
  peer_not_found: "현재 텔레그램 계정에서 채널을 찾을 수 없습니다.",
  not_a_channel: "채널이나 그룹을 지정해 주세요.",
  flood_wait: "텔레그램이 잠시 기다린 뒤 다시 조회하도록 요청했습니다.",
  peer_mismatch: "이 주소가 처음 등록했던 채널과 달라 수집을 멈췄습니다.",
};

export class TelegramBridgeFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  constructor(code: string, retryable: boolean, retryAfterSeconds?: number) {
    super(descriptions[code] ?? "텔레그램 연결을 확인할 수 없습니다.");
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function telegramConnection(baseDir: string) {
  const directory = path.join(baseDir, "tools", "telegram");
  let previous: Promise<void> = Promise.resolve();
  function request(packet: object, signal: AbortSignal, peer?: { id: string; channel: string }) {
    const next = previous.then(() => {
      signal.throwIfAborted();
      return invoke(packet, signal, peer);
    });
    previous = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  async function invoke(
    packet: object,
    signal: AbortSignal,
    peer?: { id: string; channel: string },
  ) {
    let config: typeof configuration.Type;
    try {
      config = Schema.decodeUnknownSync(Schema.fromJsonString(configuration))(
        await readFile(path.join(directory, "connection.json"), "utf8"),
      );
    } catch {
      throw new Error("이 실행 환경에 텔레그램 계정 연결이 설치되지 않았습니다.");
    }
    const root = config.accountDirectory;
    const relativeSession = path.relative(root, config.sessionFile);
    if (
      !path.isAbsolute(root) ||
      !path.isAbsolute(config.sessionFile) ||
      path.isAbsolute(relativeSession) ||
      relativeSession.startsWith("..") ||
      path.extname(config.sessionFile) !== ".session"
    ) {
      throw new Error("텔레그램 계정 경로를 확인해 주세요.");
    }
    const program = path.join(root, ".venv", "Scripts", "python.exe");
    const args = ["-I", "-B", "-X", "utf8", path.join(directory, "telegram-bridge.py")];
    const env = {
      ...process.env,
      T3_TELEGRAM_ENV_FILE: path.join(root, ".env"),
      T3_TELEGRAM_SESSION_FILE: config.sessionFile,
      T3_TELEGRAM_PEER_ID: peer?.id ?? "",
      T3_TELEGRAM_TARGET: peer?.channel ?? "",
    };
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        program,
        args,
        {
          cwd: root,
          env,
          signal,
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error) reject(new TelegramBridgeFailure("bridge_unavailable", true));
          else resolve(stdout);
        },
      );
      child.stdin?.on("error", () => reject(new TelegramBridgeFailure("bridge_unavailable", true)));
      child.stdin?.end(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(packet));
    });
    let answer: typeof envelope.Type;
    try {
      answer = Schema.decodeUnknownSync(Schema.fromJsonString(envelope))(output);
    } catch {
      throw new TelegramBridgeFailure("invalid_response", true);
    }
    if (!answer.ok)
      throw new TelegramBridgeFailure(
        answer.error.code,
        answer.error.retryable,
        answer.error.retryAfterSeconds,
      );
    return answer.result;
  }
  return {
    async lookupTitle(title: string, signal: AbortSignal) {
      const data = Schema.decodeUnknownSync(resolved)(
        await request({ op: "lookup", title }, signal),
      );
      return data.peers.map(({ peerId, title: name }) => ({ registrationId: peerId, title: name }));
    },
    async resolveChannel(reference: string, signal: AbortSignal) {
      const channel = reference.replace(/^(?:https?:\/\/)?t\.me\/([a-z0-9_]+)\/?$/iu, "@$1");
      const data = Schema.decodeUnknownSync(resolved)(
        await request({ op: "list", targets: [channel] }, signal),
      );
      const selected = data.peers[0];
      if (data.peers.length !== 1 || !selected || !/^-[1-9]\d{12,18}$/u.test(selected.peerId)) {
        throw new TelegramBridgeFailure("peer_not_found", false);
      }
      return { channel, peerId: selected.peerId };
    },
    readPage(input: PageRequest) {
      return request(
        { op: "read", peerId: input.peerId, cursor: input.afterId, limit: input.limit },
        input.signal,
        { id: input.peerId, channel: input.channel },
      );
    },
  };
}
