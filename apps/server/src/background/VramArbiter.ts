// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

export const VRAM_TRAINING_LEASE_FILENAME = "vram-training-lease.json";
export const DEFAULT_USER_IDLE_WINDOW_MS = 30_000;
export const DEFAULT_TRAINING_LEASE_TTL_MS = 30 * 60 * 1000;
export const MAX_TRAINING_LEASE_TTL_MS = 6 * 60 * 60 * 1000;

export const VramTrainingLease = Schema.Struct({
  leaseId: Schema.String,
  owner: Schema.String,
  reason: Schema.optional(Schema.String),
  acquiredAtMs: Schema.Number,
  expiresAtMs: Schema.Number,
});
export type VramTrainingLease = typeof VramTrainingLease.Type;

const decodeLeaseJson = Schema.decodeUnknownOption(Schema.fromJsonString(VramTrainingLease));
const encodeLeaseJson = Schema.encodeSync(Schema.fromJsonString(VramTrainingLease));

export interface VramArbiterStatus {
  readonly paused: boolean;
  readonly activeLease: VramTrainingLease | null;
  readonly lastUserActivityAtMs: number | null;
  readonly msUntilIdle: number;
}

export function vramTrainingLeasePath(stateDir: string): string {
  return NodePath.join(stateDir, VRAM_TRAINING_LEASE_FILENAME);
}

function readLeaseFromDisk(stateDir: string, nowMs: number): VramTrainingLease | null {
  const filePath = vramTrainingLeasePath(stateDir);
  try {
    if (!NodeFS.existsSync(filePath)) return null;
    const raw = NodeFS.readFileSync(filePath, "utf8");
    const decoded = decodeLeaseJson(raw);
    if (Option.isNone(decoded)) return null;
    const lease = decoded.value;
    if (lease.expiresAtMs <= nowMs) {
      try {
        NodeFS.rmSync(filePath, { force: true });
      } catch {
        // Ignore best-effort stale lease cleanup failures.
      }
      return null;
    }
    return lease;
  } catch {
    return null;
  }
}

function writeLeaseToDisk(stateDir: string, lease: VramTrainingLease): void {
  const filePath = vramTrainingLeasePath(stateDir);
  const tmpPath = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  try {
    NodeFS.writeFileSync(tmpPath, `${encodeLeaseJson(lease)}\n`, "utf8");
    NodeFS.renameSync(tmpPath, filePath);
  } finally {
    try {
      NodeFS.rmSync(tmpPath, { force: true });
    } catch {
      // Already renamed or cleaned up.
    }
  }
}

function removeLeaseFromDisk(stateDir: string): void {
  try {
    NodeFS.rmSync(vramTrainingLeasePath(stateDir), { force: true });
  } catch {
    // Ignore best-effort cleanup failure.
  }
}

export interface VramArbiterController {
  readonly recordUserActivity: (nowMs?: number) => void;
  readonly msUntilUserIdle: (nowMs?: number, idleWindowMs?: number) => number;
  readonly getActiveLease: (stateDir?: string, nowMs?: number) => VramTrainingLease | null;
  readonly isBackgroundPaused: (stateDir?: string, nowMs?: number) => boolean;
  readonly acquireLease: (input: {
    readonly stateDir?: string;
    readonly owner: string;
    readonly reason?: string;
    readonly ttlMs?: number;
    readonly nowMs?: number;
  }) => VramTrainingLease;
  readonly releaseLease: (input?: {
    readonly stateDir?: string;
    readonly leaseId?: string;
  }) => boolean;
  readonly getStatus: (
    stateDir?: string,
    nowMs?: number,
    idleWindowMs?: number,
  ) => VramArbiterStatus;
  readonly reset: () => void;
}

