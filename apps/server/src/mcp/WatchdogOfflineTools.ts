// @effect-diagnostics nodeBuiltinImport:off - Offline tools run inside the detached watchdog process.
// @effect-diagnostics globalDate:off - Offline records carry the real time they were written.
// @effect-diagnostics globalTimers:off - The subordinate CLI timeout is a plain process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  ServerSettings,
  threadTeamRoleMayWrite,
  ThreadId,
  WORKSPACE_MEMORY_SEARCH_LIMIT_MAX,
  WorkspaceDelegateInput,
  WorkspaceMemoryToolInput,
  type WorkspaceDelegateResult,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  analyzeUserSpeechStyle,
  formatUserSpeechProfileMarkdown,
} from "@t3tools/shared/userSpeechProfile";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { findKnowledge, getRoomSource } from "../orchestration/upgradeRoomKnowledgeSources.ts";
import { codexExecLaunchArgs } from "../provider/Layers/codexLaunchArgs.ts";
import { resolveTurnDelegateTeam, subordinatesForModel } from "../provider/subagentSelection.ts";
import { expandHomePath } from "../pathExpansion.ts";
import {
  buildDelegatePrompt,
  capDelegateText,
  matchSubordinate,
} from "./toolkits/workspaceDelegate.ts";

/** Shown for every tool the relay cannot answer while the T3 backend is down. */
export const WATCHDOG_OFFLINE_TOOL_MESSAGE =
  "T3가 꺼져 있어 지금은 쓸 수 없는 도구입니다. T3가 다시 켜진 뒤 사용하세요.";
/** Remembered notes written while T3 was off; the server imports them on its next start. */
export const WATCHDOG_OFFLINE_MEMORY_FILE = "upgrade-room-offline-memory.jsonl";
const DELEGATE_TIMEOUT_MS = 240_000;

