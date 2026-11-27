// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

export interface NativeTopKHit {
  readonly index: number;
  readonly score: number;
}

export interface NativeKeyedPoolHit {
  readonly contentKey: string;
  readonly similarity: number;
}

export interface NativeArenaBatchStats {
  readonly docCount: number;
  readonly totalUniqueBigrams: number;
  readonly totalCompressedBytes: number;
  readonly arenaAllocatedBytes: number;
  readonly compressedDocs: ReadonlyArray<string>;
}

export interface NativeLoadedPoolInfo {
  readonly generation: number;
  readonly sourceMaxUpdatedAt: number;
  readonly vectorCount: number;
  readonly dim: number;
}

export interface NativePoolMetrics {
  readonly openScopes: number;
  readonly totalMappedBytes: number;
  readonly totalVectorsMapped: number;
  readonly totalSearches: number;
}

export interface NativeMemoryCoreAddon {
  cosineTopKF32(
    matrix: Float32Array,
    dim: number,
    query: Float32Array,
    topK: number,
  ): NativeTopKHit[];
  normalizedCosineTopKF32(
    matrix: Float32Array,
    dim: number,
    query: Float32Array,
    topK: number,
  ): NativeTopKHit[];
  quantizeF32ToI8(
    matrix: Float32Array,
    dim: number,
  ): { data: Int8Array; scales: Float32Array; vectorCount: number; dim: number };
  cosineTopKI8(
    qMatrix: Int8Array,
    scales: Float32Array,
    dim: number,
    query: Float32Array,
    topK: number,
  ): NativeTopKHit[];
  hammingBinaryDistance(a: Buffer, b: Buffer): number;
  compressAndBigramBatchArena(
    docs: string[],
    maxChars?: number | null,
    returnCompressed?: boolean | null,
  ): NativeArenaBatchStats;
  nearDuplicateMask(docs: string[], threshold?: number | null): boolean[];
  writeVectorPool(
    outPath: string,
    dim: number,
    contentKeys: string[],
    f32Matrix: Float32Array,
    generation: number,
    sourceMaxUpdatedAt: number,
  ): number;
  openVectorPool(scopeKey: string, filePath: string): NativeLoadedPoolInfo;
  searchVectorPool(
    scopeKey: string,
    query: Float32Array,
    topK: number,
    oversample?: number | null,
  ): NativeKeyedPoolHit[] | null;
  closeVectorPool(scopeKey: string): boolean;
  closeAllVectorPools(): void;
  poolMetrics(): NativePoolMetrics;
  runtimeCapabilities(): string;
}

export type NativeMemoryCoreMode = "auto" | "on" | "off";

export interface NativeMemoryCoreStatus {
  readonly mode: NativeMemoryCoreMode;
  readonly loaded: boolean;
  readonly addonPath: string | null;
  readonly capabilities: string | null;
  readonly fallbackReason: string | null;
  readonly consecutiveErrors: number;
  readonly poolMetrics: NativePoolMetrics | null;
}

const MAX_CONSECUTIVE_NATIVE_ERRORS = 3;

let cachedAddon: NativeMemoryCoreAddon | null = null;
let loadAttempted = false;
let loadedPath: string | null = null;
let fallbackReason: string | null = null;
let consecutiveErrors = 0;

function readMode(): NativeMemoryCoreMode {
  const raw = (process.env.T3_NATIVE_MEMORY_CORE ?? "auto").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return "off";
  if (raw === "on" || raw === "1" || raw === "true") return "on";
  return "auto";
}

