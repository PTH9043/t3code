import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";

import * as TraceDiagnostics from "./TraceDiagnostics.ts";
import { unifiedExecutionLedger } from "../t3x/executionLedger/UnifiedExecutionLedger.ts";

function ns(ms: number): string {
  return String(BigInt(ms) * 1_000_000n);
}

function record(input: {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly exit?: { readonly _tag: "Success" | "Failure" | "Interrupted"; readonly cause?: string };
  readonly events?: ReadonlyArray<unknown>;
}) {
  return JSON.stringify({
    type: "effect-span",
    name: input.name,
    traceId: input.traceId,
    spanId: input.spanId,
    sampled: true,
    kind: "internal",
    startTimeUnixNano: ns(input.startMs),
    endTimeUnixNano: ns(input.startMs + input.durationMs),
    durationMs: input.durationMs,
    attributes: input.attributes ?? {},
    events: input.events ?? [],
    links: [],
    exit: input.exit ?? { _tag: "Success" },
  });
}

describe("TraceDiagnostics", () => {
  it.effect("aggregates failures, slow spans, log levels, and parse errors", () =>
    Effect.sync(() => {
      const diagnostics = TraceDiagnostics.aggregateTraceDiagnostics({
        traceFilePath: "/tmp/server.trace.ndjson",
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        slowSpanThresholdMs: 1_000,
        files: [
          {
            path: "/tmp/server.trace.ndjson.1",
            text: [
              record({
                name: "server.getConfig",
                traceId: "trace-a",
                spanId: "span-a",
                startMs: 1_000,
                durationMs: 50,
              }),
              "not-json",
            ].join("\n"),
          },
          {
            path: "/tmp/server.trace.ndjson",
            text: [
              record({
                name: "orchestration.dispatch",
                traceId: "trace-b",
                spanId: "span-b",
                startMs: 2_000,
                durationMs: 1_500,
                exit: { _tag: "Failure", cause: "Provider crashed" },
                events: [
                  {
                    name: "provider failed",
                    timeUnixNano: ns(3_400),
                    attributes: { "effect.logLevel": "Error" },
                  },
                ],
              }),
              record({
                name: "orchestration.dispatch",
                traceId: "trace-c",
                spanId: "span-c",
                startMs: 4_000,
                durationMs: 250,
                exit: { _tag: "Failure", cause: "Provider crashed" },
              }),
              record({
                name: "git.status",
                traceId: "trace-d",
                spanId: "span-d",
                startMs: 5_000,
                durationMs: 25,
                exit: { _tag: "Interrupted", cause: "Interrupted" },
                events: [
                  {
                    name: "status delayed",
                    timeUnixNano: ns(5_010),
                    attributes: { "effect.logLevel": "Warning" },
                  },
                ],
              }),
            ].join("\n"),
          },
        ],
      });

      assert.equal(diagnostics.recordCount, 4);
      assert.equal(DateTime.formatIso(diagnostics.readAt), "2026-05-05T10:00:00.000Z");
      assert.equal(
        Option.match(diagnostics.firstSpanAt, {
          onNone: () => null,
          onSome: DateTime.formatIso,
        }),
        "1970-01-01T00:00:01.000Z",
      );
      assert.equal(
        Option.match(diagnostics.lastSpanAt, {
          onNone: () => null,
          onSome: DateTime.formatIso,
        }),
        "1970-01-01T00:00:05.025Z",
      );
      assert.equal(diagnostics.parseErrorCount, 1);
      assert.equal(diagnostics.failureCount, 2);
      assert.equal(diagnostics.interruptionCount, 1);
      assert.equal(diagnostics.slowSpanCount, 1);
      assert.equal(diagnostics.logLevelCounts.Error, 1);
      assert.equal(diagnostics.logLevelCounts.Warning, 1);
      assert.equal(diagnostics.commonFailures[0]?.name, "orchestration.dispatch");
      assert.equal(diagnostics.commonFailures[0]?.count, 2);
      assert.equal(diagnostics.latestFailures[0]?.traceId, "trace-c");
      assert.equal(diagnostics.slowestSpans[0]?.traceId, "trace-b");
      assert.equal(diagnostics.latestWarningAndErrorLogs[0]?.message, "status delayed");
      assert.equal(diagnostics.topSpansByCount[0]?.name, "orchestration.dispatch");
    }),
  );

  it.effect("returns a not-found diagnostic when no files are available", () =>
    Effect.sync(() => {
      const diagnostics = TraceDiagnostics.aggregateTraceDiagnostics({
        traceFilePath: "/tmp/missing.trace.ndjson",
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        files: [],
      });

      assert.equal(diagnostics.recordCount, 0);
      assert.equal(Option.getOrUndefined(diagnostics.error)?.kind, "trace-file-not-found");
    }),
  );

  it.effect("preserves full failure causes and log messages", () =>
    Effect.sync(() => {
      const longCause = `VcsProcessSpawnError: ${"missing executable ".repeat(80)}`.trim();
      const longMessage = `provider warning: ${"retrying command ".repeat(80)}`.trim();
      const diagnostics = TraceDiagnostics.aggregateTraceDiagnostics({
        traceFilePath: "/tmp/server.trace.ndjson",
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        files: [
          {
            path: "/tmp/server.trace.ndjson",
            text: record({
              name: "VcsProcess.run",
              traceId: "trace-long",
              spanId: "span-long",
              startMs: 1_000,
              durationMs: 25,
              exit: { _tag: "Failure", cause: longCause },
              events: [
                {
                  name: longMessage,
                  timeUnixNano: ns(1_010),
                  attributes: { "effect.logLevel": "Warning" },
                },
              ],
            }),
          },
        ],
      });

      assert.equal(diagnostics.latestFailures[0]?.cause, longCause);
      assert.equal(diagnostics.commonFailures[0]?.cause, longCause);
      assert.equal(diagnostics.latestWarningAndErrorLogs[0]?.message, longMessage);
    }),
  );

  it.effect("keeps loaded trace data when one rotated trace file fails to read", () =>
    Effect.gen(function* () {
      const traceFilePath = "/tmp/server.trace.ndjson";
      const readFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        description: "permission denied",
        pathOrDescriptor: `${traceFilePath}.1`,
      });
      const fileSystemLayer = FileSystem.layerNoop({
        readFileString: (path) =>
          path === `${traceFilePath}.1`
            ? Effect.fail(readFailure)
            : Effect.succeed(
                record({
                  name: "server.getConfig",
                  traceId: "trace-a",
                  spanId: "span-a",
                  startMs: 1_000,
                  durationMs: 50,
                }),
              ),
      });
      const logAnnotations: Array<Record<string, unknown>> = [];
      const logger = Logger.make<unknown, void>((options) => {
        logAnnotations.push({ ...options.fiber.getRef(References.CurrentLogAnnotations) });
      });

      const diagnostics = yield* TraceDiagnostics.readTraceDiagnostics({
        traceFilePath,
        maxFiles: 1,
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TraceDiagnostics.layer.pipe(Layer.provide(fileSystemLayer)),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );

      assert.equal(diagnostics.recordCount, 1);
      assert.equal(
        Option.getOrElse(diagnostics.partialFailure, () => false),
        true,
      );
      assert.deepStrictEqual(Option.getOrUndefined(diagnostics.error), {
        kind: "trace-file-read-failed",
        message: `Failed to read local trace file '${traceFilePath}.1'.`,
      });
      assert.deepStrictEqual(diagnostics.scannedFilePaths, [`${traceFilePath}.1`, traceFilePath]);

      const failureLog = logAnnotations.find(
        (annotations) => annotations.traceFilePath === `${traceFilePath}.1`,
      );
      assert.exists(failureLog);
      assert.deepStrictEqual(failureLog, {
        traceFilePath: `${traceFilePath}.1`,
        errorTag: "TraceFileReadError",
        causeTag: "PermissionDenied",
      });
    }),
  );

  it.effect("keeps only the slowest span occurrences while aggregating large inputs", () =>
    Effect.sync(() => {
      const diagnostics = TraceDiagnostics.aggregateTraceDiagnostics({
        traceFilePath: "/tmp/server.trace.ndjson",
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        files: [
          {
            path: "/tmp/server.trace.ndjson",
            text: Array.from({ length: 25 }, (_, index) =>
              record({
                name: `span-${index}`,
                traceId: `trace-${index}`,
                spanId: `span-${index}`,
                startMs: index * 1_000,
                durationMs: index,
              }),
            ).join("\n"),
          },
        ],
      });

      assert.equal(diagnostics.recordCount, 25);
      assert.equal(diagnostics.slowestSpans.length, 10);
      assert.deepStrictEqual(
        diagnostics.slowestSpans.map((span) => span.durationMs),
        [24, 23, 22, 21, 20, 19, 18, 17, 16, 15],
      );
    }),
  );

  it.effect("separates long-lived subscriptions and AI turns from slow operational spans", () =>
    Effect.sync(() => {
      const diagnostics = TraceDiagnostics.aggregateTraceDiagnostics({
        traceFilePath: "/tmp/server.trace.ndjson",
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        slowSpanThresholdMs: 1_000,
        files: [
          {
            path: "/tmp/server.trace.ndjson",
            text: [
              record({
                name: "ws.rpc.orchestration.subscribeThread",
                traceId: "trace-sub-1",
                spanId: "span-sub-1",
                startMs: 1_000,
                durationMs: 7_722_000,
                attributes: {
                  "rpc.kind": "subscription",
                  "rpc.subscription.ttfb_ms": 42.5,
                },
              }),
              record({
                name: "ws.rpc.git.subscribeStatus",
                traceId: "trace-sub-2",
                spanId: "span-sub-2",
                startMs: 2_000,
                durationMs: 4_084_000,
                exit: { _tag: "Failure", cause: "live buffer overflow" },
              }),
              record({
                name: "CodexAdapter.sendTurn",
                traceId: "trace-turn-1",
                spanId: "span-turn-1",
                startMs: 3_000,
                durationMs: 180_000,
              }),
              record({
                name: "probeCodexAppServerProvider",
                traceId: "trace-op-1",
                spanId: "span-op-1",
                startMs: 4_000,
                durationMs: 15_000,
              }),
            ].join("\n"),
          },
        ],
      });

      assert.equal(diagnostics.slowSpanCount, 1);
      assert.deepStrictEqual(
        diagnostics.slowestSpans.map((span) => span.name),
        ["probeCodexAppServerProvider"],
      );
      assert.equal(diagnostics.longLivedSubscriptionCount, 2);
      assert.equal(diagnostics.subscriptionBufferOverflowCount, 1);
      assert.equal(
        diagnostics.longLivedSubscriptions?.[0]?.name,
        "ws.rpc.orchestration.subscribeThread",
      );
      assert.equal(diagnostics.longLivedSubscriptions?.[0]?.ttfbMs, 42.5);
      assert.equal(diagnostics.longLivedSubscriptions?.[1]?.bufferOverflow, true);
      assert.equal(diagnostics.longRunningTurnCount, 1);
      assert.equal(diagnostics.longRunningTurns?.[0]?.name, "CodexAdapter.sendTurn");
    }),
  );

  it.effect(
    "classifies WorkspaceAgentExecutor and CouncilOrchestrator as long turns and excludes subscriptions from topSpansByCount",
    () =>
      Effect.sync(() => {
        const diagnostics = TraceDiagnostics.aggregateTraceDiagnostics({
          traceFilePath: "/tmp/server.trace.ndjson",
          readAt: DateTime.makeUnsafe("2026-11-22T08:00:00.000Z"),
          slowSpanThresholdMs: 1_000,
          files: [
            {
              path: "/tmp/server.trace.ndjson",
              text: [
                record({
                  name: "direct.rpc.council.subscribe",
                  traceId: "trace-c-sub",
                  spanId: "span-c-sub",
                  startMs: 1_000,
                  durationMs: 1_199_800,
                }),
                record({
                  name: "WorkspaceAgentExecutor.execute",
                  traceId: "trace-exec-1",
                  spanId: "span-exec-1",
                  startMs: 2_000,
                  durationMs: 95_000,
                  attributes: { "t3.thread_id": "thr-1", "t3.execution_id": "exec-1" },
                }),
                record({
                  name: "CouncilOrchestrator.executePinnedSpec",
                  traceId: "trace-cnc-1",
                  spanId: "span-cnc-1",
                  startMs: 3_000,
                  durationMs: 42_000,
                  attributes: { "t3.thread_id": "thr-1", "t3.council_id": "cnc-1" },
                }),
                record({
                  name: "git.status",
                  traceId: "trace-op-fast",
                  spanId: "span-op-fast",
                  startMs: 4_000,
                  durationMs: 1_500,
                }),
              ].join("\n"),
            },
          ],
        });

        assert.equal(diagnostics.slowSpanCount, 1);
        assert.deepStrictEqual(
          diagnostics.slowestSpans.map((span) => span.name),
          ["git.status"],
        );
        assert.equal(diagnostics.longLivedSubscriptionCount, 1);
        assert.equal(diagnostics.longRunningTurnCount, 2);
        assert.deepStrictEqual(
          diagnostics.longRunningTurns?.map((span) => span.name),
          ["WorkspaceAgentExecutor.execute", "CouncilOrchestrator.executePinnedSpec"],
        );
        assert.equal(
          diagnostics.topSpansByCount.some((item) => item.name === "direct.rpc.council.subscribe"),
          false,
        );
      }),
  );

  it.effect("attaches UnifiedExecutionLedger 9-kind summary in TraceDiagnostics.read", () =>
    Effect.gen(function* () {
      unifiedExecutionLedger.resetForTests();
      unifiedExecutionLedger.begin({
        executionId: "diag-ledger-test-1",
        executionKind: "council",
        threadId: "thr-diag-1",
        summary: "진단 원장 테스트",
        startedAtMs: 1_700_000_000_000,
      });
      try {
        const result = yield* TraceDiagnostics.readTraceDiagnostics({
          traceFilePath: "/tmp/non-existent-trace.ndjson",
          maxFiles: 2,
          readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        }).pipe(
          Effect.provide(
            TraceDiagnostics.layer.pipe(
              Layer.provide(
                FileSystem.layerNoop({
                  readFileString: (filePath) =>
                    Effect.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFileString",
                        pathOrDescriptor: filePath,
                      }),
                    ),
                }),
              ),
            ),
          ),
        );

        assert.isDefined(result.executionLedger);
        assert.equal(result.executionLedger?.activeRuns, 1);
        assert.equal(result.executionLedger?.byKind.length, 9);
        assert.equal(
          result.executionLedger?.recentRuns.some((r) => r.executionId === "diag-ledger-test-1"),
          true,
        );
      } finally {
        unifiedExecutionLedger.resetForTests();
      }
    }),
  );
});
