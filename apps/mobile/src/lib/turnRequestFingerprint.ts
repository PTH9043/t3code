import type { ClientOrchestrationCommand } from "@t3tools/contracts";
import { turnRequestFingerprintPayload } from "@t3tools/shared/turnRequestFingerprint";
import * as Crypto from "expo-crypto";

type Turn = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
const hash = (value: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);

export async function turnRequestFingerprint(command: Turn): Promise<string> {
  const digests: string[] = [];
  for (const attachment of command.message.attachments)
    digests.push(await hash(attachment.dataUrl));
  return hash(turnRequestFingerprintPayload(command, digests));
}
