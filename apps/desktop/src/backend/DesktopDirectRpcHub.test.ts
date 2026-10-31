// @effect-diagnostics preferSchemaOverJson:off -- These tests inspect the wire frames.
import type { DesktopDirectRpcOutput } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { make } from "./DesktopDirectRpcHub.ts";

it.effect("keeps direct clients isolated by owner and closes them when the backend ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hub = yield* make;
      const backendScope = yield* Scope.make();
      const attachment = yield* Scope.provide(hub.attach, backendScope);
      const frames = yield* Queue.unbounded<string>();
      yield* attachment.encoded.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Queue.offer(frames, line).pipe(Effect.asVoid)),
        Effect.forkScoped,
      );
      const ownerOne: DesktopDirectRpcOutput[] = [];
      const ownerTwo: DesktopDirectRpcOutput[] = [];
      const first = yield* hub.open(11, (frame) => ownerOne.push(frame), "primary", "test-bearer");
      const second = yield* hub.open(22, (frame) => ownerTwo.push(frame));
      expect(JSON.parse(yield* Queue.take(frames))).toEqual({
        type: "open",
        clientId: first,
        bearerToken: "test-bearer",
      });
      expect(JSON.parse(yield* Queue.take(frames))).toEqual({ type: "open", clientId: second });
      yield* attachment.receive({ type: "opened", clientId: first });
      expect(ownerOne).toEqual([{ type: "opened", clientId: first }]);
      expect(ownerTwo).toEqual([]);
      yield* Effect.flip(hub.send(22, first, "wrong owner"));
      yield* hub.send(11, first, "안녕하세요");
      expect(JSON.parse(yield* Queue.take(frames))).toEqual({
        type: "data",
        clientId: first,
        data: "안녕하세요",
      });
      yield* hub.closeOwner(22);
      expect(JSON.parse(yield* Queue.take(frames))).toEqual({ type: "close", clientId: second });
      expect(ownerTwo).toEqual([{ type: "closed", clientId: second }]);
      yield* Scope.close(backendScope, Exit.void);
      expect(ownerOne.at(-1)).toEqual({ type: "closed", clientId: first });
      yield* Effect.flip(hub.open(11, () => {}));
      const next = yield* hub.attach;
      const nextId = yield* hub.open(11, () => {});
      expect(nextId).not.toBe(first);
      yield* next.close;
    }),
  ),
);

it.effect("keeps Windows and WSL direct connections independent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hub = yield* make;
      const windows = yield* hub.attach;
      const wslScope = yield* Scope.make();
      const wsl = yield* Scope.provide(hub.attachBackend("wsl:Ubuntu"), wslScope);
      const windowsFrames = yield* Queue.unbounded<string>();
      const wslFrames = yield* Queue.unbounded<string>();
      yield* windows.encoded.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Queue.offer(windowsFrames, line).pipe(Effect.asVoid)),
        Effect.forkScoped,
      );
      yield* wsl.encoded.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Queue.offer(wslFrames, line).pipe(Effect.asVoid)),
        Effect.forkScoped,
      );
      const windowsOutput: DesktopDirectRpcOutput[] = [];
      const wslOutput: DesktopDirectRpcOutput[] = [];
      const windowsId = yield* hub.open(11, (frame) => windowsOutput.push(frame));
      const wslId = yield* hub.open(11, (frame) => wslOutput.push(frame), "wsl:Ubuntu");
      expect(windowsId).not.toBe(wslId);
      expect(JSON.parse(yield* Queue.take(windowsFrames))).toEqual({
        type: "open",
        clientId: windowsId,
      });
      expect(JSON.parse(yield* Queue.take(wslFrames))).toEqual({ type: "open", clientId: wslId });
      yield* wsl.receive({ type: "opened", clientId: windowsId });
      expect(windowsOutput).toEqual([]);
      yield* wsl.receive({ type: "opened", clientId: wslId });
      expect(wslOutput).toEqual([{ type: "opened", clientId: wslId }]);
      yield* Scope.close(wslScope, Exit.void);
      expect(wslOutput.at(-1)).toEqual({ type: "closed", clientId: wslId });
      yield* hub.send(11, windowsId, "still running");
      expect(JSON.parse(yield* Queue.take(windowsFrames))).toEqual({
        type: "data",
        clientId: windowsId,
        data: "still running",
      });
      expect(windowsOutput).toEqual([]);
    }),
  ),
);
