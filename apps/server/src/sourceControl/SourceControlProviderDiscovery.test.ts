import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  probeSourceControlProvider,
  providerAuth,
  refineUnknownRemoteProvider,
  SOURCE_CONTROL_AUTH_PROBE_TIMEOUT_MS,
  SOURCE_CONTROL_CLI_PROBE_TIMEOUT_MS,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

const GITHUB_TEST_SPEC: SourceControlCliDiscoverySpec = {
  type: "cli",
  kind: "github",
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  installHint: "Install gh",
  parseAuth: () => providerAuth({ status: "authenticated", account: "octocat" }),
  refineUnknownRemote: () => null,
};

describe("SourceControlProviderDiscovery timeouts", () => {
  it.effect(
    "uses 8s CLI probe timeout and 10s auth/refine timeout, turning timeouts into clean unknownAuth",
    () =>
      Effect.gen(function* () {
        const recordedCalls: Array<{
          readonly operation: string;
          readonly timeoutMs: number | undefined;
        }> = [];

        const mockProcess: VcsProcess.VcsProcess["Service"] = {
          run: (input: Parameters<VcsProcess.VcsProcess["Service"]["run"]>[0]) => {
            recordedCalls.push({ operation: input.operation, timeoutMs: input.timeoutMs });
            if (input.operation === "source-control.discovery.probe") {
              return Effect.succeed({
                stdout: "gh version 2.80.0",
                stderr: "",
                exitCode: 0,
              } as unknown as VcsProcess.VcsProcessOutput);
            }
            return Effect.fail(new Error("Command timed out after 10000ms") as never);
          },
          runChecked: () => Effect.die("unused"),
        } as unknown as VcsProcess.VcsProcess["Service"];

        const item = yield* probeSourceControlProvider({
          spec: GITHUB_TEST_SPEC,
          process: mockProcess,
          cwd: process.cwd(),
        });

        assert.strictEqual(item.status, "available");
        assert.strictEqual(item.auth.status, "unknown");
        assert.strictEqual(Option.getOrUndefined(item.auth.detail)?.includes("10초"), true);

        yield* refineUnknownRemoteProvider({
          specs: [GITHUB_TEST_SPEC],
          process: mockProcess,
          cwd: process.cwd(),
          context: {
            provider: { kind: "unknown", label: "Unknown", host: "example.com" },
            remoteName: "origin",
            remoteUrl: "https://example.com/org/repo.git",
          } as never,
        });

        assert.deepStrictEqual(recordedCalls, [
          {
            operation: "source-control.discovery.probe",
            timeoutMs: SOURCE_CONTROL_CLI_PROBE_TIMEOUT_MS,
          },
          {
            operation: "source-control.discovery.auth",
            timeoutMs: SOURCE_CONTROL_AUTH_PROBE_TIMEOUT_MS,
          },
          {
            operation: "source-control.discovery.refine-unknown-remote",
            timeoutMs: SOURCE_CONTROL_AUTH_PROBE_TIMEOUT_MS,
          },
        ]);
        assert.strictEqual(SOURCE_CONTROL_CLI_PROBE_TIMEOUT_MS, 8_000);
        assert.strictEqual(SOURCE_CONTROL_AUTH_PROBE_TIMEOUT_MS, 10_000);
      }),
  );
});
