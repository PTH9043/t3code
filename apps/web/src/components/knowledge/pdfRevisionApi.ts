import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "~/connection/runtime";

export const getPdfRevisionStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.getPdfRevisionStatus,
  label: "knowledge:pdf-revision-status",
});
export const startPdfRevision = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.startPdfRevision,
  label: "knowledge:start-pdf-revision",
});
export const retryPdfRevision = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.retryPdfRevision,
  label: "knowledge:retry-pdf-revision",
});
export const readPdfRevisionSource = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.readPdfRevisionSource,
  label: "knowledge:read-pdf-revision-source",
});
