import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { makeAntigravityEnvironment, resolveAntigravityLaunch } from "./AntigravityLaunch.ts";

it("maps legacy paths to the native executable and isolates each managed profile", () => {
  const launch = (id: string, binaryPath: string) =>
    resolveAntigravityLaunch({
      instanceId: ProviderInstanceId.make(id),
      stateDir: "state",
      settings: { binaryPath, homePath: "" },
    });
  const a = launch("account-a", "C:/legacy/gemini.cmd");
  const b = launch("account-b", "gemini");
  expect(a.command).toMatch(/(?:^|[\\/])agy(?:\.exe)?$/i);
  expect(b.command).toBe(a.command);
  expect(a.profileDirectory).not.toBe(b.profileDirectory);
  expect(a.args).toEqual([
    "acp",
    "--gemini-dir",
    expect.stringMatching(/account-a[\\/]antigravity-home[\\/]\.gemini$/),
    "--app-data-dir",
    "antigravity-cli",
    "--process-per-session",
  ]);
  expect(launch("account-a", "C:/tools/agy.exe").command).toBe("C:/tools/agy.exe");
});
it("keeps inherited legacy credentials out of the child environment and accepts explicit instance settings", () => {
  const env = makeAntigravityEnvironment(
    [{ name: "GOOGLE_API_KEY", value: "explicit-fixture", sensitive: true }],
    {
      Path: "test-path",
      Google_Api_Key: "ambient-fixture",
      GEMINI_CLI_HOME: "legacy",
      GOOGLE_APPLICATION_CREDENTIALS: "other-account",
    },
  );
  expect(env).toEqual({ Path: "test-path", GOOGLE_API_KEY: "explicit-fixture" });
});
