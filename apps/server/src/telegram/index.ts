// @effect-diagnostics globalDate:off
import { createSerialQueue, runBackgroundModelJob } from "../background/backgroundModelQueue.ts";
import { CodexSummaryFailure } from "./codexCli.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  TelegramChannelCliPolicy,
  type ProjectId,
  type TelegramChannelsStatusResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { pageDocuments } from "./documents.ts";
import { Journal, type Mapping, type Registration } from "./journal.ts";
import {
  createLocalGenerator,
  normalizePage,
  validateAnswer,
  type Generate,
  type ReadPage,
  type Summarize,
} from "./summary.ts";
import type { TelegramCli } from "./cli.ts";
import { TelegramBridgeFailure } from "./connection.ts";
export { createTelegramCli } from "./cli.ts";
export type { TelegramCli } from "./cli.ts";
export type { PageRequest, ReadPage } from "./summary.ts";

type Options = {
  stateDir: string;
  engine: Pick<OrchestrationEngineShape, "dispatch">;
  queries: Pick<ProjectionSnapshotQueryShape, "getProjectShellById">;
  readPage: ReadPage;
  cli?: TelegramCli | undefined;
  local?: Generate;
};
const key = (m: Mapping) => JSON.stringify([m.projectId, m.peerId]);
const emptyPage = (r: Registration) => ({
  peerId: r.peerId,
  messages: [],
  unavailableIds: [],
  endReached: true,
  continuation: r.readCursor,
});
const decodePolicy = Schema.decodeUnknownSync(TelegramChannelCliPolicy);