export interface WatchdogOfflineToolResult {
  readonly text: string;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

export interface WatchdogRelayFallback {
  readonly tools: ReadonlySet<string>;
  readonly call: (
    name: string,
    args: unknown,
    signal: AbortSignal,
  ) => Promise<WatchdogOfflineToolResult>;
}

export interface WatchdogOfflineToolsOptions {
  readonly dbPath: string;
  readonly settingsPath: string;
  readonly stateDir: string;
  /** The conversation the execution belongs to (not the execution's own session id). */
  readonly ownerThreadId: string;
  readonly cwd: string;
  readonly providerInstanceId: string;
  readonly model: string | undefined;
  readonly runtimeMode: string;
  readonly interactionMode: string | undefined;
  /** A subordinate never delegates further, matching the online tool. */
  readonly nested: boolean;
  readonly delegateTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

const decodeMemory = Schema.decodeUnknownSync(WorkspaceMemoryToolInput);
const decodeDelegate = Schema.decodeUnknownSync(WorkspaceDelegateInput);
const decodeSettings = Schema.decodeUnknownSync(fromLenientJson(ServerSettings));

class OfflineToolError extends Error {}

/** Success mirrors Effect's MCP encoding: text is the JSON of the encoded success value. */
const success = (value: unknown): WatchdogOfflineToolResult => ({
  text: JSON.stringify(value),
  ...(value !== null && typeof value === "object"
    ? { structuredContent: value as Record<string, unknown> }
    : {}),
});

export function makeWatchdogOfflineTools(
  options: WatchdogOfflineToolsOptions,
): WatchdogRelayFallback {
  function readState<A>(body: (db: NodeSqlite.DatabaseSync) => A): A {
    const url = pathToFileURL(options.dbPath);
    url.searchParams.set("mode", "ro");
    const db = new NodeSqlite.DatabaseSync(url, {
      readOnly: true,
      allowExtension: false,
      timeout: 2_000,
    });
    try {
      db.exec("PRAGMA query_only=1; BEGIN");
      return body(db);
    } finally {
      db.close();
    }
  }

  /** Same scope rules as the online tool: current project, and the folder of the latest user message. */
  function scope(db: NodeSqlite.DatabaseSync) {
    const thread = db
      .prepare(
        "SELECT project_id, orchestra_run_thread_id FROM projection_threads WHERE thread_id=? AND deleted_at IS NULL",
      )
      .get(options.ownerThreadId);
    if (!thread || typeof thread.project_id !== "string")
      throw new OfflineToolError("현재 대화의 프로젝트만 조회할 수 있습니다.");
    const folderThread =
      typeof thread.orchestra_run_thread_id === "string"
        ? thread.orchestra_run_thread_id
        : options.ownerThreadId;
    const selected = db
      .prepare(`SELECT f.folder FROM projection_thread_messages m
        LEFT JOIN workspace_memory_v2_message_folders f ON f.message_id=m.message_id AND f.project_id=?
        WHERE m.thread_id=? AND m.role='user' ORDER BY m.rowid DESC LIMIT 1`)
      .get(thread.project_id, folderThread);
    if (!selected || typeof selected.folder !== "string")
      throw new OfflineToolError(
        "현재 대화의 작업 폴더가 기록되지 않아 기억을 조회하지 않았습니다. 기존 기록은 보존됩니다.",
      );
    return { projectId: thread.project_id, folder: selected.folder };
  }

  function memory(args: unknown): WatchdogOfflineToolResult {
    const input = decodeMemory(args);
    if (
      input.action !== "search" &&
      input.action !== "reflect" &&
      input.action !== "read" &&
      input.action !== "remember" &&
      input.action !== "user_style"
    )
      return { text: WATCHDOG_OFFLINE_TOOL_MESSAGE, isError: true };
    return readState((db) => {
      const { projectId, folder } = scope(db);
      if (input.projectId !== undefined && input.projectId !== projectId)
        throw new OfflineToolError(
          "현재 대화의 프로젝트만 조회할 수 있습니다. projectId를 빼고 다시 호출하면 현재 프로젝트로 조회합니다.",
        );
      // Root-folder conversations see the whole project corpus; a sub-folder only
      // sees project knowledge and this conversation, never other folders' messages.
      const thread = folder === "" ? null : options.ownerThreadId;
      const note =
        "T3가 꺼져 있어 읽기 전용 로컬 색인에서 찾았습니다. T3가 켜진 뒤 다시 조회하면 결과가 더 많을 수 있습니다.";
      if (input.action === "user_style") {
        const rows = (
          thread
            ? db
                .prepare(
                  "SELECT message_id, thread_id, text, created_at FROM projection_thread_messages WHERE thread_id=? AND role='user' AND is_streaming=0 ORDER BY rowid DESC LIMIT 120",
                )
                .all(thread)
            : db
                .prepare(
                  `SELECT m.message_id, m.thread_id, m.text, m.created_at
                   FROM projection_thread_messages m
                   JOIN projection_threads t ON t.thread_id=m.thread_id
                   WHERE t.project_id=? AND t.deleted_at IS NULL AND m.role='user' AND m.is_streaming=0
                   ORDER BY m.rowid DESC LIMIT 120`,
                )
                .all(projectId)
        ) as Array<{ message_id: string; thread_id: string; text: string; created_at: string }>;
        const chronological = [...rows].reverse().map((r) => ({
          id: r.message_id,
          threadId: r.thread_id,
          text: r.text,
          createdAt: r.created_at,
        }));
        const profile = analyzeUserSpeechStyle(chronological);
        return success(
          JSON.stringify({
            scope: folder || "project",
            profile,
            markdown: formatUserSpeechProfileMarkdown(profile),
            note,
          }),
        );
      }
      if (input.action === "search" || input.action === "reflect") {
        const limit = Math.min(
          input.limit ?? WORKSPACE_MEMORY_SEARCH_LIMIT_MAX,
          WORKSPACE_MEMORY_SEARCH_LIMIT_MAX,
        );
        const speaker = input.action === "search" ? (input.speaker ?? "all") : "all";
        const matches = findKnowledge(db, projectId, input.query, thread)
          .filter((hit) => {
            if (speaker === "all") return true;
            const origin = String(hit.origin);
            const isUserHit =
              origin === "user" || origin === "user-requested" || origin === "user-statement";
            return speaker === "user" ? isUserHit : !isUserHit;
          })
          .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, limit)
          .map((hit) => {
            const origin = String(hit.origin);
            const isUserHit =
              origin === "user" || origin === "user-requested" || origin === "user-statement";
            return {
              id:
                hit.source === "knowledge" || hit.source === "manual"
                  ? hit.id
                  : `message:${hit.id}`,
              topic: hit.title,
              text: hit.excerpt,
              source: JSON.stringify({ kind: hit.source, id: hit.id }),
              verification: hit.origin,
              speaker: isUserHit ? ("user" as const) : ("ai" as const),
              createdAt: hit.updatedAt,
            };
          });
        return success(JSON.stringify({ matches, note }));
      }
      if (input.action === "read") {
        if (input.id.startsWith("message:")) {
          const row = db
            .prepare(
              "SELECT message_id,role,text,updated_at FROM projection_thread_messages WHERE message_id=? AND thread_id=?",
            )
            .get(input.id.slice("message:".length), options.ownerThreadId);
          if (!row || typeof row.text !== "string")
            throw new OfflineToolError(
              "T3가 꺼져 있는 동안에는 현재 대화의 원문만 읽을 수 있습니다.",
            );
          const offset = input.offset ?? 0;
          return success(
            JSON.stringify({
              id: input.id,
              role: row.role,
              text: row.text.slice(offset, offset + 12_000),
              offset,
              totalChars: row.text.length,
              note,
            }),
          );
        }
        const item =
          getRoomSource(db, projectId, options.ownerThreadId, "knowledge", input.id) ??
          getRoomSource(db, projectId, options.ownerThreadId, "manual", input.id);
        if (!item) throw new OfflineToolError("기억이 없거나 현재 범위 밖입니다.");
        const offset = input.offset ?? 0;
        return success(
          JSON.stringify({
            id: input.id,
            topic: item.title,
            text: item.content.slice(offset, offset + 12_000),
            offset,
            totalChars: item.content.length,
            updatedAt: item.updatedAt,
            note,
          }),
        );
      }
      if (input.action !== "remember")
        return { text: WATCHDOG_OFFLINE_TOOL_MESSAGE, isError: true };
      if (!input.text.trim() || !input.topic.trim())
        throw new OfflineToolError("기억 본문과 주제를 입력하세요.");
      return success(JSON.stringify(queueMemory({ ...input, projectId, folder })));
    });
  }

