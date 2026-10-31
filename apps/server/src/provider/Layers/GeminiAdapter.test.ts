// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GeminiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { writeMockLauncher } from "../acp/mockLauncher.test-support.ts";
import { makeGeminiAdapter } from "./GeminiAdapter.ts";

const encodeString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const encodeUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeUnknownEffect(GeminiSettings);

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-gemini-history-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("GeminiAdapter history lifecycle", (it) => {
  for (const failPrompt of [false, true]) {
    it.effect(
      `keeps events and disk history after the startup caller exits (failure=${failPrompt})`,
      () =>
        Effect.gen(function* () {
          const directory = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-acp-mock-")),
          );
          const mock = new URL("../../../scripts/acp-mock-agent.ts", import.meta.url);
          const mockUrl = yield* encodeString(mock.href);
          const binaryPath = yield* writeMockLauncher(
            NodePath.join(directory, "fake-gemini.mjs"),
            `${failPrompt ? 'process.env.T3_ACP_FAIL_PROMPT="1";' : ""}\nawait import(${mockUrl});`,
          );
          const settings = yield* decodeSettings({ binaryPath });
          const adapter = yield* makeGeminiAdapter(settings);
          const threadId = ThreadId.make(`gemini-history-${failPrompt}`);
          const starting = yield* adapter
            .startSession({
              threadId,
              provider: ProviderDriverKind.make("gemini"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: {
                instanceId: ProviderInstanceId.make("gemini"),
                model: "grok-build",
              },
            })
            .pipe(Effect.forkChild);
          yield* Fiber.join(starting);
          const events = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
          const sent = yield* adapter
            .sendTurn({ threadId, input: "한글 원문\nGemini history", attachments: [] })
            .pipe(Effect.result);
          const completed = yield* Fiber.join(events);
          const terminal = completed.find((event) => event.type === "turn.completed");
          assert.equal(terminal?.payload.state, failPrompt ? "failed" : "completed");
          if (!failPrompt) assert.isTrue(completed.some((event) => event.type === "content.delta"));
          assert.equal(sent._tag, failPrompt ? "Failure" : "Success");
          const snapshot = yield* adapter.readThread(threadId);
          assert.equal(snapshot.turns.length, failPrompt ? 0 : 1);
          if (!failPrompt) {
            const raw = yield* encodeUnknown(snapshot.turns[0]?.items);
            assert.include(raw, "한글 원문");
          }
          yield* adapter.stopSession(threadId);
          assert.isEmpty(yield* adapter.listSessions());
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }),
    );
  }
});
