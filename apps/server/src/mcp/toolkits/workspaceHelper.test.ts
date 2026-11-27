import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  runWorkspaceHelper,
  type WorkspaceHelperInstance,
  type WorkspaceHelperRequest,
} from "./workspaceHelper.ts";

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      messages: Schema.Array(Schema.Struct({ content: Schema.String })),
    }),
  ),
);

const baidu: WorkspaceHelperInstance = {
  driver: "opencode",
  displayName: "Baidu",
  config: {
    apiConnection: {
      providerId: "qianfan",
      baseUrl: "https://qianfan.baidubce.com/v2/",
      protocol: "chat-completions",
      models: ["ernie-5.1"],
    },
  },
  environment: [{ name: "T3_OPENCODE_API_KEY", value: " secret-key " }],
};
const instances = (config: Record<string, unknown>, helper: WorkspaceHelperInstance = baidu) => ({
  claude: { driver: "claudeAgent", config },
  opencode_baidu: helper,
});
const run = (
  config: Record<string, unknown>,
  options?: {
    readonly model?: string;
    readonly action?: "status" | "run";
    readonly fetch?: WorkspaceHelperRequest;
    readonly helper?: WorkspaceHelperInstance;
    readonly context?: string;
  },
) =>
  runWorkspaceHelper({
    providerInstances: instances(config, options?.helper),
    callerInstanceId: "claude",
    callerModel: options?.model ?? "claude-opus-5-5",
    request: {
      action: options?.action ?? "run",
      task: "Summarise this.",
      ...(options?.context ? { context: options.context } : {}),
    },
    fetch: options?.fetch ?? (() => Promise.reject(new Error("the helper must not be called"))),
  });

it.effect("sends the chore to the assigned helper and returns its answer", () =>
  Effect.gen(function* () {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const result = yield* run(
      { helperAccount: "baidu:ernie-5.1" },
      {
        context: "Public text.",
        fetch: (url, options) => {
          calls.push({ url, options });
          return Promise.resolve(
            Response.json({
              choices: [{ message: { content: " Done. " } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            }),
          );
        },
      },
    );
    assert.deepEqual(result, {
      available: true,
      account: "Baidu",
      model: "ernie-5.1",
      projectContentAllowed: false,
      text: "Done.",
      inputTokens: 12,
      outputTokens: 3,
      message: null,
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.url, "https://qianfan.baidubce.com/v2/chat/completions");
    assert.strictEqual(
      new Headers(calls[0]?.options.headers).get("Authorization"),
      "Bearer secret-key",
    );
    const body = decodeBody(String(calls[0]?.options.body));
    assert.strictEqual(body.model, "ernie-5.1");
    assert.include(body.messages[1]?.content, "Summarise this.");
    assert.include(body.messages[1]?.content, "<material>\nPublic text.\n</material>");
  }),
);

it.effect("answers unavailable, without calling out, when no helper applies", () =>
  Effect.gen(function* () {
    const none = yield* run({});
    assert.strictEqual(none.available, false);
    // The person limited the helper to other answering models.
    const disallowed = yield* run({ helperAccount: "Baidu:ernie-5.1", helperForModels: "sonnet" });
    assert.strictEqual(disallowed.available, false);
    const allowed = yield* run(
      { helperAccount: "Baidu:ernie-5.1", helperForModels: "sonnet", helperScope: "project" },
      { model: "claude-sonnet-5-5", action: "status" },
    );
    assert.strictEqual(allowed.available, true);
    assert.strictEqual(allowed.projectContentAllowed, true);
    assert.isNull(allowed.text);

    const unknownAccount = yield* run({ helperAccount: "Nobody:ernie-5.1" });
    assert.strictEqual(unknownAccount.available, false);
    const unknownModel = yield* run({ helperAccount: "Baidu:other" });
    assert.strictEqual(unknownModel.available, false);
    const disabled = yield* run(
      { helperAccount: "Baidu:ernie-5.1" },
      { helper: { ...baidu, enabled: false } },
    );
    assert.strictEqual(disabled.available, false);
    const keyless = yield* run(
      { helperAccount: "Baidu:ernie-5.1" },
      { helper: { ...baidu, environment: [] } },
    );
    assert.strictEqual(keyless.available, false);
  }),
);

it.effect("reports a failed or empty helper response as an error", () =>
  Effect.gen(function* () {
    const config = { helperAccount: "Baidu:ernie-5.1" };
    const denied = yield* run(config, {
      fetch: () => Promise.resolve(new Response("no", { status: 401 })),
    }).pipe(Effect.flip);
    assert.include(denied.message, "키");
    const empty = yield* run(config, {
      fetch: () => Promise.resolve(Response.json({ choices: [] })),
    }).pipe(Effect.flip);
    assert.include(empty.message, "내용 없는 응답");
    const offline = yield* run(config, {
      fetch: () => Promise.reject(new Error("offline")),
    }).pipe(Effect.flip);
    assert.include(offline.message, "연결하지 못했습니다");
  }),
);

const decodeOllamaBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      keep_alive: Schema.optional(Schema.String),
      options: Schema.optional(Schema.Struct({ num_ctx: Schema.optional(Schema.Number) })),
    }),
  ),
);

it.effect("calls local Ollama without an API key and forwards num_ctx and keep_alive", () =>
  Effect.gen(function* () {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const result = yield* runWorkspaceHelper({
      providerInstances: {
        claude: {
          driver: "claudeAgent",
          config: { helperAccount: "ollama-local:qwen2.5-coder:14b", helperScope: "project" },
        },
      },
      callerInstanceId: "claude",
      callerModel: "claude-opus-5-5",
      request: { action: "run", task: "Summarize diff", context: "+export const a = 1;" },
      fetch: (url, options) => {
        calls.push({ url, options });
        return Promise.resolve(
          Response.json({
            choices: [{ message: { content: "Added export a." } }],
            usage: { prompt_tokens: 40, completion_tokens: 5 },
          }),
        );
      },
    });
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.account, "Ollama");
    assert.strictEqual(result.model, "qwen2.5-coder:14b");
    assert.strictEqual(result.text, "Added export a.");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.isNull(new Headers(calls[0]?.options.headers).get("Authorization"));
    const body = decodeOllamaBody(String(calls[0]?.options.body));
    assert.strictEqual(body.model, "qwen2.5-coder:14b");
    assert.strictEqual(body.keep_alive, "30m");
    assert.strictEqual(body.options?.num_ctx, 16_384);
  }),
);

it.effect("reads helperAccount fallback from legacy providers map for gemini/neon callers", () =>
  Effect.gen(function* () {
    const result = yield* runWorkspaceHelper({
      providerInstances: {},
      providers: {
        gemini: {
          enabled: true,
          helperAccount: "ollama-local:qwen2.5-coder:14b",
          helperScope: "project",
        },
      },
      callerInstanceId: "gemini",
      callerModel: "gemini-4-neon",
      request: { action: "status" },
    });
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.account, "Ollama");
    assert.strictEqual(result.model, "qwen2.5-coder:14b");
    assert.strictEqual(result.projectContentAllowed, true);
  }),
);
