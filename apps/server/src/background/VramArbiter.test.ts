// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSemanticIndexJobs } from "../documents/SemanticIndexJobs.ts";
import { makeSemanticSearch } from "../documents/semanticSearch.ts";
import {
  createVramArbiter,
  evictAllOllamaVram,
  vramArbiter,
  vramTrainingLeasePath,
} from "./VramArbiter.ts";

describe("VramArbiter & idle/training pause gate", () => {
  it("tracks user idle window and synchronizes TTL-bounded file leases", () => {
    const arbiter = createVramArbiter();
    const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-vram-arbiter-test-"));
    try {
      expect(arbiter.msUntilUserIdle(100_000, 30_000)).toBe(0);
      arbiter.recordUserActivity(100_000);
      expect(arbiter.msUntilUserIdle(110_000, 30_000)).toBe(20_000);
      expect(arbiter.msUntilUserIdle(130_000, 30_000)).toBe(0);

      const lease = arbiter.acquireLease({
        stateDir: tmpDir,
        owner: "seoyoon-dpo",
        reason: "Stage 3B DPO",
        ttlMs: 60_000,
        nowMs: 200_000,
      });
      expect(NodeFS.existsSync(vramTrainingLeasePath(tmpDir))).toBe(true);
      expect(arbiter.isBackgroundPaused(tmpDir, 220_000)).toBe(true);

      // A separate process/arbiter reads the same lease from disk.
      const peer = createVramArbiter();
      expect(peer.isBackgroundPaused(tmpDir, 220_000)).toBe(true);
      expect(peer.getActiveLease(tmpDir, 220_000)?.owner).toBe("seoyoon-dpo");

      // Expired lease auto-releases and cleans up stale disk file.
      expect(peer.isBackgroundPaused(tmpDir, 260_001)).toBe(false);
      expect(NodeFS.existsSync(vramTrainingLeasePath(tmpDir))).toBe(false);

      // Explicit release removes matching lease.
      const lease2 = arbiter.acquireLease({
        stateDir: tmpDir,
        owner: "seoyoon-sft",
        ttlMs: 60_000,
        nowMs: 300_000,
      });
      expect(arbiter.releaseLease({ stateDir: tmpDir, leaseId: "wrong-id" })).toBe(false);
      expect(arbiter.releaseLease({ stateDir: tmpDir, leaseId: lease2.leaseId })).toBe(true);
      expect(arbiter.isBackgroundPaused(tmpDir, 305_000)).toBe(false);
    } finally {
      NodeFS.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.live(
    "evicts all resident Ollama models via keep_alive=0 and rejects non-loopback endpoints",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ readonly url: string; readonly method: string }> = [];
        const mockClient = HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push({ url: request.url, method: request.method });
            if (request.url.endsWith("/api/ps")) {
              return HttpClientResponse.fromWeb(
                request,
                new Response(
                  `{"models":[{"name":"personal-orchestrator-4b:latest"},{"name":"bge-m3:latest"}]}`,
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              );
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(`{"done":true}`, {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        );

        const ok = yield* evictAllOllamaVram("http://127.0.0.1:11434").pipe(
          Effect.provideService(HttpClient.HttpClient, mockClient),
        );
        expect(ok.evicted).toEqual(["personal-orchestrator-4b:latest", "bge-m3:latest"]);
        expect(ok.warnings).toEqual([]);
        expect(requests).toHaveLength(3);

        const rejected = yield* evictAllOllamaVram("https://remote.example.com:11434").pipe(
          Effect.provideService(HttpClient.HttpClient, mockClient),
        );
        expect(rejected.evicted).toEqual([]);
        expect(rejected.warnings[0]).toContain("non-loopback");
      }),
  );

  it.live(
    "pauses SemanticIndexJobs while a training lease is active and resumes after release",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const sql = yield* SqlClient.SqlClient;
          const clock = yield* Clock.Clock;
          const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vram-index-" });
          vramArbiter.reset();

          yield* sql`INSERT INTO projection_workspace_rag_chunks (
          project_id, scope, applies_to_folder, item_id, chunk_index, kind, title, content, tags_text, updated_at,
          search_title, search_tags, search_body
        ) VALUES (
          'proj-vram', 'project', NULL, 'item-1', 0, 'note', 'VRAM test', 'content body', '', '2026-11-25T00:00:00Z',
          'VRAM test', '', 'content body'
        )`;

          let embedCalls = 0;
          const vectors = makeSemanticSearch({
            now: () => clock.currentTimeMillisUnsafe(),
            embed: async ({ texts }) => {
              embedCalls++;
              return texts.map(() => [1, 0, 0, 1]);
            },
          });

          const jobs = yield* makeSemanticIndexJobs({
            stateDir,
            vectors,
            enabled: () => Effect.succeed(true),
            startWorker: false,
          });
          yield* jobs.enqueue({
            projectId: "proj-vram",
            endpoint: "http://127.0.0.1:11434",
            model: "bge-m3",
          });

          // Acquire training lease -> drain pauses immediately with 0 embedding calls.
          const lease = vramArbiter.acquireLease({
            stateDir,
            owner: "test-train",
            ttlMs: 60_000,
          });
          try {
            const pausedResult = yield* jobs.drain;
            expect(pausedResult.pages).toBe(0);
            expect(embedCalls).toBe(0);
          } finally {
            vramArbiter.releaseLease({ stateDir, leaseId: lease.leaseId });
          }

          // After lease release -> drain processes the queued page normally.
          const resumedResult = yield* jobs.drain;
          expect(resumedResult.pages).toBeGreaterThanOrEqual(1);
          expect(embedCalls).toBe(1);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
  );

  it("scripts/vram-arbiter-guard.py writes a lease during wrapped execution and releases it on exit", () => {
    const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-vram-guard-py-"));
    try {
      const scriptPath = NodePath.resolve(process.cwd(), "../../scripts/vram-arbiter-guard.py");
      const leaseFile = vramTrainingLeasePath(tmpDir);
      const checkPy = `import pathlib, sys; p = pathlib.Path(sys.argv[1]); assert p.exists(), "lease missing"; print("LEASE_PRESENT")`;
      const res = NodeChildProcess.spawnSync(
        "python",
        [
          scriptPath,
          "--state-dir",
          tmpDir,
          "--owner",
          "py-guard-test",
          "--skip-ollama-evict",
          "--",
          "python",
          "-c",
          checkPy,
          leaseFile,
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("LEASE_PRESENT");
      expect(NodeFS.existsSync(leaseFile)).toBe(false);
    } finally {
      NodeFS.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