function resolveCandidateAddonPaths(): ReadonlyArray<string> {
  const platformKey = `${process.platform}-${process.arch}`;
  const here = NodePath.dirname(NodeUrl.fileURLToPath(import.meta.url));
  const cwd = process.cwd();
  const candidates = [
    process.env.T3_NATIVE_MEMORY_CORE_PATH?.trim() || "",
    // Bundled server dist location (`apps/server/dist/native/t3-memory-core/<platform>-<arch>/t3_memory_core.node`)
    NodePath.join(here, "native", "t3-memory-core", platformKey, "t3_memory_core.node"),
    NodePath.resolve(here, "..", "native", "t3-memory-core", platformKey, "t3_memory_core.node"),
    NodePath.resolve(
      here,
      "..",
      "..",
      "..",
      "dist",
      "native",
      "t3-memory-core",
      platformKey,
      "t3_memory_core.node",
    ),
    // Development workspace location (`native/t3-memory-core/t3_memory_core.node`)
    NodePath.resolve(
      here,
      "..",
      "..",
      "..",
      "..",
      "..",
      "native",
      "t3-memory-core",
      "t3_memory_core.node",
    ),
    NodePath.resolve(
      cwd,
      "apps",
      "server",
      "dist",
      "native",
      "t3-memory-core",
      platformKey,
      "t3_memory_core.node",
    ),
    NodePath.resolve(cwd, "native", "t3-memory-core", "t3_memory_core.node"),
  ];
  return [...new Set(candidates.filter((p) => p.length > 0))];
}

/**
 * Loads the optional Rust `t3_memory_core.node` addon once with Zero-Crash fallback.
 * Returns `null` when disabled (`T3_NATIVE_MEMORY_CORE=off`), unavailable, or tripped by circuit breaker.
 */
export function getNativeMemoryCore(): NativeMemoryCoreAddon | null {
  const mode = readMode();
  if (mode === "off") {
    return null;
  }
  if (consecutiveErrors >= MAX_CONSECUTIVE_NATIVE_ERRORS) {
    return null;
  }
  if (loadAttempted) {
    return cachedAddon;
  }
  loadAttempted = true;
  const req = NodeModule.createRequire(import.meta.url);
  for (const candidate of resolveCandidateAddonPaths()) {
    if (!NodeFS.existsSync(candidate)) continue;
    try {
      const mod = req(candidate) as Partial<NativeMemoryCoreAddon>;
      if (
        typeof mod.normalizedCosineTopKF32 === "function" &&
        typeof mod.compressAndBigramBatchArena === "function" &&
        typeof mod.writeVectorPool === "function" &&
        typeof mod.searchVectorPool === "function"
      ) {
        cachedAddon = mod as NativeMemoryCoreAddon;
        loadedPath = candidate;
        fallbackReason = null;
        return cachedAddon;
      }
      fallbackReason = `missing expected N-API exports in ${candidate}`;
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
    }
  }
  if (!fallbackReason) {
    fallbackReason = "t3_memory_core.node not found (using pure JS fallback)";
  }
  return null;
}

export function resetNativeMemoryCoreForTests(): void {
  if (cachedAddon) {
    try {
      cachedAddon.closeAllVectorPools();
    } catch {
      // Ignore cleanup errors during test reset.
    }
  }
  cachedAddon = null;
  loadAttempted = false;
  loadedPath = null;
  fallbackReason = null;
  consecutiveErrors = 0;
}

export function runNativeSafe<T>(fn: (addon: NativeMemoryCoreAddon) => T): T | null {
  const addon = getNativeMemoryCore();
  if (!addon) return null;
  try {
    const result = fn(addon);
    if (result instanceof Error) {
      consecutiveErrors += 1;
      fallbackReason = result.message;
      return null;
    }
    consecutiveErrors = 0;
    return result;
  } catch (error) {
    consecutiveErrors += 1;
    fallbackReason = error instanceof Error ? error.message : String(error);
    return null;
  }
}

export function getNativeMemoryCoreStatus(): NativeMemoryCoreStatus {
  const mode = readMode();
  const addon = getNativeMemoryCore();
  return {
    mode,
    loaded: addon !== null,
    addonPath: addon ? loadedPath : null,
    capabilities: addon
      ? (() => {
          try {
            return addon.runtimeCapabilities();
          } catch {
            return null;
          }
        })()
      : null,
    fallbackReason: mode === "off" ? "disabled by T3_NATIVE_MEMORY_CORE=off" : fallbackReason,
    consecutiveErrors,
    poolMetrics: addon
      ? (() => {
          try {
            return addon.poolMetrics();
          } catch {
            return null;
          }
        })()
      : null,
  };
}
