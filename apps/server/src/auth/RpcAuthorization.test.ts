import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WORKSPACE_MEMORY_WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("reads the knowledge dashboard and dispatches management commands under their existing scopes", () => {
    expect(requiredScopeForRpcMethod(ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeDashboard)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires operate scope for PDF publication and read scope for published sources", () => {
    expect(requiredScopeForRpcMethod(ORCHESTRATION_WS_METHODS.getPdfRevisionStatus)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(ORCHESTRATION_WS_METHODS.startPdfRevision)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(ORCHESTRATION_WS_METHODS.retryPdfRevision)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(ORCHESTRATION_WS_METHODS.readPdfRevisionSource)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("requires operate scope to run a local tool activity summary", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverSummarizeToolActivity)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates project channel status from authorizing a personal feed or CLI transfer", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.telegramChannelsStatus)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.telegramChannelsManage)).toBe(AuthAccessWriteScope);
  });

  it("requires write permission to change indexed memory", () => {
    expect(requiredScopeForRpcMethod(WORKSPACE_MEMORY_WS_METHODS.forgetMessage)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WORKSPACE_MEMORY_WS_METHODS.remember)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});