  function queueMemory(input: {
    readonly projectId: string;
    readonly folder: string;
    readonly requestId: string;
    readonly topic: string;
    readonly text: string;
    readonly scope?: "project" | "global" | undefined;
  }) {
    const file = NodePath.join(options.stateDir, WATCHDOG_OFFLINE_MEMORY_FILE);
    const record = {
      version: 1,
      kind: "workspace_memory.remember",
      projectId: input.projectId,
      threadId: options.ownerThreadId,
      providerInstanceId: options.providerInstanceId,
      requestId: input.requestId,
      topic: input.topic,
      text: input.text,
      scope: input.scope ?? "project",
      folder: input.scope === "global" ? null : input.folder,
      recordedAt: new Date().toISOString(),
    };
    const existing = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8").split("\n") : [];
    for (const line of existing) {
      if (!line.trim()) continue;
      const previous: unknown = JSON.parse(line);
      if (
        previous &&
        typeof previous === "object" &&
        "projectId" in previous &&
        previous.projectId === record.projectId &&
        "requestId" in previous &&
        previous.requestId === record.requestId
      ) {
        const same =
          "text" in previous &&
          previous.text === record.text &&
          "topic" in previous &&
          previous.topic === record.topic;
        if (!same)
          throw new OfflineToolError(
            "같은 requestId에는 같은 기억만 재요청할 수 있습니다. 수정은 새 requestId로 저장하세요.",
          );
        return {
          requestId: record.requestId,
          saved: false,
          queued: true,
          note: "이미 대기 중인 기억입니다.",
        };
      }
    }
    NodeFS.mkdirSync(options.stateDir, { recursive: true });
    NodeFS.appendFileSync(file, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
    return {
      requestId: record.requestId,
      saved: false,
      queued: true,
      note: "T3가 꺼져 있어 기억을 대기열에 적었습니다. T3가 다시 켜져 가져오기 전까지는 검색되지 않습니다.",
    };
  }

  function readSettings() {
    return decodeSettings(NodeFS.readFileSync(options.settingsPath, "utf8"));
  }

  async function delegate(args: unknown, signal: AbortSignal): Promise<WatchdogOfflineToolResult> {
    const input = decodeDelegate(args);
    const settings = readSettings();
    const team =
      options.nested || !options.model
        ? { members: [] }
        : resolveTurnDelegateTeam(settings, {
            threadId: ThreadId.make(options.ownerThreadId),
            answeringInstanceId: options.providerInstanceId as never,
            forModel: options.model as never,
          });
    const rows = subordinatesForModel(team.members, options.model);
    const subordinates = rows.map((row) => ({
      role: row.role,
      account: row.account,
      instanceId: row.instanceId,
      model: row.model,
      ...(row.unavailable ? { unavailable: true as const } : {}),
    }));
    const answer = (fields: Partial<WorkspaceDelegateResult>): WatchdogOfflineToolResult =>
      success({
        subordinates,
        status: null,
        delegationId: null,
        text: null,
        message: null,
        ...fields,
      });
    if (options.nested && input.action !== "status")
      throw new OfflineToolError(
        "하위 모델로 실행 중인 세션은 다른 모델에게 작업을 넘길 수 없습니다. 작업을 직접 처리하세요.",
      );
    if (input.action === "status")
      return answer({
        message:
          rows.length === 0
            ? "이 모델에는 하위 모델이 지정되어 있지 않습니다. 작업을 직접 처리하세요."
            : "T3가 꺼져 있어 하위 모델을 CLI로 직접 실행합니다. run은 끝날 때까지 기다렸다가 결과를 돌려줍니다.",
      });
    if (input.action !== "run")
      throw new OfflineToolError(
        "T3가 꺼져 있는 동안의 위임은 run이 결과를 바로 돌려주므로 wait·cancel할 위임이 없습니다.",
      );
    if (!input.to || !input.task) throw new OfflineToolError("run에는 to와 task가 필요합니다.");
    const matched = matchSubordinate(rows, input.to);
    if ("error" in matched) throw new OfflineToolError(matched.error);
    const row = matched.match;
    if (threadTeamRoleMayWrite(row.role) && options.interactionMode === "plan")
      throw new OfflineToolError(
        row.role === "worker"
          ? "계획 모드에서는 일꾼(worker)에게 작업을 맡길 수 없습니다. 계획을 마친 뒤 일반 모드에서 다시 시도하세요."
          : "계획 모드에서는 문서화(writer) 역할에 수정을 맡길 수 없습니다.",
      );
    const explicit = Object.hasOwn(settings.providerInstances, row.instanceId)
      ? settings.providerInstances[row.instanceId]
      : undefined;
    const kind: string = explicit?.driver ?? row.instanceId;
    const driver = kind === "claudeAgent" || kind === "codex" ? kind : undefined;
    if (!driver)
      throw new OfflineToolError(
        "T3가 꺼져 있는 동안에는 Claude·Codex 하위 모델만 실행할 수 있습니다.",
      );
    type CliConfig = {
      readonly binaryPath?: unknown;
      readonly homePath?: unknown;
      readonly launchArgs?: unknown;
    };
    const config: CliConfig =
      ((explicit ? explicit.config : settings.providers[driver]) as CliConfig | undefined) ?? {};
    const text = await runSubordinateCli({
      driver,
      binaryPath: typeof config.binaryPath === "string" ? config.binaryPath : "",
      homePath: typeof config.homePath === "string" ? config.homePath : "",
      launchArgs: typeof config.launchArgs === "string" ? config.launchArgs : undefined,
      model: row.model,
      fullAccess: options.runtimeMode === "full-access",
      cwd: options.cwd,
      prompt: buildDelegatePrompt(row.role, input.task, row.instructions),
      timeoutMs: options.delegateTimeoutMs ?? DELEGATE_TIMEOUT_MS,
      env: options.env ?? process.env,
      signal,
    });
    if (!text.trim())
      return answer({
        status: "failed",
        message: "하위 모델이 배정된 작업의 결과를 반환하지 않았습니다.",
      });
    const capped = capDelegateText(text);
    return answer({
      status: "completed",
      text: capped.text,
      message:
        capped.omitted > 0
          ? `응답이 길어 앞부분 ${capped.omitted}자를 생략하고 끝부분만 전달합니다.`
          : null,
    });
  }

  const stripClientWrapperArgs = (raw: unknown): unknown => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const record = raw as Record<string, unknown>;
    if (!("toolSummary" in record) && !("waitForPreviousTools" in record) && !("_meta" in record)) {
      return raw;
    }
    const { toolSummary: _ts, waitForPreviousTools: _wf, _meta: _m, ...rest } = record;
    return rest;
  };

