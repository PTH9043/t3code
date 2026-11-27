import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ServerConfig } from "../config.ts";
import { upgradeRoomIds } from "../upgradeRoom.ts";
import type { UpgradeRoomKnowledge } from "./upgradeRoomKnowledge.ts";

export const UpgradeRoomMemory = Context.Reference<UpgradeRoomKnowledge | undefined>(
  "t3/UpgradeRoomMemory",
  {
    defaultValue: () => undefined,
  },
);

export const layer = Layer.effect(
  UpgradeRoomMemory,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (!config.upgradeRoom) return undefined;
    const { installUpgradeRoomKnowledge } = yield* Effect.promise(
      () => import("./upgradeRoomKnowledge.ts"),
    );
    return installUpgradeRoomKnowledge({
      role: "room",
      ...upgradeRoomIds,
      dbPath: config.dbPath,
      env: {
        T3CODE_UPGRADE_PROJECT_ROOT: config.upgradeRoom.projectRoot,
        T3CODE_UPGRADE_PRIMARY_HOME: config.upgradeRoom.primaryHome,
      },
    });
  }),
);

export function capturesRoomEvent(event: OrchestrationEvent) {
  if ("threadId" in event.payload && event.payload.threadId === upgradeRoomIds.threadId) {
    switch (event.type) {
      case "thread.message-sent":
        return !event.payload.streaming;
      case "thread.session-set":
        return (
          event.payload.session.status === "ready" || event.payload.session.status === "stopped"
        );
      case "thread.created":
      case "thread.deleted":
      case "thread.archived":
      case "thread.reverted":
      case "thread.user-input-response-requested":
      case "thread.turn-diff-completed":
        return true;
    }
  }
  return (
    "projectId" in event.payload &&
    event.payload.projectId === upgradeRoomIds.projectId &&
    (event.type.startsWith("project.knowledge-") ||
      event.type === "project.workspace-control-updated" ||
      event.type === "project.deleted")
  );
}

export const captureRoomMemory = (memory: UpgradeRoomKnowledge) =>
  Effect.tryPromise(async () => memory.capture()).pipe(
    Effect.retry({
      while: ({ cause }) =>
        typeof cause === "object" &&
        cause !== null &&
        "errcode" in cause &&
        typeof cause.errcode === "number" &&
        [5, 6].includes(cause.errcode & 0xff),
      schedule: Schedule.spaced("1 second"),
      times: 1,
    }),
    Effect.catch(() => Effect.logWarning("Upgrade room memory capture pending.")),
    Effect.asVoid,
  );
