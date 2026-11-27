import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviders,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { capturesRoomEvent } from "./orchestration/UpgradeRoomMemory.ts";
import { account } from "./provider/testUtils/providerAccountFixture.ts";
import {
  materializeUpgradeInstance,
  readUpgradeInstances,
  readUpgradeProviders,
} from "./provider/upgradeCatalog.ts";
import { providerEnvironmentSecretName } from "./serverSettings.ts";
import {
  resolveUpgradeRoom,
  upgradeModelAvailable,
  upgradeRoomAllowsRpc,
  upgradeRoomAllowsCommand,
  upgradeRoomIds,
} from "./upgradeRoom.ts";
import { protectWindowsCredential } from "./auth/WindowsCredentialProtection.ts";

const encodeProviders = Schema.encodeEffect(ServerProviders);
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

describe("dedicated upgrade room", () => {
  const root = "D:/__NewAutoUsage";
  const primary = "E:/NewAutoUsage";
  const home = primary + "/upgrade-room";
  it("requires the launcher's exact pair and a distinct explicit home", () => {
    expect(resolveUpgradeRoom(undefined, undefined, primary, false)).toBeUndefined();
    expect(resolveUpgradeRoom(root, primary, home, true)?.projectRoot).toBe(root);
    for (const [r, p, h] of [
      [root, undefined, home],
      [undefined, primary, home],
      [root, primary, primary],
      ["D:/other", primary, home],
      [root, "E:/other", home],
      [root, primary, home + "/../userdata"],
    ]) {
      expect(() => resolveUpgradeRoom(r, p, h!, true)).toThrow();
    }
  });
  it("allows normal tools and user approval modes only in the dedicated project and room", () => {
    const id = CommandId.make("request");
    expect(
      upgradeRoomAllowsCommand({
        type: "thread.runtime-mode.set",
        commandId: id,
        threadId: upgradeRoomIds.threadId,
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe(true);
    expect(
      upgradeRoomAllowsRpc(WS_METHODS.projectsWriteFile, { cwd: root, path: "test.ts" }, root),
    ).toBe(true);
    expect(upgradeRoomAllowsRpc(WS_METHODS.projectsReadFile, { cwd: "D:/other" }, root)).toBe(
      false,
    );
    expect(
      upgradeRoomAllowsRpc(
        WS_METHODS.terminalAttach,
        { threadId: ThreadId.make("other"), cwd: root },
        root,
      ),
    ).toBe(false);
    expect(upgradeRoomAllowsRpc(WS_METHODS.serverUpdateSettings, {}, root)).toBe(false);
    expect(
      upgradeRoomAllowsCommand({
        type: "thread.archive",
        commandId: id,
        threadId: upgradeRoomIds.threadId,
      }),
    ).toBe(false);
  });
  it("indexes a settled message once its streaming flag clears", () => {
    const threadId = upgradeRoomIds.threadId;
    const now = "2026-01-01T00:00:00Z";
    const event = {
      type: "thread.message-sent" as const,
      sequence: 1,
      eventId: EventId.make("event"),
      aggregateKind: "thread" as const,
      aggregateId: threadId,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        messageId: MessageId.make("message"),
        role: "assistant" as const,
        text: "token",
        turnId: null,
        streaming: true,
        createdAt: now,
        updatedAt: now,
      },
    };
    expect(capturesRoomEvent(event)).toBe(false);
    expect(capturesRoomEvent({ ...event, payload: { ...event.payload, streaming: false } })).toBe(
      true,
    );
    expect(
      capturesRoomEvent({
        ...event,
        payload: { ...event.payload, threadId: ThreadId.make("foreign"), streaming: false },
      }),
    ).toBe(false);
  });
  it.live(
    "reads account-specific inventory from a stopped primary and never writes settings or credentials",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { join } = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-upgrade-catalog-" });
          const secrets = join(dir, "userdata", "secrets");
          yield* fs.makeDirectory(secrets, { recursive: true });
          yield* fs.makeDirectory(join(dir, "caches"));
          const id = ProviderInstanceId.make("my_api");
          const secretName = providerEnvironmentSecretName({
            instanceId: id,
            name: "T3_OPENCODE_API_KEY",
          });
          const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
          const raw = yield* encode({
            providerInstances: {
              [id]: {
                driver: "opencode",
                enabled: true,
                environment: [
                  { name: "T3_OPENCODE_API_KEY", value: "", sensitive: true, valueRedacted: true },
                ],
                config: {
                  apiConnection: {
                    providerId: "registered",
                    baseUrl: "https://fixture.invalid",
                    protocol: "responses",
                    models: ["chosen"],
                  },
                },
              },
            },
            threadCharacters: { unrelated: "ignored" },
          });
          yield* fs.writeFileString(join(dir, "userdata", "settings.json"), raw);
          yield* fs.writeFileString(
            join(dir, "caches", id + ".json"),
            yield* encode(account(id, { driver: ProviderDriverKind.make("opencode") })),
          );
          yield* fs.writeFileString(
            join(dir, "caches", "removed.json"),
            yield* encode(account("removed")),
          );
          const inventory = yield* readUpgradeProviders(dir);
          expect(inventory.map((p) => p.instanceId)).toEqual([id]);
          // The RPC transport cannot serialize properties present with undefined values.
          const wire = yield* encodeProviders(inventory);
          expect(yield* decodeJson(wire)).toEqual(wire);
          expect(
            upgradeModelAvailable({ instanceId: id, model: "registered/chosen" }, inventory),
          ).toBe(true);
          expect(
            upgradeModelAvailable({ instanceId: id, model: "selected-model" }, inventory),
          ).toBe(false);
          const entry = (yield* readUpgradeInstances(dir))[id]!;
          expect(yield* Effect.isFailure(materializeUpgradeInstance(dir, id, entry))).toBe(true);
          expect(yield* fs.readDirectory(secrets)).toEqual([]);
          if ((yield* HostProcessPlatform) === "win32") {
            const encrypted = Buffer.from(
              protectWindowsCredential(secretName, new TextEncoder().encode("fixture")),
            );
            const file = join(secrets, secretName + ".bin");
            yield* fs.writeFile(file, encrypted);
            expect((yield* materializeUpgradeInstance(dir, id, entry)).environment[0]?.value).toBe(
              "fixture",
            );
            expect(Buffer.from(yield* fs.readFile(file))).toEqual(encrypted);
          }
          expect(yield* fs.readFileString(join(dir, "userdata", "settings.json"))).toBe(raw);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
