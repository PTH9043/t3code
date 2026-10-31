/**
 * Optional integration check against a real `grok agent stdio` install.
 * Enable with: T3_GROK_ACP_PROBE=1 bun run test GrokAcpCliProbe
 *
 * The probe assumes either `XAI_API_KEY` is set in the environment or
 * the user has previously run `grok login`. Without credentials the
 * agent's `authenticate` request will fail and the test will surface
 * the error.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Deferred, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeGrokAcpRuntime } from "./GrokAcpSupport.ts";
import { grokTokenConsumption } from "./GrokTokenUsage.ts";
import { makeGrokTokenUsageTracker } from "./GrokTokenUsage.ts";
import { TurnId, type TokenUsageObservation } from "@t3tools/contracts";
import * as ProcessRunner from "../../processRunner.ts";

const encodeProof = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeGrokAcpRuntime({
    grokSettings: { binaryPath: process.env.T3_GROK_BINARY ?? "grok" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.env.T3_GROK_PROBE_CWD ?? process.cwd(),
    clientInfo: { name: "t3-grok-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_GROK_FULL_PROBE === "1")("Grok managed MCP and export probe", () => {
  it.effect(
    "reads an isolated file over MCP, receives real usage, resumes and exports the owned session",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = process.env.T3_GROK_PROBE_CWD!;
        const binary = process.env.T3_GROK_BINARY!;
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const file = path.join(cwd, "probe-note.txt");
        yield* fs.writeFileString(file, "T3_MCP_UPGRADE_OK");
        const mcpServers = [
          {
            name: "t3-filesystem",
            command: process.execPath,
            args: [
              path.resolve(
                ".t3/tools/mcp/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js",
              ),
              cwd,
            ],
            env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
          },
        ];
        const observe = makeGrokTokenUsageTracker();
        const usageReceived = yield* Deferred.make<TokenUsageObservation[]>();
        const runtime = yield* makeGrokAcpRuntime({
          childProcessSpawner,
          grokSettings: { binaryPath: binary },
          environment: process.env,
          cwd,
          mcpServers,
          clientInfo: { name: "t3-upgrade-read-only-probe", version: "1" },
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event) =>
              Effect.forEach(observe(event, TurnId.make("probe")), (item) =>
                Deferred.succeed(usageReceived, item.consumption),
              ).pipe(Effect.asVoid),
          },
        });
        yield* runtime.handleExtNotification(
          "_x.ai/session/update",
          Schema.Unknown,
          (notification) =>
            Effect.forEach(observe.completion(notification), (item) =>
              Deferred.succeed(usageReceived, item.consumption),
            ).pipe(Effect.asVoid),
        );
        yield* runtime.handleRequestPermission((params) => {
          const option = params.options.find((item) => item.kind === "allow_once");
          return Effect.succeed({
            outcome: option
              ? { outcome: "selected" as const, optionId: option.optionId }
              : { outcome: "cancelled" as const },
          });
        });
        let text = "";
        let toolCalls = 0;
        yield* Stream.runForEach(runtime.getEvents(), (event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined)
            : Effect.sync(() => {
                if (event._tag === "ContentDelta") text += event.text;
                if (event._tag === "ToolCallUpdated") toolCalls++;
              }),
        ).pipe(Effect.forkScoped);
        const started = yield* runtime.start();
        const result = yield* runtime.prompt({
          prompt: [
            {
              type: "text",
              text: `Use the t3-filesystem MCP server (search_tool/use_tool if needed) to read this exact file: ${file}. Report its contents verbatim in one line. Do not edit files or use shell commands.`,
            },
          ],
        });
        yield* runtime.drainEvents;
        expect(result.stopReason).toBe("end_turn");
        expect(text).toContain("T3_MCP_UPGRADE_OK");
        expect(toolCalls).toBeGreaterThan(0);
        const usage = grokTokenConsumption(result).length
          ? grokTokenConsumption(result)
          : yield* Deferred.await(usageReceived).pipe(Effect.timeout("30 seconds"));
        expect(usage.length).toBeGreaterThan(0);
        const resumed = yield* makeGrokAcpRuntime({
          childProcessSpawner,
          grokSettings: { binaryPath: binary },
          environment: process.env,
          cwd,
          resumeSessionId: started.sessionId,
          mcpServers,
          clientInfo: { name: "t3-upgrade-resume-probe", version: "1" },
        });
        expect((yield* resumed.start()).sessionId).toBe(started.sessionId);
        const runner = yield* ProcessRunner.make();
        const exported = yield* runner.run({
          command: binary,
          args: ["--no-auto-update", "export", started.sessionId],
          cwd,
          stdin: "",
          timeout: "30 seconds",
          maxOutputBytes: 1_000_000,
        });
        expect(exported.code).toBe(0);
        expect(exported.stdout).toContain("T3_MCP_UPGRADE_OK");
        yield* fs.writeFileString(path.resolve(".t3/grok-native-export.md"), exported.stdout);
        const proof = yield* encodeProof({
          sessionId: started.sessionId,
          stopReason: result.stopReason,
          mcpToolEvents: toolCalls,
          text,
          usage,
          resumed: true,
          exported: true,
        });
        yield* fs.writeFileString(path.resolve(".t3/grok-native-proof.json"), proof);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 180_000 },
  );
});

describe.runIf(process.env.T3_GROK_ACP_PROBE === "1")("Grok ACP CLI probe", () => {
  it.effect("initialize and authenticate against real grok agent stdio", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises typed SessionModelState with at least one model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;

      expect(typeof started.sessionId).toBe("string");

      // Modern grok-shell advertises models through the typed
      // `SessionModelState` field, not via a `configOptions` entry.
      // If this assertion fails the upstream surface has regressed.
      const models = result.models;
      expect(models).toBeDefined();
      expect(typeof models?.currentModelId).toBe("string");
      expect(models?.availableModels.length ?? 0).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_model accepts a no-op switch to the current model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModelId = started.sessionSetupResult.models?.currentModelId?.trim();
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      // No-op switch — selecting the model the session already runs on must
      // succeed against every Grok build that implements `session/set_model`.
      yield* runtime.setSessionModel(currentModelId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
