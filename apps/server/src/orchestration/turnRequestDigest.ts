// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { turnRequestFingerprintPayload } from "@t3tools/shared/turnRequestFingerprint";

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

/** Ownership marker for a recoverable local thread creation. */
export function bootstrapCreateCommandId(command: {
  readonly commandId: CommandId;
  readonly threadId: import("@t3tools/contracts").ThreadId;
  readonly requestFingerprint?: string;
}): CommandId {
  if (!command.requestFingerprint) throw new Error("Bootstrap fingerprint is required");
  return CommandId.make(
    `bootstrap-create:${hash(stableStringify({ commandId: command.commandId, threadId: command.threadId, requestFingerprint: command.requestFingerprint }))}`,
  );
}

/** Hash the user's request before server timestamps and attachment IDs are allocated. */
export function clientTurnRequestDigest(
  command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>,
): string {
  return hash(
    turnRequestFingerprintPayload(
      command,
      command.message.attachments.map(({ dataUrl }) => hash(dataUrl)),
    ),
  );
}

/** In-process callers already own normalized attachment identifiers. */
export function normalizedTurnRequestDigest(
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
): string {
  if (command.requestFingerprint) return command.requestFingerprint;
  const { createdAt: _createdAt, requestFingerprint: _requestFingerprint, ...rest } = command;
  return hash(stableStringify(rest));
}