export function createTelegramProjectRag({
  stateDir,
  engine,
  queries,
  readPage,
  cli,
  local = createLocalGenerator(),
}: Options) {
  const journal = new Journal(stateDir);
  const bridgeQueue = createSerialQueue();
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let closed = false;

  async function assertProject(projectId: ProjectId) {
    if (closed) throw new Error("Telegram 수집기가 종료되었습니다.");
    if (Option.isNone(await Effect.runPromise(queries.getProjectShellById(projectId))))
      throw new Error("활성 프로젝트를 찾을 수 없습니다.");
  }
  async function status({
    projectId,
  }: {
    projectId: ProjectId;
  }): Promise<TelegramChannelsStatusResult> {
    await assertProject(projectId);
    const cliModels = (await cli?.listModels()) ?? [];
    return {
      registrations: journal
        .list(projectId)
        .map((r) =>
          journal.status(r, running.has(jobId(r, "read")) || running.has(jobId(r, "publish"))),
        ),
      cliModels,
      ...(cli?.unsupported ? { unsupportedCli: await cli.unsupported(cliModels) } : {}),
    };
  }
  const summarizeFor =
    (r: Registration, signal: AbortSignal): Summarize =>
    (request) =>
      runBackgroundModelJob(signal, async () => {
        signal.throwIfAborted();
        journal.check(r);
        try {
          return validateAnswer(await local(request, signal), request);
        } catch {
          signal.throwIfAborted();
          const policy = journal.check(r).policy;
          if (!policy?.allowExternalTransfer || !cli)
            throw new Error("무료 모델 재시도 대기 중입니다.");
          const models = await cli.listModels();
          if (
            !models.some((m) => m.instanceId === policy.instanceId && m.modelId === policy.modelId)
          )
            throw new Error("선택한 CLI 계정과 모델을 사용할 수 없습니다.");
          const current = journal.check(r).policy;
          signal.throwIfAborted();
          if (
            !current?.allowExternalTransfer ||
            current.instanceId !== policy.instanceId ||
            current.modelId !== policy.modelId
          )
            throw new Error("채널의 CLI 전달 설정이 변경되었습니다.");
          return validateAnswer(await cli.generate(policy, request, signal), request);
        }
      });

  type Job = "read" | "publish";
  const jobId = (m: Mapping, job: Job) => key(m) + job;

  async function publish(r: Registration, signal: AbortSignal) {
    let stage = "원자료를 인용한 한국어 요약 생성";
    try {
      await assertProject(r.projectId);
      while (true) {
        signal.throwIfAborted();
        r = journal.checkMapping(r);
        let pending = r.pending;
        if (!pending) {
          const page =
            journal.nextPage(r) ?? (r.readEnded && !r.progress.documentId ? emptyPage(r) : null);
          if (!page) break;
          stage = "원자료를 인용한 한국어 요약 생성";
          const prepared = await pageDocuments(r, page, summarizeFor(r, signal));
          signal.throwIfAborted();
          pending = journal.edit(r, (current) => {
            journal.check(r, current);
            current.pending ??= prepared;
          }).pending!;
        }
        stage = "프로젝트 RAG 문서 발행";
        for (const cmd of pending.commands) {
          signal.throwIfAborted();
          journal.check(r);
          await Effect.runPromise(engine.dispatch(cmd));
        }
        signal.throwIfAborted();
        journal.acknowledge(r, pending);
      }
    } catch (cause) {
      if (!signal.aborted)
        journal.edit(r, (current) => {
          if (current.generation === r.generation)
            current.error =
              cause instanceof CodexSummaryFailure
                ? cause.message
                : stage + " 실패. 마지막으로 저장한 위치에서 재시도합니다.";
        });
    }
  }

  async function read(r: Registration, signal: AbortSignal) {
    if (r.manualRetry || (r.retryAt ?? 0) > Date.now()) return;
    try {
      await assertProject(r.projectId);
      let end = false;
      while (!end) {
        signal.throwIfAborted();
        r = journal.checkMapping(r);
        const req = {
          peerId: r.peerId,
          channel: r.channel,
          afterId: r.readCursor,
          limit: 100,
          signal,
        };
        const raw = await bridgeQueue(signal, async () => {
          signal.throwIfAborted();
          journal.checkMapping(r);
          const remaining = journal.bridgeWaitUntil() - Date.now();
          if (remaining > 0)
            throw new TelegramBridgeFailure("flood_wait", true, Math.ceil(remaining / 1000));
          try {
            return await readPage(req);
          } catch (e) {
            if (
              e instanceof TelegramBridgeFailure &&
              e.code === "flood_wait" &&
              Number.isSafeInteger(e.retryAfterSeconds) &&
              e.retryAfterSeconds! > 0
            )
              journal.waitForBridge(e.retryAfterSeconds!);
            throw e;
          }
        });
        signal.throwIfAborted();
        journal.checkMapping(r);
        const page = normalizePage(raw, req);
        if (page.continuation > r.readCursor) journal.enqueue(r, page);
        end = page.endReached;
        if (end)
          journal.edit(r, (current) => {
            journal.checkMapping(r, current);
            current.readEnded = true;
            current.readError = null;
            if (current.progress.documentId && current.progress.cursor === current.readCursor) {
              current.progress.exhausted = true;
              current.progress.lastSyncedAt = new Date().toISOString();
            }
          });
        if (!journal.get(r).error) void startJob(r, "publish").catch(() => {});
      }
    } catch (e) {
      if (signal.aborted) return;
      const reason =
        e instanceof TelegramBridgeFailure ? e.message : "페이지 내용을 검증할 수 없습니다.";
      journal.edit(r, (current) => {
        if (current.generation !== r.generation) return;
        current.manualRetry = e instanceof TelegramBridgeFailure && !e.retryable;
        if (e instanceof TelegramBridgeFailure && e.retryAfterSeconds && e.retryAfterSeconds > 0)
          current.retryAt = Math.min(
            Number.MAX_SAFE_INTEGER,
            Date.now() + e.retryAfterSeconds * 1000,
          );
        current.readError = "Telegram 읽기 실패. " + reason;
      });
    }
  }

  function startJob(m: Mapping, job: Job): Promise<void> {
    const id = jobId(m, job),
      existing = running.get(id);
    if (existing) {
      return existing.controller.signal.aborted
        ? existing.done.then(() => startJob(m, job))
        : existing.done;
    }
    if (closed) throw new Error("Telegram 수집기가 종료되었습니다.");
    const r = journal.get(m);
    if (r.paused) return Promise.resolve();
    const controller = new AbortController();
    const done = (
      job === "read" ? read(r, controller.signal) : publish(r, controller.signal)
    ).finally(() => {
      running.delete(id);
    });
    running.set(id, { controller, done });
    return done;
  }
  function start(m: Mapping) {
    // A fresh poll always gets a read job, even with a long-running model request.
    void startJob(m, "publish").catch(() => {});
    return startJob(m, "read");
  }
  async function interrupt(m: Mapping) {
    const jobs = [running.get(jobId(m, "read")), running.get(jobId(m, "publish"))];
    for (const task of jobs) task?.controller.abort();
    await Promise.allSettled(jobs.map((t) => t?.done));
  }
  async function register(input: Mapping & { channel?: string }) {
    await assertProject(input.projectId);
    if (
      !/^-[1-9]\d{12,18}$/u.test(input.peerId) ||
      -BigInt(input.peerId) <= 1_000_000_000_000n ||
      -BigInt(input.peerId) > 0x7fffffffffffffffn
    )
      throw new Error("검증된 채널 ID가 필요합니다.");
    const channel =
      input.channel?.replace(/^(?:https?:\/\/)?t\.me\/([a-z][a-z0-9_]*)\/?$/iu, "@$1") ??
      input.peerId;
    if (channel !== input.peerId && !/^@[a-z][a-z0-9_]{0,31}$/iu.test(channel))
      throw new Error("검증된 채널 참조가 필요합니다.");
    journal.register({ projectId: input.projectId, peerId: input.peerId }, channel);
    void start(input).catch(() => {});
    return status(input);
  }
  async function queueSync(m: Mapping) {
    await assertProject(m.projectId);
    journal.edit(m, (r) => {
      r.manualRetry = false;
    });
    void start(m).catch(() => {});
    return status(m);
  }
  return {
    status,
    register,
    async unregister(m: Mapping) {
      await assertProject(m.projectId);
      journal.edit(m, (r) => {
        r.paused = true;
      });
      await interrupt(m);
      journal.unregister(m);
      return status(m);
    },
    async pause(m: Mapping) {
      await assertProject(m.projectId);
      journal.edit(m, (r) => {
        r.paused = true;
      });
      await interrupt(m);
      return status(m);
    },
    async resume(m: Mapping) {
      await assertProject(m.projectId);
      journal.edit(m, (r) => {
        r.paused = false;
      });
      void start(m).catch(() => {});
      return status(m);
    },
    async setPolicy(m: Mapping & { policy: TelegramChannelCliPolicy | null }) {
      await assertProject(m.projectId);
      const policy = m.policy === null ? null : decodePolicy(m.policy);
      if (
        policy &&
        !(await cli?.listModels())?.some(
          (choice) => choice.instanceId === policy.instanceId && choice.modelId === policy.modelId,
        )
      )
        throw new Error("등록된 CLI 계정과 정확한 모델을 선택하세요.");
      journal.edit(m, (r) => {
        r.policy = policy;
      });
      const publisher = running.get(jobId(m, "publish"));
      publisher?.controller.abort();
      await publisher?.done;
      void startJob(m, "publish").catch(() => {});
      return status(m);
    },
    queueSync,
    sync: queueSync,
    retry: queueSync,
    async drain() {
      while (running.size) await Promise.allSettled([...running.values()].map((task) => task.done));
    },
    async poll() {
      await Promise.allSettled(
        journal
          .list()
          .filter((r) => !r.paused)
          .map(start),
      );
    },
    async close() {
      closed = true;
      for (const task of running.values()) task.controller.abort();
      await Promise.allSettled([...running.values()].map((t) => t.done));
      journal.close();
    },
  };
}
