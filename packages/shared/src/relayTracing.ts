import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import type { HttpClient } from "effect/unstable/http";

export interface RelayClientTracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface RelayClientTracingResource {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly runtime: string;
  readonly client: string;
  readonly component?: string;
}

export class RelayClientTracer extends Context.Reference(
  "@t3tools/shared/relayTracing/RelayClientTracer",
  {
    defaultValue: () => Option.none<Tracer.Tracer>(),
  },
) {}

export const withRelayClientTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  RelayClientTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (tracer) => effect.pipe(Effect.provideService(Tracer.Tracer, tracer)),
      }),
    ),
  );

/**
 * Hard-disabled in this fork: never export relay client traces to external
 * third-party OTLP/Axiom telemetry endpoints.
 */
export function makeRelayClientTracingLayer(
  _config: RelayClientTracingConfig | null,
  _resource: RelayClientTracingResource,
): Layer.Layer<never, never, HttpClient.HttpClient> {
  return Layer.succeed(RelayClientTracer, Option.none());
}
