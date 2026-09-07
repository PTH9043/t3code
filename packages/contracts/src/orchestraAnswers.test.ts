import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ClientOrchestrationCommand,
  ProjectCollaborationRunAnsweredPayload,
} from "./orchestration.ts";
import { WorkspaceTaskNodeId } from "./baseSchemas.ts";

const decodeCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeAnswerEvent = Schema.decodeUnknownEffect(ProjectCollaborationRunAnsweredPayload);
const at = "2026-09-07T00:00:00.000Z";
const command = {
  type: "project.collaboration.run.answer",
  commandId: "answer-a",
  runId: "run-a",
  projectId: "project-a",
  question: "계속할까요?",
  answer: "계속",
  createdAt: at,
};

it.effect("requires question identity on new commands while accepting meeting-wide questions", () =>
  Effect.gen(function* () {
    assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeCommand(command))));
    for (const nodeId of ["node-a", null]) {
      const questionRef = { nodeId, askedAt: at };
      const parsed = yield* decodeCommand({ ...command, questionRef });
      assert.strictEqual(parsed.type, "project.collaboration.run.answer");
      if (parsed.type === "project.collaboration.run.answer") {
        assert.deepStrictEqual(parsed.questionRef, questionRef);
      }
    }
  }),
);

it.effect("retains question identity on new events and decodes legacy history without it", () =>
  Effect.gen(function* () {
    const event = {
      runId: command.runId,
      projectId: command.projectId,
      question: command.question,
      answer: command.answer,
      answeredAt: at,
    };
    assert.isUndefined((yield* decodeAnswerEvent(event)).questionRef);
    const questionRef = { nodeId: WorkspaceTaskNodeId.make("node-a"), askedAt: at };
    assert.deepStrictEqual(
      (yield* decodeAnswerEvent({ ...event, questionRef })).questionRef,
      questionRef,
    );
  }),
);
