import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  OrchestrationProjectShell,
  ProjectId,
  type OrchestrationCommand,
  type WorkspaceResearchInput,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  GrokResearch,
  GrokResearchLive,
  researchCostSummary,
  researchResponseText,
} from "./GrokResearch.ts";

const projectId = ProjectId.make("research-project");
const query: WorkspaceResearchInput = {
  projectId,
  requestId: "request-one",
  query: "최근 개발 방법 조사",
  source: "both",
  allowedDomains: ["docs.x.ai"],
  allowedHandles: ["xai"],
  fromDate: "2026-10-01",
  toDate: "2026-10-13",
};
const answer = (id: string, cost: number | undefined, inputTokens = 100) => ({
  id,
  status: "completed",
  usage: {
    cost_in_usd_ticks: cost,
    input_tokens: inputTokens,
    output_tokens: 45,
    input_tokens_details: { cached_tokens: 80 },
  },
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "공식 문서에서 확인한 결과",
          annotations: [
            { type: "url_citation", url: "https://docs.x.ai/developers/tools/web-search" },
            { type: "url_citation", url: "javascript:alert(1)" },
          ],
        },
      ],
    },
  ],
});
const unexpected = () => Effect.die("Unexpected projection query");
const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: projectId,
  title: "Research",
  workspaceRoot: "D:/test",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-12T00:00:00Z",
  updatedAt: "2026-10-12T00:00:00Z",
});
const queryLayer = Layer.succeed(ProjectionSnapshotQuery, {
  getProjectShellById: (id) =>
    Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
  getCommandReadModel: unexpected,
  getSnapshot: unexpected,
  getShellSnapshot: unexpected,
  getArchivedShellSnapshot: unexpected,
  searchThreads: unexpected,
  getSnapshotSequence: unexpected,
  getCounts: unexpected,
  getActiveProjectByWorkspaceRoot: unexpected,
  getFirstActiveThreadIdByProjectId: unexpected,
  getThreadCheckpointContext: unexpected,
  getFullThreadDiffContext: unexpected,
  getThreadShellById: unexpected,
  getThreadRuntimeContext: () => Effect.die("unused runtime context"),
  getThreadDetailById: unexpected,
  getThreadDetailSnapshot: unexpected,
});
const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
function harness(
  responses: readonly unknown[],
  commands: OrchestrationCommand[],
  requests: { url: string; body: Readonly<Record<string, unknown>> }[],
  limit: number | null = null,
) {
  let key: Uint8Array | undefined;
  let index = 0;
  return GrokResearchLive.pipe(
    Layer.provide(
      Layer.succeed(ServerSecretStore, {
        get: () => Effect.succeed(Option.fromNullishOr(key)),
        set: (_, value) =>
          Effect.sync(() => {
            key = value;
          }),
        remove: () =>
          Effect.sync(() => {
            key = undefined;
          }),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.provide(queryLayer),
    Layer.provide(ServerSettings.layerTest({ aiSearch: { researchDailyUsd: limit } })),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request");
            requests.push({
              url: request.url,
              body: decodeBody(new TextDecoder().decode(request.body.body)),
            });
            const body = responses[index++];
            return HttpClientResponse.fromWeb(
              request,
              body === "failure"
                ? new Response("Unavailable", { status: 503 })
                : Response.json(body),
            );
          }),
        ),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-grok-research-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect(
  "saves cited research, deduplicates repeated requests and persists cost without credentials",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      expect((yield* service.status(projectId)).apiKeyReady).toBe(false);
      yield* service.configureKey("test-research-key-never-log");
      const first = yield* service.run(query);
      expect(first.sources).toEqual(["https://docs.x.ai/developers/tools/web-search"]);
      expect(first.costTicks).toBe(100_000_000);
      yield* service.run(query);
      expect(requests).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "project.knowledge.item.upsert",
        projectId,
        kind: "rag-source",
        research: { verification: "unverified", query: query.query },
      });
      const result = yield* service.status(projectId);
      expect(result.reportedTodayUsd).toBe(0.01);
      expect(result.unreportedCalls).toBe(0);
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const journal = yield* fs.readFileString(`${config.stateDir}/grok-research/journal.json`);
      expect(journal).not.toContain("test-research-key-never-log");
      expect(requests[0]?.body).toMatchObject({
        store: false,
        tools: [
          { type: "web_search", filters: { allowed_domains: ["docs.x.ai"] } },
          {
            type: "x_search",
            allowed_x_handles: ["xai"],
            from_date: query.fromDate,
            to_date: query.toDate,
          },
        ],
      });
      expect((yield* service.run({ ...query, query: "changed" }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* service.status(ProjectId.make("other")).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.provide(harness([answer("response-one", 100_000_000)], commands, requests)));
  },
);
it.effect(
  "compacts long follow-up state verbatim, accounts for its cost and stops after the daily limit",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    const compacted = {
      id: "compact-one",
      output: [
        {
          type: "compaction",
          encrypted_content: "opaque-DONT-CHANGE",
          extra_metadata: { original: true },
        },
      ],
      usage: { cost_in_usd_ticks: 50_000_000 },
    };
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("test-key");
      yield* service.run(query);
      yield* service.run({
        ...query,
        requestId: "follow-up",
        followUpId: query.requestId,
        query: "후속 조사",
      });
      expect(requests).toHaveLength(3);
      expect(requests[1]?.url).toContain("/compact");
      expect(requests[2]?.body.input).toEqual([
        compacted.output[0],
        expect.objectContaining({ role: "user" }),
      ]);
      expect(requests[0]?.body.prompt_cache_key).toBe(requests[2]?.body.prompt_cache_key);
      const result = yield* service.status(projectId);
      expect(result.reportedTodayUsd).toBe(0.018);
      expect(result.calls.filter((call) => call.kind === "compaction")).toHaveLength(1);
      expect(
        (yield* service.run({ ...query, requestId: "over-limit" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(requests).toHaveLength(3);
    }).pipe(
      Effect.provide(
        harness(
          [answer("r1", 100_000_000, 20_000), compacted, answer("r2", 30_000_000)],
          commands,
          requests,
          0.016,
        ),
      ),
    );
  },
);
it.effect("never resends uncertain calls and keeps missing reported costs unknown", () => {
  const commands: OrchestrationCommand[] = [];
  const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
  return Effect.gen(function* () {
    const service = yield* GrokResearch;
    yield* service.configureKey("test-key");
    expect((yield* service.run(query).pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* service.run(query).pipe(Effect.result))._tag).toBe("Failure");
    expect(requests).toHaveLength(1);
    expect((yield* service.status(projectId)).unreportedCalls).toBe(1);
    expect((yield* service.status(projectId)).calls[0]?.status).toBe("uncertain");
    expect((yield* service.run({ ...query, requestId: "new-call" }).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(commands).toHaveLength(0);
  }).pipe(Effect.provide(harness(["failure"], commands, requests, 1)));
});
it.effect(
  "keeps successful calls with unreported cost unknown and prevents the next capped call",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("test-key");
      const result = yield* service.run(query);
      expect(result.costTicks).toBeNull();
      expect(result.status).toBe("complete");
      expect(result.itemId).not.toBeNull();
      expect((yield* service.status(projectId)).unreportedCalls).toBe(1);
      expect((yield* service.run({ ...query, requestId: "next" }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(harness([answer("no-cost", undefined)], commands, requests, 1)));
  },
);
it.effect(
  "records incomplete response cost without saving unfinished research or repeating the call",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("test-key");
      expect((yield* service.run(query).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* service.run(query).pipe(Effect.result))._tag).toBe("Failure");
      const status = yield* service.status(projectId);
      expect(status.reportedTodayUsd).toBe(0.01);
      expect(status.calls[0]?.status).toBe("uncertain");
      expect(commands).toHaveLength(0);
      expect(requests).toHaveLength(1);
    }).pipe(
      Effect.provide(
        harness(
          [{ ...answer("incomplete", 100_000_000), status: "incomplete" }],
          commands,
          requests,
        ),
      ),
    );
  },
);
it("does not invent missing cost and ignores unsafe citation URLs", () => {
  const response = answer("r", undefined);
  expect(researchResponseText(response).sources).toHaveLength(1);
  expect(researchCostSummary([], "2026-10-12", projectId)).toEqual({
    reportedTodayUsd: 0,
    projectTodayUsd: 0,
    unreportedCalls: 0,
  });
});
