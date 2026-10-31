import type { InputCompositionReport } from "@t3tools/contracts";
import { contextArtifactHash } from "./workspaceContextArtifacts.ts";

export function describeInputComposition(input: {
  readonly prompt: string;
  readonly path: InputCompositionReport["path"];
  readonly parts: InputCompositionReport["parts"];
  readonly attachmentCount?: number;
}): InputCompositionReport {
  const assigned = input.parts.reduce((sum, part) => sum + part.chars, 0);
  // If normalization changed a boundary, report the whole assignment instead of fictitious totals.
  const parts =
    assigned <= input.prompt.length
      ? [
          ...input.parts,
          ...(assigned === input.prompt.length
            ? []
            : [{ kind: "separators" as const, chars: input.prompt.length - assigned }]),
        ]
      : [{ kind: "assignment" as const, chars: input.prompt.length }];
  return {
    version: 1,
    status: "prepared",
    path: input.path,
    promptChars: input.prompt.length,
    contextRevision: contextArtifactHash(input.prompt),
    parts,
    attachmentCount: input.attachmentCount ?? 0,
    estimatedTokens: null,
    nativeContext: "unknown",
  };
}
