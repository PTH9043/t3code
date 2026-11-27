// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import { makeKeyedLock } from "@t3tools/shared/KeyedLock";
import {
  EventId,
  type MuseSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  makeProviderTurnHistoryFactory,
  type ProviderTurnHistory,
} from "../ProviderTurnHistory.ts";
import {
  MUSE_CLOUD_STDIN_SEND_SCRIPT,
  resolveMuseCloudBinaryPath,
  resolveMuseCloudPythonPath,
} from "../Drivers/MuseCloudHome.ts";
import { type MuseAdapterShape } from "../Services/MuseAdapter.ts";
import { MUSE_CLOUD_CHAT_MODEL, MUSE_CLOUD_MAIN_MODEL } from "./MuseCloudProvider.ts";

const PROVIDER = ProviderDriverKind.make("muse");
const CLOUD_RESUME_VERSION = 1 as const;
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCloudResume(raw: unknown): { museSessionId?: string } | undefined {
  if (!isPlainRecord(raw)) return undefined;
  if (raw.schemaVersion !== CLOUD_RESUME_VERSION || raw.backend !== "cloud") return undefined;
  const id = typeof raw.museSessionId === "string" ? raw.museSessionId.trim() : "";
  return id ? { museSessionId: id } : {};
}

export function extractMuseCloudReplyText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  const parsed = decodeUnknownJson(trimmed);
  if (Option.isSome(parsed) && isPlainRecord(parsed.value)) {
    const root = parsed.value;
    if (isPlainRecord(root.reply)) {
      if (typeof root.reply.text === "string" && root.reply.text.trim()) {
        return root.reply.text;
      }
      if (typeof root.reply.content === "string" && root.reply.content.trim()) {
        return root.reply.content;
      }
    }
    if (typeof root.text === "string" && root.text.trim()) {
      return root.text;
    }
    if (typeof root.message === "string" && root.message.trim()) {
      return root.message;
    }
  }
  return trimmed;
}

interface CloudSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly history: ProviderTurnHistory;
  museSessionId: string | undefined;
  activeTurnId: TurnId | undefined;
  activeChild: NodeChildProcess.ChildProcess | undefined;
  interruptedTurnIds: Set<TurnId>;
  stopped: boolean;
}

const MAX_ARGV_PROMPT_FALLBACK_CHARS = 16_000;

function runMuseCloudSubprocess(input: {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly stdinText?: string;
  readonly onSpawn?: (child: NodeChildProcess.ChildProcess) => void;
}): Effect.Effect<
  { readonly code: number; readonly stdout: string; readonly stderr: string },
  Error
