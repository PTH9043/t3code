import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "~/connection/runtime";

export const dashboardQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeDashboard,
  label: "knowledge:dashboard",
  idleTtlMs: 0,
});
export const dashboardCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
  label: "knowledge:dashboard-action",
});
