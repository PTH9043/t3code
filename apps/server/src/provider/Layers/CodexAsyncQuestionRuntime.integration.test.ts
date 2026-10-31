// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as CodexSchema from "effect-codex-app-server/schema";
import { expect } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const isServerRequestResolved = Schema.is(CodexSchema.V2ServerRequestResolvedNotification);

it.live(
  "interrupts the provider and emits a valid resolution for the selected async question",
  () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-question-stop-"));
      const launcher = NodePath.join(directory, "app-server");
      const scriptPath = NodePath.join(directory, "script.json");
      const peer = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.mjs");
      NodeFS.writeFileSync(
        launcher,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `import(${JSON.stringify(NodeURL.pathToFileURL(peer).href)});`,
      );
      NodeFS.writeFileSync(
        scriptPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          rootThreadId: wireFixture.rootThreadId,
          holdTurnOpen: true,
          notifications: [
            {
              method: "item/completed",
              params: {
                completedAtMs: 1,
                threadId: wireFixture.rootThreadId,
                turnId: wireFixture.responses.turnStart.turn.id,
                item: {
                  type: "agentMessage",
                  id: "question-item",
                  text: "Choose a directory",
                  delivery: "async",
                  questions: [{ title: "Choose a directory" }],
                },
              },
            },
          ],
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const file of [launcher, scriptPath, `${scriptPath}.interrupts`]) {
            NodeFS.rmSync(file, { force: true });
          }
          NodeFS.rmdirSync(directory);
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("question-stop-thread"),
        binaryPath: process.execPath,
        cwd: directory,
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const requested = yield* Deferred.make<void>();
      const resolved = yield* Deferred.make<unknown>();
      const orphanedResolved = yield* Deferred.make<unknown>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          if (event.method === "item/tool/requestUserInput")
            return Deferred.succeed(requested, undefined);
          if (event.method === "serverRequest/resolved") {
            return event.requestId === "async:orphaned"
              ? Deferred.succeed(orphanedResolved, event)
              : Deferred.succeed(resolved, event);
          }
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Ask a question" });
      yield* Deferred.await(requested);
      const questionRequestId = ApprovalRequestId.make("async:question-item");
      yield* runtime.interruptTurn(undefined, questionRequestId);
      const event = yield* Deferred.await(resolved);
      expect(event).toMatchObject({ requestId: questionRequestId });
      const payload = (event as { payload: unknown }).payload;
      expect(isServerRequestResolved(payload)).toBe(true);
      expect(payload).toMatchObject({
        threadId: wireFixture.rootThreadId,
        requestId: questionRequestId,
        t3UserInputResolved: "closed",
      });
      const interrupts = NodeFS.readFileSync(`${scriptPath}.interrupts`, "utf8");
      expect(interrupts).toContain(wireFixture.rootThreadId);
      yield* runtime.interruptTurn(undefined, ApprovalRequestId.make("async:orphaned"));
      const orphanedEvent = yield* Deferred.await(orphanedResolved);
      expect(orphanedEvent).toMatchObject({
        requestId: "async:orphaned",
        payload: { threadId: wireFixture.rootThreadId, t3UserInputResolved: "closed" },
      });
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "closes the selected async question even when the provider rejects the turn interrupt",
  () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-question-stop-"));
      const launcher = NodePath.join(directory, "app-server");
      const scriptPath = NodePath.join(directory, "script.json");
      const peer = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.mjs");
      NodeFS.writeFileSync(
        launcher,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `import(${JSON.stringify(NodeURL.pathToFileURL(peer).href)});`,
      );
      NodeFS.writeFileSync(
        scriptPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          rootThreadId: wireFixture.rootThreadId,
          holdTurnOpen: true,
          failInterruptFor: wireFixture.rootThreadId,
          notifications: [
            {
              method: "item/completed",
              params: {
                completedAtMs: 1,
                threadId: wireFixture.rootThreadId,
                turnId: wireFixture.responses.turnStart.turn.id,
                item: {
                  type: "agentMessage",
                  id: "question-item",
                  text: "Choose a directory",
                  delivery: "async",
                  questions: [{ title: "Choose a directory" }],
                },
              },
            },
          ],
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const file of [launcher, scriptPath, `${scriptPath}.interrupts`]) {
            NodeFS.rmSync(file, { force: true });
          }
          NodeFS.rmdirSync(directory);
        }),
      );
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("question-stop-rejected-thread"),
        binaryPath: process.execPath,
        cwd: directory,
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const requested = yield* Deferred.make<void>();
      const resolved = yield* Deferred.make<unknown>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          if (event.method === "item/tool/requestUserInput")
            return Deferred.succeed(requested, undefined);
          if (event.method === "serverRequest/resolved") return Deferred.succeed(resolved, event);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Ask a question" });
      yield* Deferred.await(requested);
      const result = yield* Effect.exit(
        runtime.interruptTurn(undefined, ApprovalRequestId.make("async:question-item")),
      );
      expect(result._tag).toBe("Failure");
      const closed = yield* Deferred.poll(resolved);
      expect(Option.isSome(closed)).toBe(true);
      if (Option.isSome(closed)) {
        expect(yield* closed.value).toMatchObject({
          requestId: "async:question-item",
          payload: { t3UserInputResolved: "closed" },
        });
      }
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
