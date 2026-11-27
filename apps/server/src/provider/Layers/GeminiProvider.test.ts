import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { GeminiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeMockLauncher } from "../acp/mockLauncher.test-support.ts";
import {
  buildInitialGeminiProviderSnapshot,
  checkGeminiProviderStatus,
  clearGeminiAuthCooldown,
  clearGeminiModelCatalogCacheForTest,
} from "./GeminiProvider.ts";

const settings = Schema.decodeSync(GeminiSettings);

it.effect(
  "keeps enabled and disabled Antigravity instances visible with an empty pending catalog",
  () =>
    Effect.gen(function* () {
      for (const enabled of [false, true]) {
        const snapshot = yield* buildInitialGeminiProviderSnapshot(settings({ enabled }));
        expect(snapshot.displayName).toBe("Antigravity CLI");
        expect(snapshot.enabled).toBe(enabled);
        expect(snapshot.status).toBe(enabled ? "warning" : "disabled");
        expect(snapshot.models).toEqual([]);
      }
    }),
);

it.layer(NodeServices.layer)("noninteractive Antigravity discovery", (it) => {
  for (const scenario of ["login", "failure", "empty", "catalog"] as const) {
    it.effect(scenario, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-status-" });
        const binaryPath = yield* writeMockLauncher(
          path.join(directory, "agy.mjs"),
          `
        import fs from "node:fs";
        import readline from "node:readline";
        const log = new URL("./methods", import.meta.url);
        if (process.argv.includes("--version")) { console.log("1.5.12"); process.exit(0); }
        if (!process.argv.includes("acp") || process.argv.includes("--login")) process.exit(2);
        for await (const line of readline.createInterface({input:process.stdin})) {
          const {id,method} = JSON.parse(line);
          fs.appendFileSync(log,method+"\\n");
          const reply = {jsonrpc:"2.0",id};
          if (method === "initialize") reply.result = {protocolVersion:1,agentCapabilities:{sessionCapabilities:{close:{}}}};
          else if (method === "session/new" && ["login","failure"].includes("${scenario}"))
            reply.error = {code: "${scenario}" === "login" ? -32000 : -32603, message:"sensitive mock error"};
          else if (method === "session/new") reply.result = {sessionId:"test",configOptions:"${scenario}" === "empty" ? [] : [
            {id:"model",type:"select",name:"Model",currentValue:"offered",options:[{name:"Offered",value:"offered"}]}]};
          else if (method === "session/close") reply.result = {};
          else process.exit(3);
          console.log(JSON.stringify(reply));
        }
      `,
        );
        const snapshot = yield* checkGeminiProviderStatus(settings({ enabled: true, binaryPath }));
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("1.5.12");
        expect(snapshot.auth.status).toBe(
          scenario === "login"
            ? "unauthenticated"
            : scenario === "catalog"
              ? "authenticated"
              : "unknown",
        );
        expect(snapshot.status).toBe(
          scenario === "catalog" ? "ready" : scenario === "empty" ? "warning" : "error",
        );
        expect(snapshot.models.map((model) => model.slug)).toEqual(
          scenario === "catalog" ? ["offered"] : [],
        );
        if (scenario === "login") expect(snapshot.message).toContain("sign in");
        expect(snapshot.message ?? "").not.toContain("sensitive");
        const methods = (yield* fs.readFileString(path.join(directory, "methods")))
          .trim()
          .split(/\r?\n/);
        expect(methods).toEqual([
          "initialize",
          "session/new",
          ...(["catalog", "empty"].includes(scenario) ? ["session/close"] : []),
        ]);
      }),
    );
  }

  it.effect(
    "reads 5-hour and weekly quota windows from agy -p /usage after authenticated discovery",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-usage-" });
        const binaryPath = yield* writeMockLauncher(
          path.join(directory, "agy.mjs"),
          `
        import readline from "node:readline";
        if (process.argv.includes("--version")) { console.log("1.5.12"); process.exit(0); }
        if (process.argv.includes("-p") && process.argv.includes("/usage")) {
          console.log("Gemini Models\\tWeekly Limit Remaining\\t94%\\t2026-11-27T09:36:45Z");
          console.log("Gemini Models\\tFive Hour Limit Remaining\\t82%\\t2026-11-20T14:36:45Z");
          console.log("Claude and GPT models\\tWeekly Limit Remaining\\t50%\\t2026-11-27T09:39:04Z");
          console.log("Claude and GPT models\\tFive Hour Limit Remaining\\t0%\\t2026-11-20T14:39:04Z");
          process.exit(0);
        }
        if (!process.argv.includes("acp")) process.exit(2);
        for await (const line of readline.createInterface({input:process.stdin})) {
          const {id,method} = JSON.parse(line);
          const reply = {jsonrpc:"2.0",id};
          if (method === "initialize") reply.result = {protocolVersion:1,agentCapabilities:{sessionCapabilities:{close:{}}}};
          else if (method === "session/new") reply.result = {sessionId:"test",configOptions:[
            {id:"model",type:"select",name:"Model",currentValue:"gemini-4-neon",options:[{name:"Gemini 4 Neon",value:"gemini-4-neon"}]}]};
          else if (method === "session/close") reply.result = {};
          console.log(JSON.stringify(reply));
        }
      `,
        );
        const snapshot = yield* checkGeminiProviderStatus(settings({ enabled: true, binaryPath }));
        expect(snapshot.status).toBe("ready");
        expect(snapshot.usage).toMatchObject({
          source: "provider",
          primary: {
            label: "Gemini 5시간",
            bucket: "gemini",
            usedPercent: 18,
            windowDurationMinutes: 300,
          },
          secondary: {
            label: "Gemini 7일",
            bucket: "gemini",
            usedPercent: 6,
            windowDurationMinutes: 10_080,
          },
          extraWindows: [
            {
              label: "Claude·GPT 5시간",
              bucket: "claude-gpt",
              usedPercent: 100,
              windowDurationMinutes: 300,
            },
            {
              label: "Claude·GPT 7일",
              bucket: "claude-gpt",
              usedPercent: 50,
              windowDurationMinutes: 10_080,
            },
          ],
        });
      }),
  );

  it.effect("applies auth cooldown after -32000 so repeated checks do not re-spawn agy acp", () =>
    Effect.gen(function* () {
      clearGeminiModelCatalogCacheForTest();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cooldown-" });
      const binaryPath = yield* writeMockLauncher(
        path.join(directory, "agy.mjs"),
        `
        import fs from "node:fs";
        import readline from "node:readline";
        const log = new URL("./acp-count", import.meta.url);
        if (process.argv.includes("--version")) { console.log("1.5.12"); process.exit(0); }
        if (!process.argv.includes("acp")) process.exit(2);
        fs.appendFileSync(log, "spawn\\n");
        for await (const line of readline.createInterface({input:process.stdin})) {
          const {id,method} = JSON.parse(line);
          const reply = {jsonrpc:"2.0",id};
          if (method === "initialize") reply.result = {protocolVersion:1,agentCapabilities:{sessionCapabilities:{close:{}}}};
          else if (method === "session/new") reply.error = {code:-32000, message:"Authentication required"};
          console.log(JSON.stringify(reply));
        }
      `,
      );
      const geminiSettings = settings({ enabled: true, binaryPath });

      const first = yield* checkGeminiProviderStatus(geminiSettings);
      const second = yield* checkGeminiProviderStatus(geminiSettings);

      expect(first.auth.status).toBe("unauthenticated");
      expect(second.auth.status).toBe("unauthenticated");
      expect(first.message).toContain("Antigravity 로그인");
      expect(first.message).toContain("sign in");

      const spawnsBeforeClear = (yield* fs.readFileString(path.join(directory, "acp-count")))
        .trim()
        .split(/\r?\n/);
      expect(spawnsBeforeClear).toHaveLength(1);

      clearGeminiAuthCooldown(geminiSettings);
      yield* checkGeminiProviderStatus(geminiSettings);
      const spawnsAfterClear = (yield* fs.readFileString(path.join(directory, "acp-count")))
        .trim()
        .split(/\r?\n/);
      expect(spawnsAfterClear).toHaveLength(2);
    }),
  );
});
