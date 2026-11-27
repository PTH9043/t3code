/**
 * What the local trace file keeps.
 *
 * Almost every span the server produces is a routine one: it succeeded, said
 * nothing, and finished in a few milliseconds (a single SQL statement, a
 * projector step). Measured on a live install those were 88-95% of the file's
 * bytes, enough to rotate ten 10 MB files in about half an hour, which left
 * no history for the spans worth reading. The file therefore keeps only spans
 * that carry signal; the OTLP export and the self-monitoring counters still
 * see every span.
 *
 * @module traceRetention
 */
import type { TraceRecord } from "@t3tools/shared/observability";

/** Successful, event-less spans faster than this stay out of the local trace file. */
export const ROUTINE_SPAN_MAX_DURATION_MS = 50;

/**
 * Low-volume diagnostic spans that carry high-value telemetry (RAG routing hit-rate,
 * prompt breakdown) and must persist even when faster than {@link ROUTINE_SPAN_MAX_DURATION_MS}.
 */
export const ALWAYS_PERSIST_SPAN_NAMES: ReadonlySet<string> = new Set([
  "WorkspaceRoutingGraph.queryMoc",
  "WorkspaceRoutingGraph.promptInject",
  "ClaudeSession.firstPromptBreakdown",
]);

/**
 * True when the span belongs in the local trace file: anything that failed or
 * was interrupted, logged an event, is an always-persisted telemetry span, took at least
 * {@link ROUTINE_SPAN_MAX_DURATION_MS}, or did not come from this process.
 */
export function shouldPersistTraceRecord(record: TraceRecord): boolean {
  if (record.type !== "effect-span") return true;
  if (record.exit._tag !== "Success") return true;
  if (record.events.length > 0) return true;
  if (ALWAYS_PERSIST_SPAN_NAMES.has(record.name)) return true;
  return !(record.durationMs < ROUTINE_SPAN_MAX_DURATION_MS);
}
