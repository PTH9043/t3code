// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { spawnSync } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, describe } from "@effect/vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeWorkspaceDelegationStore } from "../persistence/WorkspaceDelegations.ts";
import {
  computeProviderRefreshIntervalMs,
  MIN_DEFAULT_PERIODIC_REFRESH_INTERVAL_MS,
} from "../provider/makeManagedServerProvider.ts";
import { activeWorkRegistry } from "../orchestration/ActiveWorkTracker.ts";
import { createMemoryWatchdogController } from "./MemoryWatchdog.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

describe("Phase 0~4 안정화 · 백그라운드 최적화 검증", () => {
  it("Phase 0-3: Migration 115 적용 후 workspace_delegations에 status='limit_exceeded' 저장 성공", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeWorkspaceDelegationStore(sql);
      const now = new Date().toISOString();

      yield* store.insert({
        delegationId: "del_limit_check_1",
        threadId: "thread_check_1",
        ownerTurnId: "turn_check_1",
        answeringInstanceId: "claude",
        role: "scout",
        targetInstanceId: "grok",
        targetModel: "grok-4.7",
        taskText: "시간 초과 상태 저장 테스트",
        taskHash: "hash_limit_1",
        startedAt: now,
      });

      yield* store.settle({
        delegationId: "del_limit_check_1",
        status: "limit_exceeded",
        resultText: "부분 출력 보존 테스트",
        errorMessage: "시간 초과 실패",
        finishedAt: now,
      });

      const saved = yield* store.getById("del_limit_check_1");
      expect(saved).not.toBeNull();
      expect(saved?.status).toBe("limit_exceeded");
      expect(saved?.resultText).toBe("부분 출력 보존 테스트");
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.provide(NodeServices.layer)));

  it("Phase 0-2: archive-event-logs.mjs --apply는 라이브 서버 PID 감지 시 fail-closed(exit 2)로 거부", () => {
    const tmpDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-archive-guard-"));
    try {
      const fakeDb = NodePath.join(tmpDir, "state.sqlite");
      NodeFs.writeFileSync(fakeDb, "", "utf8");
      // Write current test process PID as active backend PID
      NodeFs.writeFileSync(
        NodePath.join(tmpDir, "active-work.json"),
        JSON.stringify({ pid: process.pid, totalActive: 0 }),
        "utf8",
      );

      const scriptPath = NodePath.resolve(process.cwd(), "../../scripts/archive-event-logs.mjs");
      const res = spawnSync(
        process.execPath,
        [
          scriptPath,
          "--hot-db",
          fakeDb,
          "--archive-dir",
          NodePath.join(tmpDir, "archives"),
          "--apply",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      expect(res.status).toBe(2);
      expect((res.stderr || "") + (res.stdout || "")).toContain("REFUSED");
    } finally {
      NodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Phase 1-1: ServerSecretStore 인메모리 캐시가 반복 조회 시 디스크 재읽기 제거 및 remove/set 무효화 보장", () =>
    Effect.gen(function* () {
      const tmpDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-secret-cache-"));
      try {
        let readCalls = 0;
        const baseFs = yield* FileSystem.FileSystem;
        const countingFs: FileSystem.FileSystem = {
          ...baseFs,
          readFile: (p: string) => {
            readCalls += 1;
            return baseFs.readFile(p);
          },
        };
        const cfgLayer = ServerConfig.ServerConfig.layerTest(tmpDir, { prefix: "t3-sec-" });
        const storeLayer = ServerSecretStore.layer.pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, countingFs)),
          Layer.provide(cfgLayer),
          Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const store = yield* ServerSecretStore.ServerSecretStore;
          const k1 = yield* store.getOrCreateRandom("asset-access-signing-key", 32);
          const readsAfterFirst = readCalls;
          // 50 repeated reads must hit in-memory cache with zero additional disk reads
          for (let i = 0; i < 50; i += 1) {
            const next = yield* store.getOrCreateRandom("asset-access-signing-key", 32);
            expect(Buffer.from(next).equals(Buffer.from(k1))).toBe(true);
          }
          expect(readCalls).toBe(readsAfterFirst);

          // Mutation invalidates/updates cache immediately
          const replacement = Uint8Array.from({ length: 32 }, (_, idx) => idx + 1);
          yield* store.set("asset-access-signing-key", replacement);
          const afterSet = yield* store.get("asset-access-signing-key");
          expect(Option.isSome(afterSet)).toBe(true);
          expect(
            Buffer.from(afterSet.pipe(Option.getOrThrow)).equals(Buffer.from(replacement)),
          ).toBe(true);

          yield* store.remove("asset-access-signing-key");
          const afterRemove = yield* store.get("asset-access-signing-key");
          expect(Option.isNone(afterRemove)).toBe(true);
        }).pipe(Effect.provide(storeLayer));
      } finally {
        NodeFs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)));

  it("Phase 2-1: MemoryWatchdog 텔레메트리 수집 및 임계치 초과 시 힙 스냅샷 없이 기본 정상 동작 확인", () =>
    Effect.gen(function* () {
      const tmpDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-mem-watchdog-"));
      try {
        const controller = createMemoryWatchdogController({
          stateDir: tmpDir,
          logsDir: NodePath.join(tmpDir, "logs"),
          dbPath: NodePath.join(tmpDir, "nonexistent.sqlite"),
          warnHeapMB: 99_999,
          snapshotHeapMB: 99_999,
          enableIdleArchive: false,
          getProviderSessionCount: () => Effect.succeed(3),
          getDirectoryBindingCount: () => Effect.succeed(5),
        });
        const { sample, snapshotPath } = yield* controller.tickOnce;
        expect(sample.rssMB).toBeGreaterThan(0);
        expect(sample.heapUsedMB).toBeGreaterThan(0);
        expect(sample.providerSessions).toBe(3);
        expect(sample.directoryBindings).toBe(5);
        expect(snapshotPath).toBeNull();
      } finally {
        NodeFs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }));

  it("Phase 3: 제공자 폴링 최소 하한(3분) 및 연속 실패 백오프(3x -> 6x -> 10x, 최대 30분)", () => {
    expect(MIN_DEFAULT_PERIODIC_REFRESH_INTERVAL_MS).toBe(180_000);
    expect(computeProviderRefreshIntervalMs(180_000, 0)).toBe(180_000);
    expect(computeProviderRefreshIntervalMs(180_000, 1)).toBe(540_000);
    expect(computeProviderRefreshIntervalMs(180_000, 2)).toBe(1_080_000);
    expect(computeProviderRefreshIntervalMs(180_000, 3)).toBe(1_800_000);
    expect(computeProviderRefreshIntervalMs(180_000, 10)).toBe(1_800_000);
    // ActiveWorkRegistry snapshot sanity
    expect(activeWorkRegistry.snapshot().totalActive).toBeGreaterThanOrEqual(0);
  });
});
