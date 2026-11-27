// @effect-diagnostics-next-line nodeBuiltinImport:off - This fixture drives an external CLI against a disposable loopback HTTP server.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - This fixture drives an external CLI against a disposable loopback HTTP server.
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - This fixture drives an external CLI against a disposable loopback HTTP server.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { OpenCodeRuntimeLive } from "./opencodeRuntime.ts";
import { makeOpenCodeAdapter } from "./Layers/OpenCodeAdapter.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  configureOpenAiApiAccount,
  OPENAI_API_CREDENTIAL_ENV,
  OpenCodeSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { openCodeApiEnvironment } from "./OpenCodeApiConnection.ts";

const model = "ft:fixture-B:Exact";
const key = "synthetic-offline-test";
const account = configureOpenAiApiAccount({
  displayName: "Fixture",
  models: ["fixture-A", model],
  apiKey: key,
});
const config = Schema.decodeUnknownSync(OpenCodeSettings)(account.config);

it("binds the account key to official Responses and preserves exact model IDs", () => {
  const env = openCodeApiEnvironment(config, {}, account.environment);
  const sdk = JSON.parse(env.OPENCODE_CONFIG_CONTENT!).provider.t3_openai;
  expect(sdk.options).toEqual({
    baseURL: "https://api.openai.com/v1",
    apiKey: "{env:T3_OPENAI_API_KEY}",
  });
  expect(sdk.npm).toBe("@ai-sdk/openai");
  expect(Object.keys(sdk.models)).toEqual(["fixture-A", model]);
  expect(env.OPENCODE_CONFIG_CONTENT).not.toContain(key);
  expect(env[OPENAI_API_CREDENTIAL_ENV]).toBe(key);
  expect(() => openCodeApiEnvironment(config, { [OPENAI_API_CREDENTIAL_ENV]: key })).toThrow(
    /own API key/,
  );
  for (const change of [
    { baseUrl: "https://example.invalid/v1" },
    { protocol: "chat-completions" as const },
    { providerId: "another" },
  ])
    expect(() =>
      openCodeApiEnvironment(
        { ...config, apiConnection: { ...config.apiConnection!, ...change } },
        {},
        account.environment,
      ),
    ).toThrow();
});

const binary = process.env.T3_TEST_OPENCODE_BINARY;

// Exercise the SDK bundled in OpenCode with a disposable home. Only the test transport URL changes.
it.skipIf(!binary)(
  "sends the chosen model to a loopback Responses API and renders its reply",
  async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-openai-api-"));
    const requests: Array<{ path: string; model: unknown; key: boolean; prompt: boolean }> = [];
    const text = "loopback-reply";
    const http = NodeHttp.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({
        path: req.url,
        model: body.model,
        key: req.headers.authorization === "Bearer " + key,
        prompt: JSON.stringify(body.input).includes("loopback-question"),
      });
      const part = { type: "output_text", text, annotations: [] };
      const msg = {
        type: "message",
        role: "assistant",
        id: "msg_fixture",
        status: "completed",
        content: [part],
      };
      const response = {
        id: "resp_fixture",
        object: "response",
        created_at: 1,
        model,
        status: "completed",
        output: [msg],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [i, data] of [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...msg, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          item_id: msg.id,
          part: { ...part, text: "" },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: msg.id,
          delta: text,
        },
        {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          item_id: msg.id,
          text,
        },
        { type: "response.output_item.done", output_index: 0, item: msg },
        { type: "response.completed", response },
      ].entries())
        res.write(
          "event: " +
            data.type +
            "\ndata: " +
            JSON.stringify({ ...data, sequence_number: i }) +
            "\n\n",
        );
      res.end();
    });
    try {
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("No loopback port");
      const endpoint = "http://127.0.0.1:" + address.port;
      const env = openCodeApiEnvironment(config, {}, account.environment);
      const inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
      inline.provider.t3_openai.options.baseURL = endpoint + "/v1";
      inline.share = "disabled";
      inline.agent = { title: { disable: true }, summary: { disable: true } };
      const environment = {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        ComSpec: process.env.ComSpec,
        PATH: process.env.PATH,
        HOME: dir,
        USERPROFILE: dir,
        APPDATA: dir,
        LOCALAPPDATA: dir,
        TEMP: dir,
        TMP: dir,
        XDG_CONFIG_HOME: NodePath.join(dir, "config"),
        XDG_DATA_HOME: NodePath.join(dir, "data"),
        XDG_CACHE_HOME: NodePath.join(dir, "cache"),
        XDG_STATE_HOME: NodePath.join(dir, "state"),
        HTTP_PROXY: endpoint,
        HTTPS_PROXY: endpoint,
        NO_PROXY: "127.0.0.1,localhost",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        ...env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(inline),
      };
      const instanceId = ProviderInstanceId.make("openai_api_loopback");
      const threadId = ThreadId.make("fixture-chat");
      const chat = Effect.gen(function* () {
        const adapter = yield* makeOpenCodeAdapter(
          { ...config, binaryPath: binary! },
          { instanceId, environment },
        );
        yield* adapter.startSession({
          threadId,
          cwd: dir,
          provider: ProviderDriverKind.make("opencode"),
          runtimeMode: "approval-required",
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "loopback-question",
          modelSelection: { instanceId, model: "t3_openai/" + model },
        });
        const events = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.turnId === turn.turnId),
          Stream.takeUntil(
            (event) => event.type === "turn.completed" || event.type === "turn.aborted",
          ),
          Stream.runCollect,
        );
        return events
          .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
          .join("");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(OpenCodeRuntimeLive, ServerConfig.layerTest(dir, dir)).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.timeout("25 seconds"),
      );
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This Node HTTP fixture drives the scoped runtime of the real adapter.
      const output = await Effect.runPromise(chat);
      expect(requests).toContainEqual({ path: "/v1/responses", model, key: true, prompt: true });
      expect(requests.every((request) => request.model === model)).toBe(true);
      expect(output).toContain(text);
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await NodeFSP.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  },
  40000,
);
