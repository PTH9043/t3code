// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createTelegramProjectRag } from "./index.ts";
import { TelegramBridgeFailure } from "./connection.ts";
import type { DocCommand } from "./journal.ts";
import type { Generate, PageRequest, ReadPage } from "./summary.ts";
import type { TelegramCli } from "./cli.ts";
const checkCommand = Schema.decodeUnknownSync(OrchestrationCommand);

const projectId = ProjectId.make("project-one"),
  other = ProjectId.make("project-two");
const a = { projectId, peerId: "-1000000000123" },
  b = { projectId, peerId: "-1010000000321" };
const msg = (id: number, text = "공개 일정 " + id) => ({
  id,
  date: "2026-11-01T03:00:00+00:00",
  text,
  link: "https://foreign.invalid/run",
});
const page = (
  r: PageRequest,
  messages: ReturnType<typeof msg>[],
  endReached = true,
  unavailableIds: number[] = [],
) => ({
  peerId: r.peerId,
  messages,
  continuation: Math.max(r.afterId, ...messages.map((m) => m.id), ...unavailableIds),
  endReached,
  unavailableIds,
});
const local: Generate = async ({ prompt }) => {
  const items = JSON.parse(prompt) as { text: string; number: number }[];
  return JSON.stringify({
    summary: "공지에 게시 일정이 있습니다.",
    evidence: items.map((i) => ({ number: i.number, quote: i.text.slice(0, 55) })),
  });
};
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposals.length) await disposals.pop()!();
});
async function fixture(readPage: ReadPage, generate: Generate = local, cli?: TelegramCli) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-telegram-test-"));
  disposals.push(() => NodeFSP.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const commands = new Map<string, DocCommand>(),
    docs = new Map<string, DocCommand>();
  const attempts: string[] = [];
  let fail = false;
  const make = () =>
    createTelegramProjectRag({
      stateDir: dir,
      readPage,
      local: generate,
      cli,
      queries: {
        getProjectShellById: (id) =>
          Effect.succeed(Option.some({ id } as OrchestrationProjectShell)),
      },
      engine: {
        dispatch: (c) =>
          Effect.sync(() => {
            if (c.type !== "project.knowledge.item.upsert") throw Error("unexpected command");
            checkCommand(c);
            attempts.push(c.commandId);
            if (!commands.has(c.commandId)) {
              commands.set(c.commandId, c);
              docs.set(c.itemId, c);
            }
            if (fail) {
              fail = false;
              throw Error("receipt lost after dispatch");
            }
            return { sequence: commands.size };
          }),
      },
    });
  let api = make();
  disposals.push(() => api.close());
  return {
    get api() {
      return api;
    },
    commands,
    docs,
    attempts,
    failNextReceipt() {
      fail = true;
    },
    async restart() {
      await api.close();
      api = make();
    },
  };
}

it("reads only explicitly registered project peers, exhausts every page and resumes incrementally", async () => {
  const offsets: number[] = [];
  let total = 207;
  const f = await fixture(async (r) => {
    offsets.push(r.afterId);
    const rows = Array.from({ length: Math.min(r.limit, total - r.afterId) }, (_, i) =>
      msg(r.afterId + i + 1),
    );
    return page(r, rows, r.afterId + rows.length === total);
  });
  await f.api.poll();
  expect(offsets).toEqual([]);
  await expect(f.api.sync(a)).rejects.toThrow();
  await f.api.register({ ...a, channel: "@fixture" });
  await f.api.drain();
  expect(offsets).toEqual([0, 100, 200]);
  const [reg] = (await f.api.status(a)).registrations;
  expect(reg).toMatchObject({
    phase: "incremental",
    readThroughId: 207,
    fetchedCount: 207,
    processedCount: 207,
  });
  const root = f.docs.get(reg!.sourceDocumentIds[0]!)!;
  expect(root.content).toContain("[[id:");
  const sourceDocs = [...f.docs.values()].filter((c) => c.itemId.includes("-page-"));
  expect(sourceDocs.flatMap((c) => c.research!.sources)).toHaveLength(207);
  expect(sourceDocs[0]!.content).toContain(
    "2026-11-01T03:00:00.000Z · peer -1000000000123 · 메시지 1 · https://t.me/c/123/1",
  );
  expect(
    sourceDocs.every(
      (c) => c.kind === "rag-source" && c.scope === "project" && c.projectId === projectId,
    ),
  ).toBe(true);
  expect((await f.api.status({ projectId: other })).registrations).toHaveLength(0);
  total += 2;
  await f.restart();
  await f.api.poll();
  await f.api.drain();
  expect(offsets.at(-1)).toBe(207);
  const size = f.commands.size;
  await f.api.queueSync(a);
  await f.api.drain();
  expect(f.commands.size).toBe(size);
  expect(offsets.at(-1)).toBe(209);
  await f.api.unregister(a);
  await f.api.poll();
  expect(offsets.at(-1)).toBe(209);
});