export function createVramArbiter(): VramArbiterController {
  let memoryLease: VramTrainingLease | null = null;
  let lastUserActivityAtMs: number | null = null;

  const getActiveLease = (
    stateDir?: string,
    nowMs: number = Date.now(),
  ): VramTrainingLease | null => {
    if (memoryLease !== null) {
      if (memoryLease.expiresAtMs <= nowMs) {
        memoryLease = null;
      } else {
        return memoryLease;
      }
    }
    if (stateDir) {
      return readLeaseFromDisk(stateDir, nowMs);
    }
    return null;
  };

  const msUntilUserIdle = (
    nowMs: number = Date.now(),
    idleWindowMs: number = DEFAULT_USER_IDLE_WINDOW_MS,
  ): number => {
    if (lastUserActivityAtMs === null || idleWindowMs <= 0) return 0;
    const elapsed = nowMs - lastUserActivityAtMs;
    if (elapsed < 0) return 0;
    return Math.max(0, idleWindowMs - elapsed);
  };

  return {
    recordUserActivity(nowMs = Date.now()) {
      lastUserActivityAtMs = nowMs;
    },
    msUntilUserIdle,
    getActiveLease,
    isBackgroundPaused(stateDir?: string, nowMs = Date.now()) {
      return getActiveLease(stateDir, nowMs) !== null;
    },
    acquireLease(input) {
      const nowMs = input.nowMs ?? Date.now();
      const boundedTtl = Math.max(
        5_000,
        Math.min(MAX_TRAINING_LEASE_TTL_MS, input.ttlMs ?? DEFAULT_TRAINING_LEASE_TTL_MS),
      );
      const lease: VramTrainingLease = {
        leaseId: NodeCrypto.randomUUID(),
        owner: input.owner.trim() || "local-training",
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + boundedTtl,
      };
      memoryLease = lease;
      if (input.stateDir) {
        writeLeaseToDisk(input.stateDir, lease);
      }
      return lease;
    },
    releaseLease(input) {
      const targetId = input?.leaseId?.trim();
      let released = false;
      if (memoryLease && (!targetId || memoryLease.leaseId === targetId)) {
        memoryLease = null;
        released = true;
      }
      if (input?.stateDir) {
        const diskLease = readLeaseFromDisk(input.stateDir, 0);
        if (diskLease && (!targetId || diskLease.leaseId === targetId)) {
          removeLeaseFromDisk(input.stateDir);
          released = true;
        }
      }
      return released;
    },
    getStatus(
      stateDir?: string,
      nowMs = Date.now(),
      idleWindowMs = DEFAULT_USER_IDLE_WINDOW_MS,
    ): VramArbiterStatus {
      const activeLease = getActiveLease(stateDir, nowMs);
      return {
        paused: activeLease !== null,
        activeLease,
        lastUserActivityAtMs,
        msUntilIdle: msUntilUserIdle(nowMs, idleWindowMs),
      };
    },
    reset() {
      memoryLease = null;
      lastUserActivityAtMs = null;
    },
  };
}

/** Process-wide VRAM / idle arbiter shared across SemanticIndexJobs, OllamaEmbeddings, and HTTP control routes. */
export const vramArbiter = createVramArbiter();

const OllamaPsResponse = Schema.Struct({
  models: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        model: Schema.optional(Schema.String),
      }),
    ),
  ),
});

function validateLoopbackOllamaOrigin(endpoint: string): string | null {
  try {
    const parsed = new URL(endpoint);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Query local Ollama `/api/ps` and unload every resident model via `keep_alive: 0`
 * so exclusive GPU training pipelines (e.g. RTX 2080 Ti 11 GiB SFT/DPO) get clean VRAM.
 */
export const evictAllOllamaVram = Effect.fn("VramArbiter.evictAllOllamaVram")(function* (
  endpoint: string = "http://127.0.0.1:11434",
): Effect.fn.Return<
  { readonly evicted: ReadonlyArray<string>; readonly warnings: ReadonlyArray<string> },
  never,
  HttpClient.HttpClient
> {
  const origin = validateLoopbackOllamaOrigin(endpoint);
  if (!origin) {
    return {
      evicted: [],
      warnings: [`Rejected non-loopback Ollama endpoint: ${endpoint}`],
    };
  }
  const http = yield* HttpClient.HttpClient;
  const psResult = yield* HttpClientRequest.get(`${origin}/api/ps`).pipe(
    http.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaPsResponse)),
    Effect.timeout("3 seconds"),
    Effect.result,
  );
  if (psResult._tag === "Failure") {
    return {
      evicted: [],
      warnings: ["Ollama /api/ps unavailable or timed out"],
    };
  }

  const evicted: string[] = [];
  const warnings: string[] = [];
  const models = psResult.success.models ?? [];
  for (const item of models) {
    const modelName = item.name?.trim() || item.model?.trim();
    if (!modelName) continue;
    const unload = yield* HttpClientRequest.post(`${origin}/api/generate`).pipe(
      HttpClientRequest.bodyJson({ model: modelName, keep_alive: 0 }),
      Effect.flatMap(http.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout("5 seconds"),
      Effect.result,
    );
    if (unload._tag === "Success") {
      evicted.push(modelName);
    } else {
      warnings.push(`Failed to unload Ollama model ${modelName}`);
    }
  }

  return { evicted, warnings };
});
