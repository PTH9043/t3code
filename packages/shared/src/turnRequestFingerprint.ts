import type { ClientOrchestrationCommand } from "@t3tools/contracts";
import { stableStringify } from "./relaySigning.ts";

type Turn = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

/** Produces identical input for server and mobile SHA-256 implementations. */
export function turnRequestFingerprintPayload(
  command: Turn,
  attachmentDigests: readonly string[],
): string {
  if (attachmentDigests.length !== command.message.attachments.length)
    throw new Error("Attachment digest count mismatch");
  const { createdAt: _createdAt, bootstrap, ...rest } = command;
  const createThread = bootstrap?.createThread;
  const canonicalBootstrap = bootstrap
    ? {
        ...bootstrap,
        ...(createThread ? { createThread: { ...createThread, createdAt: undefined } } : {}),
      }
    : undefined;
  return stableStringify({
    ...rest,
    ...(canonicalBootstrap ? { bootstrap: canonicalBootstrap } : {}),
    message: {
      ...command.message,
      attachments: command.message.attachments.map(
        ({ dataUrl: _dataUrl, ...attachment }, index) => ({
          ...attachment,
          dataDigest: attachmentDigests[index],
        }),
      ),
    },
  });
}