  return {
    tools: new Set(["workspace_memory", "workspace_delegate"]),
    call: async (name, args, signal) => {
      const cleanedArgs = stripClientWrapperArgs(args);
      try {
        if (name === "workspace_memory") return memory(cleanedArgs);
        if (name === "workspace_delegate") return await delegate(cleanedArgs, signal);
        return { text: WATCHDOG_OFFLINE_TOOL_MESSAGE, isError: true };
      } catch (error) {
        return {
          isError: true,
          text:
            error instanceof OfflineToolError
              ? error.message
              : `T3가 꺼져 있는 동안 도구를 실행하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/** Run one subordinate on its CLI's own on-disk login; no credential crosses the relay. */
export async function runSubordinateCli(input: {
  readonly driver: "claudeAgent" | "codex";
  readonly binaryPath: string;
  readonly homePath: string;
  readonly launchArgs: string | undefined;
  readonly model: string;
  readonly fullAccess: boolean;
  readonly cwd: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}): Promise<string> {
  const home = input.homePath.trim()
    ? NodePath.resolve(expandHomePath(input.homePath.trim()))
    : undefined;
  let outputDir: string | undefined;
  let args: string[];
  let env: NodeJS.ProcessEnv;
  if (input.driver === "claudeAgent") {
    args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      input.model,
      ...(input.fullAccess ? ["--dangerously-skip-permissions"] : []),
    ];
    env = home ? { ...input.env, CLAUDE_CONFIG_DIR: home } : input.env;
  } else {
    outputDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-offline-delegate-"));
    args = [
      "exec",
      ...codexExecLaunchArgs(input.launchArgs),
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      input.fullAccess ? "danger-full-access" : "read-only",
      "--model",
      input.model,
      "--output-last-message",
      NodePath.join(outputDir, "last-message.txt"),
      "-",
    ];
    env = home ? { ...input.env, CODEX_HOME: home } : input.env;
  }
  try {
    const command = await Effect.runPromise(
      resolveSpawnCommand(
        input.binaryPath || (input.driver === "codex" ? "codex" : "claude"),
        args,
        { env },
      ),
    );
    const { stdout, stderr, code } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(command.command, command.args, {
        cwd: input.cwd,
        env,
        shell: command.shell,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const stop = () => child.kill();
      const timer = setTimeout(() => {
        stop();
        reject(new OfflineToolError("하위 모델 실행 시간이 초과되어 중단했습니다."));
      }, input.timeoutMs);
      input.signal.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", stop);
        resolve({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          code: exitCode,
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input.prompt);
    });
    if (input.signal.aborted) throw new OfflineToolError("위임이 중단되었습니다.");
    if (code !== 0) {
      const detail = (stderr.trim() || stdout.trim()).slice(-2_000);
      throw new OfflineToolError(`하위 모델 CLI가 실패했습니다(code ${code}). ${detail}`);
    }
    if (input.driver === "codex")
      return NodeFS.readFileSync(NodePath.join(outputDir!, "last-message.txt"), "utf8");
    const envelope: unknown = JSON.parse(stdout);
    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("result" in envelope) ||
      typeof envelope.result !== "string"
    )
      throw new OfflineToolError("Claude CLI가 예상하지 못한 형식으로 응답했습니다.");
    if ("is_error" in envelope && envelope.is_error === true)
      throw new OfflineToolError(
        `하위 모델이 오류를 보고했습니다: ${envelope.result.slice(0, 2_000)}`,
      );
    return envelope.result;
  } finally {
    if (outputDir) NodeFS.rmSync(outputDir, { recursive: true, force: true });
  }
}