> {
  return Effect.callback((resume) => {
    const isScript = /\.[cm]?js$/i.test(input.binary);
    const cmd = isScript ? process.execPath : input.binary;
    const args = [...(isScript ? [input.binary] : []), ...input.args];
    const hasStdin = input.stdinText !== undefined;
    const child = NodeChildProcess.spawn(cmd, args, {
      env: {
        ...input.env,
        ...(isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        MUSE_NO_UPDATE_CHECK: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    input.onSpawn?.(child);

    if (hasStdin && child.stdin) {
      child.stdin.on("error", () => {
        // Ignore EPIPE if child exits before reading full stdin.
      });
      child.stdin.end(input.stdinText, "utf8");
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      resume(Effect.fail(err));
    });
    child.on("close", (code) => {
      resume(Effect.succeed({ code: code ?? 1, stdout, stderr }));
    });

    return Effect.sync(() => {
      try {
        if (!child.killed && child.exitCode === null) {
          child.kill();
        }
      } catch {
        // Ignore kill race.
      }
    });
  });
}

export interface MuseCloudAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

export function makeMuseCloudAdapter(
  museSettings: MuseSettings,
  options?: MuseCloudAdapterOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("muse");
    const path = yield* Path.Path;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const createTurnHistory = yield* makeProviderTurnHistoryFactory;
    const environment = options?.environment ?? process.env;

    const sessions = new Map<ThreadId, CloudSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const withThreadLock = makeKeyedLock().withKey;

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Muse Cloud runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CloudSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: CloudSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.activeChild && !ctx.activeChild.killed) {
          try {
            ctx.activeChild.kill();
          } catch {
            // Ignore.
          }
          ctx.activeChild = undefined;
        }
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: MuseAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          const cwd = input.cwd?.trim() ? path.resolve(input.cwd.trim()) : process.cwd();
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const resumed = parseCloudResume(input.resumeCursor);
          const model = input.modelSelection?.model?.trim() || MUSE_CLOUD_CHAT_MODEL;
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            continuity: resumed?.museSessionId ? "resumed" : "new",
            runtimeMode: input.runtimeMode,
            cwd,
            model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: CLOUD_RESUME_VERSION,
              backend: "cloud",
              ...(resumed?.museSessionId ? { museSessionId: resumed.museSessionId } : {}),
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: CloudSessionContext = {
            threadId: input.threadId,
            session,
            history: yield* createTurnHistory({
              directory: path.join(serverConfig.stateDir, "provider-history", PROVIDER),
              provider: PROVIDER,
              threadId: input.threadId,
            }),
            museSessionId: resumed?.museSessionId,
            activeTurnId: undefined,
            activeChild: undefined,
            interruptedTurnIds: new Set(),
            stopped: false,
          };
          sessions.set(input.threadId, ctx);

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { message: "muse.ai cloud session ready" },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { state: "ready", reason: "muse.ai cloud ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: resumed?.museSessionId ? { providerThreadId: resumed.museSessionId } : {},
          });

          return session;
        }),
      );

    const sendTurn: MuseAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const text = input.input?.trim();
        if (!text) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "muse.ai cloud turns require non-empty text input.",
          });
        }

        const turnId = TurnId.make(yield* randomUUIDv4);
        const model =
          input.modelSelection?.model?.trim() || ctx.session.model || MUSE_CLOUD_CHAT_MODEL;
        const useMainChat = model === MUSE_CLOUD_MAIN_MODEL;
        const binary = resolveMuseCloudBinaryPath(museSettings.cloudBinaryPath);

        ctx.activeTurnId = turnId;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          model,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: { model },
        });

        // Create an isolated muse.ai side chat on first turn unless using main chat.
        if (!useMainChat && !ctx.museSessionId) {
          const title = `T3: ${text.replace(/\s+/g, " ").slice(0, 48)}`;
          const startRes = yield* runMuseCloudSubprocess({
            binary,
            args: ["session-start", "--title", title],
            env: environment,
            onSpawn: (child) => {
              ctx.activeChild = child;
            },
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: `Failed to start muse.ai side chat: ${cause.message}`,
                  cause,
                }),
            ),
          );
          ctx.activeChild = undefined;
          if (startRes.code === 0) {
            const parsed = decodeUnknownJson(startRes.stdout.trim());
            if (
              Option.isSome(parsed) &&
              isPlainRecord(parsed.value) &&
              typeof parsed.value.session_id === "string" &&
              parsed.value.session_id.trim()
            ) {
              ctx.museSessionId = parsed.value.session_id.trim();
              ctx.session = {
                ...ctx.session,
                resumeCursor: {
                  schemaVersion: CLOUD_RESUME_VERSION,
                  backend: "cloud",
                  museSessionId: ctx.museSessionId,
                },
              };
            }
          }
        }

        if (ctx.interruptedTurnIds.has(turnId)) {
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }

        const threadArg = !useMainChat && ctx.museSessionId ? ctx.museSessionId : "";
        const pythonPath = resolveMuseCloudPythonPath(museSettings.cloudBinaryPath);
        const sendExec = pythonPath
          ? {
              binary: pythonPath,
              args: ["-c", MUSE_CLOUD_STDIN_SEND_SCRIPT, threadArg, "300"],
              stdinText: text,
            }
          : {
              binary,
              args: [
                "send",
                text.length > MAX_ARGV_PROMPT_FALLBACK_CHARS
                  ? `${text.slice(0, MAX_ARGV_PROMPT_FALLBACK_CHARS)}\n\n[truncated for CLI argv limit]`
                  : text,
                ...(threadArg ? ["--thread", threadArg] : []),
                "--wait",
                "300",
              ],
            };

        const sendResult = yield* runMuseCloudSubprocess({
          binary: sendExec.binary,
          args: sendExec.args,
          env: environment,
          ...(sendExec.stdinText !== undefined ? { stdinText: sendExec.stdinText } : {}),
          onSpawn: (child) => {
            ctx.activeChild = child;
          },
        }).pipe(Effect.result);
        ctx.activeChild = undefined;

        if (ctx.interruptedTurnIds.has(turnId)) {
          ctx.interruptedTurnIds.delete(turnId);
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }

        if (Result.isFailure(sendResult)) {
          const detail = `muse-cli 실행 실패: ${sendResult.failure.message}`;
          const { activeTurnId: _omit, ...readySession } = ctx.session;
          ctx.activeTurnId = undefined;
          ctx.session = { ...readySession, status: "ready", updatedAt: yield* nowIso };
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            payload: { state: "failed", errorMessage: detail },
          });
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail,
            cause: sendResult.failure,
          });
        }

        const procOut = sendResult.success;
        if (procOut.code !== 0) {
          const errText = (procOut.stderr || procOut.stdout).trim() || `exit code ${procOut.code}`;
          const detail =
            procOut.code === 2
              ? "muse.ai 세션 인증이 만료되었습니다. 설정 → Muse에서 Google 로그인을 다시 진행하세요."
              : `muse.ai 요청 실패: ${errText.slice(0, 300)}`;
          const { activeTurnId: _omit, ...readySession } = ctx.session;
          ctx.activeTurnId = undefined;
          ctx.session = { ...readySession, status: "ready", updatedAt: yield* nowIso };
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            payload: { state: "failed", errorMessage: detail },
          });
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "muse-cli/send",
            detail,
          });
        }

        const replyText = extractMuseCloudReplyText(procOut.stdout);
        const itemId = RuntimeItemId.make(yield* randomUUIDv4);

        yield* offerRuntimeEvent({
          type: "item.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          itemId,
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
          },
          raw: { source: "muse.cli", method: "send", payload: procOut.stdout },
        });
        if (replyText.length > 0) {
          yield* offerRuntimeEvent({
            type: "content.delta",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            itemId,
            payload: {
              streamKind: "assistant_text",
              delta: replyText,
            },
          });
        }
        yield* offerRuntimeEvent({
          type: "item.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          itemId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
          },
        });

        yield* ctx.history
          .append(turnId, { prompt: text, reply: replyText })
          .pipe(Effect.andThen(ctx.history.complete(turnId)));

        const { activeTurnId: _omit, ...readySession } = ctx.session;
        ctx.activeTurnId = undefined;
        ctx.session = { ...readySession, status: "ready", updatedAt: yield* nowIso };

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: { state: "completed", stopReason: "end_turn" },
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: MuseAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const targetTurnId = turnId ?? ctx.activeTurnId;
          if (targetTurnId) {
            ctx.interruptedTurnIds.add(targetTurnId);
          }
          if (ctx.activeChild && !ctx.activeChild.killed) {
            try {
              ctx.activeChild.kill();
            } catch {
              // Ignore.
            }
            ctx.activeChild = undefined;
          }
          if (ctx.activeTurnId) {
            const cancelledTurnId = ctx.activeTurnId;
            const { activeTurnId: _omit, ...readySession } = ctx.session;
            ctx.activeTurnId = undefined;
            ctx.session = { ...readySession, status: "ready", updatedAt: yield* nowIso };
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId,
              turnId: cancelledTurnId,
              payload: { state: "cancelled", stopReason: "cancelled" },
            });
          }
        }),
      );

    const respondToRequest: MuseAdapterShape["respondToRequest"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: `muse.ai cloud does not have pending approval request: ${requestId}`,
        });
      });

    const respondToUserInput: MuseAdapterShape["respondToUserInput"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/user_input",
          detail: `muse.ai cloud does not have pending user-input request: ${requestId}`,
        });
      });

    const readThread: MuseAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: yield* ctx.history.read };
      });

    const rollbackThread: MuseAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "muse.ai cloud sessions do not support provider-side rollback.",
        });
      });

    const stopSession: MuseAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: MuseAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: MuseAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: MuseAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies MuseAdapterShape;
  });
}
