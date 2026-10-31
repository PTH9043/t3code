import { expect, it } from "vite-plus/test";
import {
  formatDevelopmentVerificationCommands,
  parseDevelopmentVerificationCommands,
  parseDevelopmentTokenBudget,
} from "./workspaceDevelopmentSettings";

it("accepts real commands one per line, including quoted paths and empty arguments", () => {
  expect(
    parseDevelopmentVerificationCommands('vp test run "src/test file.ts"\n\nnode --test ""'),
  ).toEqual([
    { command: "vp", args: ["test", "run", "src/test file.ts"] },
    { command: "node", args: ["--test", ""] },
  ]);
});

it("accepts an unset budget and positive safe integers and rejects invalid limits", () => {
  expect(parseDevelopmentTokenBudget("  ")).toBeNull();
  expect(parseDevelopmentTokenBudget("250000")).toBe(250000);
  for (const value of ["0", "-1", "1.5", "abc", "Infinity", "9007199254740992"])
    expect(() => parseDevelopmentTokenBudget(value)).toThrow();
});

it("round trips saved Windows paths, quotes and arguments without changing execution", () => {
  const commands = [
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["--test", "D:\\repo\\some file.test.ts", 'a"b', "", "a'b"],
    },
  ];
  expect(
    parseDevelopmentVerificationCommands(formatDevelopmentVerificationCommands(commands)),
  ).toEqual(commands);
  expect(parseDevelopmentVerificationCommands("")).toEqual([]);
});

it("rejects more than eight verification commands before sending configuration", () => {
  expect(() =>
    parseDevelopmentVerificationCommands(Array(9).fill("node --test").join("\n")),
  ).toThrow();
});
