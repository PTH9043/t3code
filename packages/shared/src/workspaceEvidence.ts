import type { WorkspaceAutomationEvidence } from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

export function workspaceEvidenceBytes(
  evidence: WorkspaceAutomationEvidence,
): Uint8Array<ArrayBuffer> {
  if (evidence.encoding === "base64")
    return new Uint8Array(Result.getOrThrow(Encoding.decodeBase64(evidence.contents)));
  return new TextEncoder().encode(evidence.contents);
}

export function workspaceEvidenceHtml(contents: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>body{margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}a,form{pointer-events:none}</style></head><body>${contents}</body></html>`;
}

export function workspaceEvidenceText(contents: string) {
  return { contents: contents.slice(0, 50_000), shortened: contents.length > 50_000 };
}
