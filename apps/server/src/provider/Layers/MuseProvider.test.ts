// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { MuseSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  checkMuseProviderStatus,
  parseMuseListModelsOutput,
  parseMuseUsageJson,
} from "./MuseProvider.ts";
import { makeMuseEnvironment } from "../Drivers/MuseHome.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("MuseProvider", () => {
  it("parses both JSON and line-delimited output from muse exec --list-models", () => {
    const fromJson = parseMuseListModelsOutput(
      JSON.stringify({
        models: [
          { id: "muse-spark-1.3", name: "Muse Spark 1.3", default: true },
          { id: "muse-spark-1.2" },
        ],
      }),
    );
    expect(fromJson.map((m) => m.slug)).toEqual(["muse-spark-1.3", "muse-spark-1.2"]);
    expect(fromJson[0]?.isDefault).toBe(true);

    const fromLines = parseMuseListModelsOutput("muse-spark-1.3 (default)\nmuse-spark-1.2\n");
    expect(fromLines.map((m) => m.slug)).toEqual(["muse-spark-1.3", "muse-spark-1.2"]);
    expect(fromLines[0]?.isDefault).toBe(true);
  });

  it("parses muse usage --json allowance payload into ServerProviderUsage", () => {
    const usage = parseMuseUsageJson(
      JSON.stringify({
        allowance: {
          tier: "pro",
          window: { usedPercent: 34.5, resetsAtMs: 1_800_000_000_000 },
          weekly: { used_percent: 12, resets_at_ms: 1_800_500_000_000 },
        },
      }),
      "2026-11-26T06:45:00.000Z",
    );

    expect(usage).toBeDefined();
    expect(usage?.planType).toBe("pro");
    expect(usage?.primary?.usedPercent).toBe(34.5);
    expect(usage?.primary?.resetsAt).toBe(1_800_000_000);
    expect(usage?.secondary?.usedPercent).toBe(12);
  });

  it("returns warning without launching login when Muse CLI is installed but unauthenticated", async () => {
    const fakeDir = makeTempDir("t3-muse-provider-");
    const fakeCli = NodePath.join(fakeDir, "fake-muse.mjs");
    NodeFs.writeFileSync(
      fakeCli,
      `if (process.argv.includes("--version")) { console.log("Muse Code 1.4.25 (1.4.25-R9361.1)"); process.exit(0); }\nprocess.exit(1);\n`,
    );
    const settings = decodeMuseSettings({
      enabled: true,
      binaryPath: `${process.execPath}`,
      homePath: fakeDir,
    });
    // Use Node wrapper cmd on Windows / sh on POSIX to simulate `muse --version`
    const wrapperPath = NodePath.join(
      fakeDir,
      process.platform === "win32" ? "fake-muse.cmd" : "fake-muse.sh",
    );
    if (process.platform === "win32") {
      NodeFs.writeFileSync(
        wrapperPath,
        `@echo off\r\n"${process.execPath}" "%~dp0fake-muse.mjs" %*\r\n`,
      );
    } else {
      NodeFs.writeFileSync(
        wrapperPath,
        `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" "$@"\n`,
        {
          mode: 0o755,
        },
      );
    }

    const probeSettings = { ...settings, binaryPath: wrapperPath };
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const env = yield* makeMuseEnvironment(probeSettings, {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
        });
        return yield* checkMuseProviderStatus(probeSettings, env);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(snapshot.installed).toBe(true);
    expect(snapshot.version).toBe("1.4.25");
    expect(snapshot.status).toBe("warning");
    expect(snapshot.auth.status).toBe("unauthenticated");
    expect(snapshot.models.some((m) => m.slug === "muse-spark-1.3")).toBe(true);
  });
});
