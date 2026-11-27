// @effect-diagnostics globalDate:off
export type ClassifierSignalSource = "structured" | "heuristic" | "fallback";

export interface ClassifierTelemetry<TDecision extends string = string> {
  readonly classifier: string;
  readonly decision: TDecision;
  readonly confidence: number;
  readonly fallbackUsed: boolean;
  readonly ruleId: string;
  readonly signalSource: ClassifierSignalSource;
}

export interface ClassifierMetricsSnapshot {
  readonly classifier: string;
  readonly totalCalls: number;
  readonly fallbackCount: number;
  readonly unknownCount: number;
  readonly fallbackRate: number;
  readonly unknownRate: number;
  readonly byDecision: Readonly<Record<string, number>>;
  readonly byRuleId: Readonly<Record<string, number>>;
  readonly lastDecision: string;
  readonly lastRuleId: string;
  readonly lastSignalSource: ClassifierSignalSource;
  readonly lastRecordedAtMs: number;
}

interface MutableClassifierBucket {
  totalCalls: number;
  fallbackCount: number;
  unknownCount: number;
  byDecision: Map<string, number>;
  byRuleId: Map<string, number>;
  lastDecision: string;
  lastRuleId: string;
  lastSignalSource: ClassifierSignalSource;
  lastRecordedAtMs: number;
}

const MAX_REGISTERED_CLASSIFIERS = 64;
const MAX_KEYS_PER_BUCKET = 64;

const classifierRegistry = new Map<string, MutableClassifierBucket>();

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function incrementBoundedMap(map: Map<string, number>, key: string): void {
  const existing = map.get(key);
  if (existing !== undefined) {
    map.set(key, existing + 1);
    return;
  }
  if (map.size < MAX_KEYS_PER_BUCKET) {
    map.set(key, 1);
    return;
  }
  map.set("__other__", (map.get("__other__") ?? 0) + 1);
}

export function createClassifierTelemetry<TDecision extends string>(input: {
  readonly classifier: string;
  readonly decision: TDecision;
  readonly confidence: number;
  readonly fallbackUsed: boolean;
  readonly ruleId: string;
  readonly signalSource: ClassifierSignalSource;
}): ClassifierTelemetry<TDecision> {
  return {
    classifier: input.classifier,
    decision: input.decision,
    confidence: clampConfidence(input.confidence),
    fallbackUsed: input.fallbackUsed,
    ruleId: input.ruleId,
    signalSource: input.signalSource,
  };
}

export function createUnknownFallbackTelemetry(
  classifier: string,
  ruleId = "fallback.unknown",
): ClassifierTelemetry<"unknown"> {
  return {
    classifier,
    decision: "unknown",
    confidence: 0,
    fallbackUsed: true,
    ruleId,
    signalSource: "fallback",
  };
}

/**
 * Records a classifier decision into the bounded in-process registry so
 * diagnostics and regression tests can measure fallback/unknown rates across
 * every heuristic classifier in one place.
 */
export function recordClassifierDecision<TDecision extends string>(
  telemetry: ClassifierTelemetry<TDecision>,
): ClassifierTelemetry<TDecision> {
  let bucket = classifierRegistry.get(telemetry.classifier);
  if (!bucket) {
    if (classifierRegistry.size >= MAX_REGISTERED_CLASSIFIERS) {
      return telemetry;
    }
    bucket = {
      totalCalls: 0,
      fallbackCount: 0,
      unknownCount: 0,
      byDecision: new Map(),
      byRuleId: new Map(),
      lastDecision: telemetry.decision,
      lastRuleId: telemetry.ruleId,
      lastSignalSource: telemetry.signalSource,
      lastRecordedAtMs: Date.now(),
    };
    classifierRegistry.set(telemetry.classifier, bucket);
  }
  bucket.totalCalls += 1;
  if (telemetry.fallbackUsed || telemetry.signalSource === "fallback") {
    bucket.fallbackCount += 1;
  }
  if (telemetry.decision === "unknown") {
    bucket.unknownCount += 1;
  }
  incrementBoundedMap(bucket.byDecision, telemetry.decision);
  incrementBoundedMap(bucket.byRuleId, telemetry.ruleId);
  bucket.lastDecision = telemetry.decision;
  bucket.lastRuleId = telemetry.ruleId;
  bucket.lastSignalSource = telemetry.signalSource;
  bucket.lastRecordedAtMs = Date.now();
  return telemetry;
}

export function createAndRecordClassifierTelemetry<TDecision extends string>(input: {
  readonly classifier: string;
  readonly decision: TDecision;
  readonly confidence: number;
  readonly fallbackUsed: boolean;
  readonly ruleId: string;
  readonly signalSource: ClassifierSignalSource;
}): ClassifierTelemetry<TDecision> {
  return recordClassifierDecision(createClassifierTelemetry(input));
}

export function getClassifierTelemetrySnapshot(): ReadonlyArray<ClassifierMetricsSnapshot> {
  return [...classifierRegistry.entries()]
    .map(([classifier, bucket]) => ({
      classifier,
      totalCalls: bucket.totalCalls,
      fallbackCount: bucket.fallbackCount,
      unknownCount: bucket.unknownCount,
      fallbackRate:
        bucket.totalCalls > 0 ? Number((bucket.fallbackCount / bucket.totalCalls).toFixed(4)) : 0,
      unknownRate:
        bucket.totalCalls > 0 ? Number((bucket.unknownCount / bucket.totalCalls).toFixed(4)) : 0,
      byDecision: Object.fromEntries(bucket.byDecision.entries()),
      byRuleId: Object.fromEntries(bucket.byRuleId.entries()),
      lastDecision: bucket.lastDecision,
      lastRuleId: bucket.lastRuleId,
      lastSignalSource: bucket.lastSignalSource,
      lastRecordedAtMs: bucket.lastRecordedAtMs,
    }))
    .sort((a, b) => a.classifier.localeCompare(b.classifier));
}

export function resetClassifierTelemetryRegistry(): void {
  classifierRegistry.clear();
}

export function formatClassifierTelemetryLog(
  telemetry: ClassifierTelemetry,
): Readonly<Record<string, unknown>> {
  return {
    classifier: telemetry.classifier,
    decision: telemetry.decision,
    confidence: telemetry.confidence,
    fallbackUsed: telemetry.fallbackUsed,
    ruleId: telemetry.ruleId,
    signalSource: telemetry.signalSource,
  };
}
