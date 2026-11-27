// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GeminiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { writeMockLauncher } from "../acp/mockLauncher.test-support.ts";
import { makeGeminiAdapter } from "./GeminiAdapter.ts";

const encodeString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const encodeUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeStringArray = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const decodeSettings = Schema.decodeUnknownEffect(GeminiSettings);

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-gemini-history-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("GeminiAdapter history lifecycle", (it) => {
  for (const failPrompt of [false, true]) {
    it.effect(
      `keeps events and disk history after the startup caller exits (failure=${failPrompt})`,
      () =>
        Effect.gen(function* () {
          const directory = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-acp-mock-")),
          );
          const mock = new URL("../../../scripts/acp-mock-agent.ts", import.meta.url);
          const mockUrl = yield* encodeString(mock.href);
          const binaryPath = yield* writeMockLauncher(
            NodePath.join(directory, "fake-gemini.mjs"),
            `${failPrompt ? 'process.env.T3_ACP_FAIL_PROMPT="1";' : ""}\nawait import(${mockUrl});`,
          );
          const settings = yield* decodeSettings({ binaryPath });
          const adapter = yield* makeGeminiAdapter(settings);
          const threadId = ThreadId.make(`gemini-history-${failPrompt}`);
          const starting = yield* adapter
            .startSession({
              threadId,
              provider: ProviderDriverKind.make("gemini"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              resumeCursor: { schemaVersion: 1, sessionId: "old-gemini-only" },
              modelSelection: {
                instanceId: ProviderInstanceId.make("gemini"),
                model: "composer-2",
              },
            })
            .pipe(Effect.forkChild);
          const session = yield* Fiber.join(starting);
          assert.equal(session.continuity, "resume-fallback");
          assert.deepInclude(session.resumeCursor, {
            harness: "antigravity",
            schemaVersion: 2,
            instanceId: "gemini",
          });
          const events = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
          const sent = yield* adapter
            .sendTurn({ threadId, input: "한글 원문\nGemini history", attachments: [] })
            .pipe(Effect.result);
          const completed = yield* Fiber.join(events);
          const terminal = completed.find((event) => event.type === "turn.completed");
          assert.equal(terminal?.payload.state, failPrompt ? "failed" : "completed");
          if (!failPrompt) assert.isTrue(completed.some((event) => event.type === "content.delta"));
          assert.equal(sent._tag, failPrompt ? "Failure" : "Success");
          const snapshot = yield* adapter.readThread(threadId);
          assert.equal(snapshot.turns.length, failPrompt ? 0 : 1);
          if (!failPrompt) {
            const raw = yield* encodeUnknown(snapshot.turns[0]?.items);
            assert.include(raw, "한글 원문");
          }
          yield* adapter.stopSession(threadId);
          assert.isEmpty(yield* adapter.listSessions());
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }),
    );
  }

  it.effect("declares stopSessionDrainsEvents and emits no events after session.exited", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-acp-drain-")),
      );
      try {
        const mock = new URL("../../../scripts/acp-mock-agent.ts", import.meta.url);
        const mockUrl = yield* encodeString(mock.href);
        const binaryPath = yield* writeMockLauncher(
          NodePath.join(directory, "fake-gemini-perm.mjs"),
          `process.env.T3_ACP_EMIT_TOOL_CALLS="1";\nawait import(${mockUrl});`,
        );
        const settings = yield* decodeSettings({ binaryPath });
        const adapter = yield* makeGeminiAdapter(settings);
        assert.isTrue(adapter.capabilities.stopSessionDrainsEvents);

        const threadId = ThreadId.make("gemini-drain-stop");
        const received: Array<{ readonly type: string }> = [];
        const collector = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              received.push({ type: event.type });
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        const permissionOpened = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "request.opened"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("gemini"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: {
            instanceId: ProviderInstanceId.make("gemini"),
            model: "composer-2",
          },
        });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "Trigger permission request", attachments: [] })
          .pipe(Effect.result, Effect.forkChild);

        yield* Fiber.join(permissionOpened);
        yield* adapter.stopSession(threadId);
        yield* Fiber.join(turnFiber);
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow;
        }
        yield* Fiber.interrupt(collector);

        const exitIndex = received.findIndex((event) => event.type === "session.exited");
        assert.isAtLeast(exitIndex, 0);
        assert.equal(exitIndex, received.length - 1);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      }
    }),
  );

  it.effect(
    "auto-continues premature promise stops in the same turn, inserts paragraph break, and accumulates token usage",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-acp-stop-guard-")),
        );
        try {
          const promptLogPath = NodePath.join(directory, "prompts.json");
          const promptLogLiteral = yield* encodeString(promptLogPath);
          const binaryPath = yield* writeMockLauncher(
            NodePath.join(directory, "fake-gemini-stop-guard.mjs"),
            `import * as fs from "node:fs";
import * as readline from "node:readline";

const logPath = ${promptLogLiteral};
const receivedPrompts = [];
let callIndex = 0;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (req.method === "session/new") {
    const configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "composer-2",
        options: [{ value: "composer-2", name: "Composer 2" }],
      },
    ];
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "guard-session-1", configOptions } });
    return;
  }
  if (req.method === "session/set_config_option") {
    const configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "composer-2",
        options: [{ value: "composer-2", name: "Composer 2" }],
      },
    ];
    send({ jsonrpc: "2.0", id: req.id, result: { configOptions } });
    return;
  }
  if (req.method === "session/prompt") {
    callIndex += 1;
    const text = (req.params?.prompt ?? []).map((p) => p.text ?? "").join("");
    receivedPrompts.push(text);
    fs.writeFileSync(logPath, JSON.stringify(receivedPrompts), "utf8");
    if (callIndex === 1) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "guard-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "백그라운드에서 빌드 진행 중입니다. 완료되는 대로 결과를 보고드리겠습니다." },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          stopReason: "end_turn",
          usage: { totalTokens: 150, inputTokens: 100, outputTokens: 50, cachedReadTokens: 20 },
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "guard-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "## [보고]\\n빌드와 테스트 검증을 모두 완료했습니다." },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: 210, inputTokens: 130, outputTokens: 80, cachedReadTokens: 30 },
      },
    });
  }
});
`,
          );

          const settings = yield* decodeSettings({ binaryPath });
          const adapter = yield* makeGeminiAdapter(settings);
          const threadId = ThreadId.make("gemini-stop-guard-auto-continue");
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("gemini"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );

          const result = yield* adapter.sendTurn({
            threadId,
            input: "빌드를 끝까지 완료해줘",
            attachments: [],
          });
          const events = yield* Fiber.join(eventsFiber);

          const warnings = events.filter((e) => e.type === "runtime.warning");
          assert.equal(warnings.length, 1);
          assert.equal(warnings[0]?.payload.message, "조기 종료 감지 → 자동 계속 실행 (1/3)");
          assert.equal(warnings[0]?.turnId, result.turnId);

          const combinedText = events
            .filter((e) => e.type === "content.delta")
            .map((e) => e.payload.delta)
            .join("");
          assert.equal(
            combinedText,
            "백그라운드에서 빌드 진행 중입니다. 완료되는 대로 결과를 보고드리겠습니다.\n\n## [보고]\n빌드와 테스트 검증을 모두 완료했습니다.",
          );

          const usageEvents = events.filter((e) => e.type === "thread.token-usage.updated");
          assert.equal(usageEvents.length, 1);
          assert.deepInclude(usageEvents[0]?.payload.consumption?.[0]?.counts, {
            total: 360,
            input: 230,
            output: 130,
            cacheRead: 50,
          });

          const completions = events.filter((e) => e.type === "turn.completed");
          assert.equal(completions.length, 1);
          assert.equal(completions[0]?.payload.state, "completed");

          const promptsRaw = yield* Effect.promise(() => NodeFSP.readFile(promptLogPath, "utf8"));
          const prompts = yield* decodeStringArray(promptsRaw);
          assert.equal(prompts.length, 2);

          yield* adapter.stopSession(threadId);
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }),
  );

  it.effect("escapes near-duplicate premature-stop loops (10초 -> 15초)", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-acp-stop-loop-")),
      );
      try {
        const promptLogPath = NodePath.join(directory, "prompts-loop.json");
        const promptLogLiteral = yield* encodeString(promptLogPath);
        const binaryPath = yield* writeMockLauncher(
          NodePath.join(directory, "fake-gemini-stop-loop.mjs"),
          `import * as fs from "node:fs";
import * as readline from "node:readline";

const logPath = ${promptLogLiteral};
const receivedPrompts = [];
let callIndex = 0;
const modelConfigOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "composer-2",
    options: [{ value: "composer-2", name: "Composer 2" }],
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (req.method === "session/new") {
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "guard-loop-1", configOptions: modelConfigOptions } });
    return;
  }
  if (req.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: req.id, result: { configOptions: modelConfigOptions } });
    return;
  }
  if (req.method === "session/prompt") {
    callIndex += 1;
    const text = (req.params?.prompt ?? []).map((p) => p.text ?? "").join("");
    receivedPrompts.push(text);
    fs.writeFileSync(logPath, JSON.stringify(receivedPrompts), "utf8");
    const reply =
      callIndex === 1
        ? "테스트 진행 중입니다. 10초 뒤 결과를 보고드리겠습니다."
        : "테스트 진행 중입니다. 15초 뒤 결과를 보고드리겠습니다!";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "guard-loop-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reply },
        },
      },
    });
    send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
  }
});
`,
        );

        const settings = yield* decodeSettings({ binaryPath });
        const adapter = yield* makeGeminiAdapter(settings);
        const threadId = ThreadId.make("gemini-stop-guard-loop-escape");
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("gemini"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* adapter.sendTurn({
          threadId,
          input: "테스트 실행해줘",
          attachments: [],
        });
        const events = yield* Fiber.join(eventsFiber);

        // Should retry once (1/3), then immediately exit on near-duplicate "15초" response.
        const warnings = events.filter((e) => e.type === "runtime.warning");
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0]?.payload.message, "조기 종료 감지 → 자동 계속 실행 (1/3)");

        const promptsRaw = yield* Effect.promise(() => NodeFSP.readFile(promptLogPath, "utf8"));
        const prompts = yield* decodeStringArray(promptsRaw);
        assert.equal(prompts.length, 2);

        yield* adapter.stopSession(threadId);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      }
    }),
  );

  it.effect(
    "continues when plan entries remain in_progress and sends conditional repair prompt",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-acp-stop-plan-")),
        );
        try {
          const promptLogPath = NodePath.join(directory, "prompts-plan.json");
          const promptLogLiteral = yield* encodeString(promptLogPath);
          const binaryPath = yield* writeMockLauncher(
            NodePath.join(directory, "fake-gemini-stop-plan.mjs"),
            `import * as fs from "node:fs";
import * as readline from "node:readline";

const logPath = ${promptLogLiteral};
const receivedPrompts = [];
let callIndex = 0;
const modelConfigOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "composer-2",
    options: [{ value: "composer-2", name: "Composer 2" }],
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (req.method === "session/new") {
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "guard-plan-1", configOptions: modelConfigOptions } });
    return;
  }
  if (req.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: req.id, result: { configOptions: modelConfigOptions } });
    return;
  }
  if (req.method === "session/prompt") {
    callIndex += 1;
    const text = (req.params?.prompt ?? []).map((p) => p.text ?? "").join("");
    receivedPrompts.push(text);
    fs.writeFileSync(logPath, JSON.stringify(receivedPrompts), "utf8");
    if (callIndex === 1) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "guard-plan-1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "코드 수정", priority: "high", status: "completed" },
              { content: "테스트 검증", priority: "high", status: "in_progress" },
            ],
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "guard-plan-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "코드 수정을 마쳤습니다." },
          },
        },
      });
      send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "guard-plan-1",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "코드 수정", priority: "high", status: "completed" },
            { content: "테스트 검증", priority: "high", status: "completed" },
          ],
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "guard-plan-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "테스트 검증까지 모두 완료했습니다." },
        },
      },
    });
    send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
  }
});
`,
          );

          const settings = yield* decodeSettings({ binaryPath });
          const adapter = yield* makeGeminiAdapter(settings);
          const threadId = ThreadId.make("gemini-stop-guard-incomplete-plan");
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("gemini"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );

          yield* adapter.sendTurn({
            threadId,
            input: "수정 후 테스트까지 완료해줘",
            attachments: [],
          });
          const events = yield* Fiber.join(eventsFiber);

          const warnings = events.filter((e) => e.type === "runtime.warning");
          assert.equal(warnings.length, 1);
          assert.equal(warnings[0]?.payload.message, "조기 종료 감지 → 자동 계속 실행 (1/3)");

          const promptsRaw = yield* Effect.promise(() => NodeFSP.readFile(promptLogPath, "utf8"));
          const prompts = yield* decodeStringArray(promptsRaw);
          assert.equal(prompts.length, 2);
          assert.include(prompts[1] ?? "", "이미 모든 작업·검증을 마쳤다면");

          yield* adapter.stopSession(threadId);
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }),
  );

  it.effect(
    "places t3-code first, passes native _meta.antigravity.systemPrompt.append, and auto-reconnects t3-code-only on dropped t3-code tool refusal",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-acp-mcp-recovery-")),
        );
        const threadId = ThreadId.make("gemini-t3-mcp-auto-recovery");
        try {
          const eventLogPath = NodePath.join(directory, "acp-events.json");
          const eventLogLiteral = yield* encodeString(eventLogPath);
          const binaryPath = yield* writeMockLauncher(
            NodePath.join(directory, "fake-gemini-mcp-recovery.mjs"),
            `import * as fs from "node:fs";
import * as readline from "node:readline";

const logPath = ${eventLogLiteral};
function appendLog(entry) {
  let records = [];
  if (fs.existsSync(logPath)) {
    try { records = JSON.parse(fs.readFileSync(logPath, "utf8")); } catch {}
  }
  records.push(entry);
  fs.writeFileSync(logPath, JSON.stringify(records), "utf8");
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

let isRecoveredSession = false;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
        },
      },
    });
    return;
  }
  if (req.method === "session/new" || req.method === "session/load") {
    isRecoveredSession = req.method === "session/load";
    appendLog({
      method: req.method,
      mcpNames: (req.params?.mcpServers ?? []).map((s) => s.name),
      systemPromptAppend: req.params?._meta?.antigravity?.systemPrompt?.append ?? null,
    });
    const configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "composer-2",
        options: [{ value: "composer-2", name: "Composer 2" }],
      },
    ];
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { sessionId: req.params?.sessionId ?? "t3-recovery-session-1", configOptions },
    });
    return;
  }
  if (req.method === "session/set_config_option") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "composer-2",
            options: [{ value: "composer-2", name: "Composer 2" }],
          },
        ],
      },
    });
    return;
  }
  if (req.method === "session/prompt") {
    const text = (req.params?.prompt ?? []).map((p) => p.text ?? "").join("");
    appendLog({ method: "session/prompt", isRecoveredSession, text });
    if (!isRecoveredSession) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "t3-recovery-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-preview-open-drop",
            kind: "execute",
            status: "failed",
            title: "Run call_mcp_tool",
            rawOutput:
              "declaring permissions: model output error: invalid tool call error (invalid_args) tool preview_open is not enabled for server t3-code",
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "t3-recovery-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "권한 경계상 preview_open을 켤 수 없어요. T3 UI 도구 & 지식에서 직접 켜고 새 대화로 넘겨 주세요.",
            },
          },
        },
      });
      send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "t3-recovery-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "복구된 t3-code preview_open으로 작업을 정상 완료했습니다.",
          },
        },
      },
    });
    send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
  }
});
`,
          );

          McpProviderSession.setMcpProviderSession({
            environmentId: "env-test" as never,
            threadId,
            providerSessionId: "ps-1",
            providerInstanceId: ProviderInstanceId.make("gemini"),
            endpoint: "http://127.0.0.1:13773/mcp",
            authorizationHeader: "Bearer test-token",
          });

          const settings = yield* decodeSettings({ binaryPath });
          const adapter = yield* makeGeminiAdapter(settings);
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("gemini"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            globalSystemInstructions: "GLOBAL_CONTRACT_MARKER",
          });

          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );

          yield* adapter.sendTurn({
            threadId,
            input: "유튜브에 올려줘",
            attachments: [],
          });
          const events = yield* Fiber.join(eventsFiber);

          const completed = events.find((e) => e.type === "turn.completed");
          assert.equal(completed?.payload.state, "completed");

          const recoveryWarning = events.find(
            (e) =>
              e.type === "runtime.warning" &&
              (e.payload.detail as { kind?: string } | undefined)?.kind ===
                "t3-mcp-tool-auto-recovery",
          );
          assert.isDefined(recoveryWarning);

          const allText = events
            .filter((e) => e.type === "content.delta")
            .map((e) => e.payload.delta)
            .join("");
          assert.include(allText, "복구된 t3-code preview_open으로 작업을 정상 완료했습니다.");

          const acpEventsRaw = yield* Effect.promise(() => NodeFSP.readFile(eventLogPath, "utf8"));
          const acpEvents = JSON.parse(acpEventsRaw) as Array<{
            method: string;
            mcpNames?: string[];
            systemPromptAppend?: string | null;
            isRecoveredSession?: boolean;
            text?: string;
          }>;
          const initialNew = acpEvents.find((e) => e.method === "session/new");
          assert.equal(initialNew?.mcpNames?.[0], "t3-code");
          assert.include(initialNew?.systemPromptAppend ?? "", "GLOBAL_CONTRACT_MARKER");
          assert.include(initialNew?.systemPromptAppend ?? "", "<t3_tool_execution_discipline>");

          const recoveredLoad = acpEvents.find((e) => e.method === "session/load");
          assert.deepEqual(recoveredLoad?.mcpNames, ["t3-code"]);

          const recoveredPrompt = acpEvents.find(
            (e) => e.method === "session/prompt" && e.isRecoveredSession === true,
          );
          assert.include(recoveredPrompt?.text ?? "", "mcp_t3-code_preview_open");

          yield* adapter.stopSession(threadId);
        } finally {
          McpProviderSession.clearMcpProviderSession(threadId);
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }),
  );
});