it("acknowledges immediately and fetches more pages while a different channel or the same channel is summarizing", async () => {
  const first = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const seen: string[] = [];
  let max = 2;
  const f = await fixture(
    async (r) => {
      seen.push(r.peerId + "/" + r.afterId);
      if (r.afterId === 0 && r.peerId === a.peerId) await first.promise;
      return page(r, r.afterId < max ? [msg(r.afterId + 1)] : [], r.afterId + 1 >= max);
    },
    async (...args) => {
      await release.promise;
      return local(...args);
    },
  );
  await f.api.register(a);
  await f.api.register(b);
  first.resolve();
  await f.api.poll();
  expect(seen.indexOf(b.peerId + "/0")).toBeLessThan(seen.indexOf(a.peerId + "/1"));
  expect(
    (await f.api.status(a)).registrations.map((r) => [r.fetchedCount, r.processedCount]),
  ).toEqual([
    [2, 0],
    [2, 0],
  ]);
  max = 3;
  await f.api.poll();
  expect(seen).toContain(a.peerId + "/2");
  expect(seen).toContain(b.peerId + "/2");
  release.resolve();
  await f.api.drain();
  expect((await f.api.status(a)).registrations.every((r) => r.processedCount === 3)).toBe(true);
});

it("publishes a durable pending page after restart even when the next bridge read fails; replays the identical receipt", async () => {
  let offline = false;
  const f = await fixture(async (r) => {
    if (offline) throw new TelegramBridgeFailure("access_denied", false);
    return page(r, [msg(1)]);
  });
  f.failNextReceipt();
  await f.api.register(a);
  await f.api.drain();
  expect((await f.api.status(a)).registrations[0]).toMatchObject({
    phase: "error",
    fetchedCount: 1,
    processedCount: 0,
  });
  const attempted = f.attempts[0];
  await f.restart();
  offline = true;
  await f.api.poll();
  await f.api.drain();
  expect(f.attempts.filter((id) => id === attempted)).toHaveLength(2);
  expect(f.commands.size).toBe(2);
  expect((await f.api.status(a)).registrations[0]).toMatchObject({
    phase: "error",
    processedCount: 1,
  });
});

it("reports explicit unavailable IDs and blank media; rejects a mismatched peer and cursor without advancing", async () => {
  let corrupt = true;
  const f = await fixture(async (r) =>
    corrupt ? { ...page(r, [msg(2)]), peerId: b.peerId } : page(r, [msg(2, "")], true, [1]),
  );
  await f.api.register(a);
  await f.api.drain();
  expect((await f.api.status(a)).registrations[0]).toMatchObject({
    phase: "error",
    readThroughId: 0,
  });
  corrupt = false;
  await f.api.retry(a);
  await f.api.drain();
  expect((await f.api.status(a)).registrations[0]).toMatchObject({
    phase: "partial",
    missingTextCount: 1,
    unavailableCount: 1,
  });
  expect(
    [...f.docs.values()].some((d) =>
      d.content.includes("접근할 수 없는 메시지 · peer -1000000000123 · 메시지 1"),
    ),
  ).toBe(true);
});

it("honors a persisted account-wide FloodWait, pause, and removal", async () => {
  const read = vi.fn<ReadPage>(async () => {
    throw new TelegramBridgeFailure("flood_wait", true, 600);
  });
  const f = await fixture(read);
  await f.api.register(a);
  await f.api.drain();
  await f.api.register(b);
  await f.api.drain();
  await f.restart();
  await f.api.poll();
  await f.api.drain();
  expect(read).toHaveBeenCalledTimes(1);
  await f.api.pause(a);
  await f.api.sync(a);
  await f.api.drain();
  expect(
    (await f.api.status(a)).registrations.find((r) => r.registrationId === a.peerId)?.phase,
  ).toBe("paused");
  await f.api.unregister(b);
  expect((await f.api.status(b)).registrations).toHaveLength(1);
});

it("sends sanitized data only to the opted-in channel's exact CLI after local failure, and rechecks availability", async () => {
  const instanceId = ProviderInstanceId.make("subscription-cli"),
    modelId = "exact-foo";
  let available = true;
  const cli: TelegramCli = {
    listModels: async () =>
      available ? [{ instanceId, modelId, accountLabel: "사용자 계정" }] : [],
    generate: vi.fn(async (_s, req, signal) => local(req, signal)),
  };
  const f = await fixture(
    async (r) =>
      page(
        r,
        r.afterId
          ? []
          : [
              msg(
                1,
                r.peerId === a.peerId
                  ? "공개 회의 secret=not_a_real_token https://foreign.invalid/run"
                  : "다른 채널의 소식",
              ),
            ],
      ),
    async () => {
      throw Error("offline");
    },
    cli,
  );
  await f.api.register(a);
  await f.api.register(b);
  await f.api.drain();
  expect(cli.generate).not.toHaveBeenCalled();
  await expect(
    f.api.setPolicy({
      ...a,
      policy: { instanceId, modelId: "wrong", allowExternalTransfer: true },
    }),
  ).rejects.toThrow();
  await f.api.pause(a);
  await f.api.setPolicy({ ...a, policy: { instanceId, modelId, allowExternalTransfer: true } });
  await f.restart();
  available = false;
  await f.api.resume(a);
  await f.api.poll();
  await f.api.drain();
  expect(cli.generate).not.toHaveBeenCalled();
  available = true;
  await f.api.poll();
  await f.api.drain();
  expect(cli.generate).toHaveBeenCalledTimes(1);
  const [selection, request] = vi.mocked(cli.generate).mock.calls[0]!;
  expect(selection.modelId).toBe(modelId);
  expect(request.prompt).toContain("공개 회의");
  expect(request.prompt).not.toMatch(/not_a_real_token|foreign\.invalid|다른 채널/u);
  expect(
    (await f.api.status(a)).registrations.find((r) => r.registrationId === a.peerId)?.phase,
  ).toBe("incremental");
});
