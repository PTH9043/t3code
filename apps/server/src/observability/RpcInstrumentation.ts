import { WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import * as References from "effect/References";
import * as Stream from "effect/Stream";

import { outcomeFromExit } from "./Attributes.ts";
import { metricAttributes, rpcRequestDuration, rpcRequestsTotal, withMetrics } from "./Metrics.ts";

const LIVE_BUFFER_OVERFLOW_PATTERN = /live buffer|buffer[_\s-]?overflow/iu;

function isLiveBufferOverflowExit<E>(exit: Exit.Exit<unknown, E>): boolean {
  if (!Exit.isFailure(exit)) {
    return false;
  }
  return LIVE_BUFFER_OVERFLOW_PATTERN.test(Cause.pretty(exit.cause));
}

const DEFAULT_RPC_SPAN_ATTRIBUTES = {
  "rpc.transport": "websocket",
  "rpc.system": "effect-rpc",
} as const;
const RPC_METHODS_WITH_TRACING_DISABLED: ReadonlySet<string> = new Set([
  WS_METHODS.serverGetTraceDiagnostics,
  WS_METHODS.serverGetProcessDiagnostics,
  WS_METHODS.serverGetProcessResourceHistory,
  WS_METHODS.serverSignalProcess,
]);

function shouldTraceRpc(method: string): boolean {
  return !RPC_METHODS_WITH_TRACING_DISABLED.has(method);
}

const rpcSpanName = (method: string, traceAttributes?: Readonly<Record<string, unknown>>) =>
  `${traceAttributes?.["rpc.transport"] === "desktop-direct" ? "direct.rpc" : "ws.rpc"}.${method}`;

const rpcSpanAttributes = (
  method: string,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({
  ...DEFAULT_RPC_SPAN_ATTRIBUTES,
  "rpc.method": method,
  ...traceAttributes,
});

const withRpcEffectTracing = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Effect.Effect<A, E, R> =>
  shouldTraceRpc(method)
    ? effect.pipe(
        Effect.withSpan(rpcSpanName(method, traceAttributes), {
          attributes: rpcSpanAttributes(method, traceAttributes),
        }),
      )
    : effect.pipe(Effect.provideService(References.TracerEnabled, false));

const withRpcStreamTracing = <A, E, R>(
  method: string,
  stream: Stream.Stream<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Stream.Stream<A, E, R> =>
  shouldTraceRpc(method)
    ? stream.pipe(
        Stream.withSpan(rpcSpanName(method, traceAttributes), {
          attributes: rpcSpanAttributes(method, {
            "rpc.kind": "subscription",
            ...traceAttributes,
          }),
        }),
      )
    : stream.pipe(Stream.provideService(References.TracerEnabled, false));

const recordRpcStreamMetrics = <E>(
  method: string,
  startedAt: bigint,
  exit: Exit.Exit<unknown, E>,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const endedAt = yield* Clock.currentTimeNanos;
    const elapsedNanos = endedAt > startedAt ? endedAt - startedAt : 0n;

    if (isLiveBufferOverflowExit(exit)) {
      yield* Effect.annotateCurrentSpan("rpc.subscription.buffer_overflow", true);
    }

    yield* Metric.update(
      Metric.withAttributes(rpcRequestDuration, metricAttributes({ method })),
      Duration.nanos(elapsedNanos),
    );
    yield* Metric.update(
      Metric.withAttributes(
        rpcRequestsTotal,
        metricAttributes({
          method,
          outcome: outcomeFromExit(exit),
        }),
      ),
      1,
    );
  });

const trackStreamSubscriptionTtfb = <A, E, R>(
  startedAt: bigint,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> => {
  let firstItemRecorded = false;
  return stream.pipe(
    Stream.tap(() => {
      if (firstItemRecorded) {
        return Effect.void;
      }
      firstItemRecorded = true;
      return Effect.gen(function* () {
        const emittedAt = yield* Clock.currentTimeNanos;
        const ttfbNanos = emittedAt > startedAt ? emittedAt - startedAt : 0n;
        const ttfbMs = Math.round((Number(ttfbNanos) / 1_000_000) * 100) / 100;
        yield* Effect.annotateCurrentSpan("rpc.subscription.ttfb_ms", ttfbMs);
      });
    }),
  );
};

export const observeRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Effect.Effect<A, E, R> => {
  const instrumented = effect.pipe(
    withMetrics({
      counter: rpcRequestsTotal,
      timer: rpcRequestDuration,
      attributes: {
        method,
      },
    }),
  );

  return withRpcEffectTracing(method, instrumented, traceAttributes);
};

export const observeRpcStream = <A, E, R>(
  method: string,
  stream: Stream.Stream<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Stream.Stream<A, E, R> => {
  const instrumented = Stream.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeNanos;
      return trackStreamSubscriptionTtfb(startedAt, stream).pipe(
        Stream.onExit((exit) => recordRpcStreamMetrics(method, startedAt, exit)),
      );
    }),
  );

  return withRpcStreamTracing(method, instrumented, traceAttributes);
};

export const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
  method: string,
  effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Stream.Stream<A, StreamError | EffectError, StreamContext | EffectContext> => {
  const instrumented = Stream.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeNanos;
      const exit = yield* Effect.exit(effect);

      if (Exit.isFailure(exit)) {
        yield* recordRpcStreamMetrics(method, startedAt, exit);
        return yield* Effect.failCause(exit.cause);
      }

      return trackStreamSubscriptionTtfb(startedAt, exit.value).pipe(
        Stream.onExit((streamExit) => recordRpcStreamMetrics(method, startedAt, streamExit)),
      );
    }),
  );

  return withRpcStreamTracing(method, instrumented, traceAttributes);
};
