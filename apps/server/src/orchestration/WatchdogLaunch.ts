// @effect-diagnostics nodeBuiltinImport:off - A detached worker receives a capability only over IPC.
import { randomBytes } from "node:crypto";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import type { ServerConfig } from "../config.ts";
import {
  issueActiveWatchdogMcpCredential,
  revokeActiveMcpThread,
  type McpCredentialRequest,
  type McpIssuedCredential,
} from "../mcp/McpSessionRegistry.ts";
import {
  WATCHDOG_PROJECTION_CONSUMER,
  type UpgradeRoomJobRecord,
  type WatchdogJournal,
} from "./WatchdogJournal.ts";
import { launchDetachedWatchdog, type WatchdogProcessLaunchResult } from "./WatchdogProcess.ts";
import {
  encodeWatchdogWorkerPayload,
  type WatchdogWorkerPayload,
} from "./WatchdogWorkerProtocol.ts";

type LaunchPayload = Omit<
  WatchdogWorkerPayload,
  "capability" | "serverConfig" | "mcp" | "journalPath"
> & {
  readonly serverConfig: ServerConfig["Service"];
};

interface LaunchDependencies {
  readonly issue: (input: {
    readonly request: McpCredentialRequest & {
      readonly ownerThreadId: LaunchPayload["execution"]["ownerThreadId"];
    };
    readonly journal: WatchdogJournal;
    readonly jobId: string;
    readonly capability: string;
  }) => Effect.Effect<McpIssuedCredential | undefined>;
  readonly revoke: typeof revokeActiveMcpThread;
  readonly spawn: typeof launchDetachedWatchdog;
}

const defaults: LaunchDependencies = {
  issue: issueActiveWatchdogMcpCredential,
  revoke: revokeActiveMcpThread,
  spawn: launchDetachedWatchdog,
};

/** An uncertain launch is never repeated: the journal and a fresh worker proof decide recovery. */
export const launchWatchdogExecution = Effect.fn("launchWatchdogExecution")(function* (
  input: LaunchPayload & {
    readonly journal: WatchdogJournal;
    readonly jobId: string;
    readonly entry: string;
    readonly signal: AbortSignal;
    readonly beforeSpawn?: Effect.Effect<void, never>;
    readonly dependencies?: LaunchDependencies;
    /** Start the worker outside the backend's process tree (default false). */
    readonly separateProcessTree?: boolean;
    readonly upgradeRoomJob?: Omit<UpgradeRoomJobRecord, "jobId">;
  },
) {
  const dependencies = input.dependencies ?? defaults;
  const journalPath = NodePath.resolve(input.serverConfig.stateDir, "watchdog-journal.sqlite");
  if (input.journal.filename !== journalPath)
    throw new Error("Watchdog journal does not belong to this environment.");
  if (input.signal.aborted) return { status: "not-started" as const };
  const capability = randomBytes(32).toString("base64url");
  const {
    journal,
    jobId,
    entry,
    signal,
    beforeSpawn,
    dependencies: _dependencies,
    separateProcessTree,
    upgradeRoomJob,
    ...body
  } = input;
  // Validate and reduce settings before creating the durable execution.
  encodeWatchdogWorkerPayload({ ...body, journalPath, capability });
  const created = journal.create({
    id: jobId,
    executionId: body.execution.executionId,
    threadId: body.execution.ownerThreadId,
    capability,
    requireSettledConsumer: WATCHDOG_PROJECTION_CONSUMER,
    ...(upgradeRoomJob ? { upgradeRoom: upgradeRoomJob } : {}),
    context: {
      runId: body.execution.runId,
      nodeId: body.execution.nodeId,
      attempt: body.execution.attempt,
      provider: body.instance.driver,
      providerInstanceId: body.providerInstanceId,
    },
  });
  if (!created) return { status: "unsettled" as const };
  const credential = yield* dependencies.issue({
    journal,
    jobId,
    capability,
    request: {
      threadId: body.start.threadId,
      ownerThreadId: body.execution.ownerThreadId,
      providerInstanceId: body.providerInstanceId,
      runtimeMode: body.start.runtimeMode,
      interactionMode: body.turn.interactionMode,
      ...(body.start.cwd === undefined ? {} : { executionCwd: body.start.cwd }),
    },
  });
  if (!credential) {
    journal.requestCancel(jobId);
    journal.seal(jobId, capability);
    return { status: "not-started" as const };
  }
  const encoded = yield* Effect.try({
    try: () =>
      encodeWatchdogWorkerPayload({ ...body, journalPath, capability, mcp: credential.config }),
    catch: () => ({ _tag: "InvalidWatchdogCredential" as const }),
  }).pipe(Effect.result);
  if (encoded._tag === "Failure") {
    journal.requestCancel(jobId);
    journal.seal(jobId, capability);
    yield* dependencies.revoke(body.start.threadId);
    return { status: "not-started" as const };
  }
  const prepared = yield* Effect.exit(beforeSpawn ?? Effect.void);
  if (prepared._tag === "Failure") {
    journal.requestCancel(jobId);
    journal.seal(jobId, capability);
    yield* dependencies.revoke(body.start.threadId);
    if (Cause.hasInterruptsOnly(prepared.cause)) return yield* Effect.failCause(prepared.cause);
    return { status: "not-started" as const };
  }
  const launched: WatchdogProcessLaunchResult = yield* Effect.promise(() =>
    dependencies.spawn({
      entry,
      jobId,
      payload: encoded.success,
      signal,
      ...(separateProcessTree === true ? { separateProcessTree: true } : {}),
    }),
  );
  if (launched.status === "not-started") {
    journal.requestCancel(jobId);
    journal.seal(jobId, capability);
    yield* dependencies.revoke(body.start.threadId);
  }
  return launched;
});
