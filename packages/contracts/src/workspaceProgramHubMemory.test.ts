import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
  OrchestrationCommand,
  WorkspaceProgram,
} from "./orchestration.ts";

const decodeCommand = Schema.decodeUnknownSync(OrchestrationCommand);
const decodeProgram = Schema.decodeUnknownSync(WorkspaceProgram);
const command = {
  type: "project.program.upsert",
  commandId: "hub-save",
  projectId: "project",
  programId: "program",
  name: "Research",
  command: "python run.py",
  relativeDirectory: "",
  environmentVariableNames: [],
  startPolicy: "manual",
  healthCheck: null,
  errorPatterns: [],
  enabled: true,
  createdAt: "2026-09-12T00:00:00.000Z",
};

it("keeps older client commands and program snapshots readable", () => {
  expect(decodeCommand(command).type).toBe("project.program.upsert");
  expect(
    decodeProgram({ ...command, id: command.programId, updatedAt: command.createdAt }).hubMemory,
  ).toEqual(DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY);
});

it("accepts a group with the default slot count", () => {
  expect(
    decodeCommand({
      ...command,
      hubMemory: { ...DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY, concurrencyGroup: "research" },
    }),
  ).toMatchObject({ hubMemory: { concurrencyGroup: "research", concurrencySlots: null } });
});

it.each([
  { concurrencySlots: 2 },
  { commitLimitMb: 0 },
  { sharedDatasets: [{ name: "DATA", relativeSource: "../outside.arrow" }] },
  {
    sharedDatasets: [
      { name: "DATA", relativeSource: "one.arrow" },
      { name: "DATA", relativeSource: "two.arrow" },
    ],
  },
])("rejects invalid hub settings from API clients: %j", (hubMemory) => {
  expect(() =>
    decodeCommand({
      ...command,
      hubMemory: { ...DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY, ...hubMemory },
    }),
  ).toThrow();
});
