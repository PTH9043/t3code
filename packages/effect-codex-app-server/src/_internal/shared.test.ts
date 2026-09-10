import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CodexRpc from "../_generated/meta.gen.ts";
import * as CodexError from "../errors.ts";
import * as Shared from "./shared.ts";

const decodeNestedNumberPayload = Schema.decodeUnknownEffect(
  Schema.Struct({ profile: Schema.Struct({ token: Schema.Number }) }),
);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("decodes completed sub-agent activity from resumed thread history", () =>
  Effect.gen(function* () {
    const response = yield* Shared.decodeOptionalPayload(
      "thread/resume",
      CodexRpc.CLIENT_REQUEST_RESPONSES["thread/resume"],
      {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: "C:\\workspace",
        model: "gpt-5.6-codex",
        modelProvider: "openai",
        sandbox: { type: "dangerFullAccess" },
        thread: {
          cliVersion: "0.150.1",
          createdAt: 1,
          cwd: "C:\\workspace",
          ephemeral: false,
          id: "provider-thread-1",
          modelProvider: "openai",
          preview: "Resume a thread with completed sub-agent activity",
          sessionId: "session-1",
          source: "appServer",
          status: { type: "idle" },
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  agentPath: "/root/reviewer",
                  agentThreadId: "provider-child-thread-1",
                  id: "subagent-completed-1",
                  kind: "completed",
                  type: "subAgentActivity",
                },
              ],
              status: "completed",
            },
          ],
          updatedAt: 2,
        },
      },
    );

    const item = response.thread.turns[0]?.items[0];
    assert.equal(item?.type, "subAgentActivity");
    if (item?.type === "subAgentActivity") {
      assert.equal(item.kind, "completed");
    }
  }),
);

it.effect("preserves schema decode diagnostics without deriving the message from the cause", () =>
  Effect.gen(function* () {
    const error = yield* Shared.decodeOptionalPayload("thread/start", Schema.String, 42).pipe(
      Effect.flip,
    );

    assert.instanceOf(error, CodexError.CodexAppServerRequestError);
    assert.equal(error.code, -32602);
    assert.equal(error.method, "thread/start");
    assert.equal(error.operation, "decode-payload");
    assert.equal(
      error.message,
      "Invalid payload for method 'thread/start' during 'decode-payload'",
    );
    assert.isTrue(Schema.isSchemaError(error.cause));

    const protocolError = error.toProtocolError();
    assert.equal(protocolError.code, -32602);
    assert.equal(protocolError.message, error.message);
    assert.property(protocolError, "data");
    assert.notProperty(protocolError, "method");
    assert.notProperty(protocolError, "operation");
    assert.notProperty(protocolError, "cause");
  }),
);

it.effect("preserves schema encode diagnostics", () =>
  Effect.gen(function* () {
    const error = yield* Shared.encodeOptionalPayload(
      "thread/start",
      Schema.Number,
      "not-a-number" as never,
    ).pipe(Effect.flip);

    assert.equal(error.method, "thread/start");
    assert.equal(error.operation, "encode-payload");
    assert.equal(
      error.message,
      "Invalid payload for method 'thread/start' during 'encode-payload'",
    );
    assert.isTrue(Schema.isSchemaError(error.cause));
  }),
);

it.effect("does not invent a cause when a method has no payload schema", () =>
  Effect.gen(function* () {
    const secret = "unexpected-payload-secret";
    const error = yield* Shared.decodeOptionalPayload<never, never>("initialized", undefined, {
      token: secret,
    }).pipe(Effect.flip);

    assert.equal(error.method, "initialized");
    assert.equal(error.operation, "decode-payload");
    assert.equal(error.payloadKind, "object");
    assert.deepEqual(error.data, { payloadKind: "object" });
    assert.isUndefined(error.cause);
    assert.notInclude(error.message, secret);
    assert.notInclude(encodeUnknownJson(error.toProtocolError()), secret);
  }),
);

it.effect("keeps invalid payload values only in the exact schema cause", () =>
  Effect.gen(function* () {
    const secret = "codex-schema-payload-secret";
    const cause = yield* decodeNestedNumberPayload({ profile: { token: secret } }).pipe(
      Effect.flip,
    );
    const error = CodexError.CodexAppServerRequestError.invalidPayload(
      "thread/start",
      "decode-payload",
      cause,
    );
    const { cause: directCause, ...directDiagnostics } = error;

    assert.strictEqual(directCause, cause);
    assert.equal(error.method, "thread/start");
    assert.equal(error.operation, "decode-payload");
    assert.equal(error.maximumPathDepth, 2);
    assert.isAbove(error.issueCount ?? 0, 0);
    assert.include(error.issueKinds ?? [], "Pointer");
    assert.notInclude(error.message, secret);
    assert.notInclude(encodeUnknownJson(directDiagnostics), secret);
    assert.notInclude(encodeUnknownJson(error.toProtocolError()), secret);
  }),
);

it.effect("retains the request-handler error as the internal error cause", () =>
  Effect.gen(function* () {
    const rootCause = new Error("socket closed");
    const source = new CodexError.CodexAppServerTransportError({
      operation: "read-input-stream",
      cause: rootCause,
    });
    const error = yield* Shared.runHandler(
      (_payload: void) => Effect.fail(source),
      undefined,
      "thread/start",
    ).pipe(Effect.flip);

    assert.equal(error.code, -32603);
    assert.equal(error.method, "thread/start");
    assert.equal(error.operation, "handle-request");
    assert.equal(
      error.message,
      "Codex App Server request handler failed for method 'thread/start'",
    );
    assert.strictEqual(error.cause, source);
    assert.strictEqual(source.cause, rootCause);
    assert.notInclude(error.message, source.message);
  }),
);

it.effect("passes request errors through without adding a wrapper", () =>
  Effect.gen(function* () {
    const source = CodexError.CodexAppServerRequestError.invalidParams("Invalid thread id");
    const error = yield* Shared.runHandler(
      (_payload: void) => Effect.fail(source),
      undefined,
      "thread/start",
    ).pipe(Effect.flip);

    assert.strictEqual(error, source);
  }),
);

it.effect("retains the full notification payload decode cause chain", () =>
  Effect.gen(function* () {
    const error = yield* Shared.decodeNotificationPayload(
      "item/agentMessage/delta",
      Schema.String,
      42,
    ).pipe(Effect.flip);

    assert.equal(error.method, "item/agentMessage/delta");
    assert.equal(error.operation, "decode-notification-payload");
    assert.instanceOf(error.cause, CodexError.CodexAppServerRequestError);
    assert.isTrue(Schema.isSchemaError(error.cause.cause));
  }),
);
