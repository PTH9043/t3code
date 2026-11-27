// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventId, ThreadId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { buildToolActivityFacts, groupToolActivities } from "@t3tools/shared/toolActivity";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { projectActivityPayload, projectThreadActivities } from "./ActivityPayloadProjection.ts";
import { recoverSavedToolActivityEvidence } from "./SavedToolActivityEvidence.ts";

const thread = ThreadId.make("room-a"),
  turn = TurnId.make("turn-a");
const stamp = "2025-10-01T10:00:00.000Z";
const privateText = "private-fixture-content".repeat(500);
function row(id: string, kind: string, payload = {}): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    tone: "tool",
    turnId: turn,
    summary: "Bash",
    createdAt: stamp,
    payload: { itemType: "command_execution", title: "Bash", ...payload },
  };
}
function canon(eventId: string, type: string, itemId: string, instance = "account-a") {
  return {
    eventId,
    type,
    itemId,
    threadId: thread,
    turnId: turn,
    provider: "claudeAgent",
    providerInstanceId: instance,
    raw: { payload: { session_id: "session-a", parent_tool_use_id: null } },
    payload: { unused: privateText },
  };
}
function native(model: string, session = "session-a", parent: string | null = null) {
  return {
    event: {
      turnId: turn,
      provider: "claudeAgent",
      payload: {
        type: "assistant",
        session_id: session,
        parent_tool_use_id: parent,
        message: {
          role: "assistant",
          model,
          content: [
            { type: "tool_use", id: "call-a", name: "Bash", input: { command: privateText } },
          ],
        },
      },
    },
  };
}
const line = (kind: string, body: unknown) => `[${stamp}] ${kind}: ${JSON.stringify(body)}\n`;

describe("historical tool evidence", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "t3-saved-tool-evidence-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("joins only exact room, turn, event, parent, native session and call identities across rotation", async () => {
    await writeFile(
      join(dir, "events.room-a.log"),
      line("NTIVE", native("issuing-model")) +
        line("NTIVE", native("other-parent", "session-a", "other")) +
        line("NTIVE", native("other-session", "session-b")),
    );
    await writeFile(
      join(dir, "events.room-a.log.1"),
      line("CANON", canon("start", "item.started", "call-a")) +
        line("CANON", canon("end", "item.completed", "call-a")) +
        line("CANON", { ...canon("orphan", "item.updated", "wrong"), threadId: "room+a" }) +
        line("CANON", { ...canon("orphan", "item.updated", "wrong"), turnId: "other-turn" }),
    );
    const input = [
      row("start", "tool.started"),
      row("orphan", "tool.updated"),
      row("receipt", "tool.updated", {
        data: { result: { type: "tool_result", tool_use_id: "call-a", content: privateText } },
      }),
      row("end", "tool.completed"),
    ];
    const saved = await recoverSavedToolActivityEvidence(dir, thread, input);
    for (const index of [0, 2, 3])
      expect(saved[index]?.payload).toMatchObject({
        toolCallId: "call-a",
        reportedModel: "issuing-model",
        provider: "claudeAgent",
        providerInstanceId: "account-a",
      });
    expect(saved[1]).toBe(input[1]);
    const snapshot = projectThreadActivities(saved),
      live = saved.map(projectActivityPayload);
    const groups = groupToolActivities(snapshot);
    expect(groups.map((g) => g.eventIds)).toEqual([["start", "receipt", "end"], ["orphan"]]);
    expect(groups[0]?.executorSource).toBe("provider-reported");
    expect(buildToolActivityFacts(groups)).toEqual(
      buildToolActivityFacts(groupToolActivities(live)),
    );
    expect(JSON.stringify(snapshot)).not.toContain(privateText);
    expect(JSON.stringify(live)).not.toContain(privateText);
    expect(input[0]?.payload).not.toHaveProperty("toolCallId");
  });
  it("leaves conflicting issuers and provider-account collisions unresolved", async () => {
    await writeFile(
      join(dir, "events.room-a.log"),
      line("CANON", canon("first", "item.started", "call-a")) +
        line("CANON", canon("second", "item.started", "call-a", "account-b")) +
        line("NTIVE", native("first-model")) +
        line("NTIVE", native("different-model")),
    );
    const saved = await recoverSavedToolActivityEvidence(dir, thread, [
      row("first", "tool.started"),
      row("second", "tool.started"),
      row("unscoped", "tool.updated", {
        data: { result: { type: "tool_result", tool_use_id: "call-a" } },
      }),
    ]);
    expect(saved[0]?.payload).not.toHaveProperty("reportedModel");
    expect(saved[2]?.payload).toHaveProperty("toolCallIdAmbiguous", true);
    expect(groupToolActivities(projectThreadActivities(saved)).map((g) => g.callId)).toEqual([
      "call-a",
      "call-a",
      null,
    ]);
  });
  it("returns saved rows when the scoped log directory cannot be traversed", async () => {
    const file = join(dir, "ordinary-file");
    await writeFile(file, "x");
    const input = [row("legacy", "tool.started")];
    expect(await recoverSavedToolActivityEvidence(file, thread, input)).toEqual(input);
  });
});
