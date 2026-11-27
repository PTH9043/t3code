import { describe, expect, it } from "vite-plus/test";
import { ACTIVITY_TEXT_LIMIT, compactActivityData } from "./activityDataCompaction.ts";

describe("compactActivityData", () => {
  it("returns the same value when nothing is over the limits", () => {
    const data = {
      toolName: "Bash",
      input: { command: "ls" },
      item: { aggregatedOutput: "x".repeat(ACTIVITY_TEXT_LIMIT), changes: [{ path: "a.ts" }] },
    };
    expect(compactActivityData(data)).toBe(data);
  });

  it("keeps the start and end of long text and says how much was dropped", () => {
    const output = `START${"x".repeat(1_000_000)}END`;
    const data = { item: { type: "commandExecution", command: "build", aggregatedOutput: output } };
    const compacted = compactActivityData(data) as typeof data;

    expect(compacted.item.command).toBe("build");
    expect(compacted.item.type).toBe("commandExecution");
    expect(compacted.item.aggregatedOutput.length).toBeLessThan(ACTIVITY_TEXT_LIMIT);
    expect(compacted.item.aggregatedOutput.startsWith("START")).toBe(true);
    expect(compacted.item.aggregatedOutput.endsWith("END")).toBe(true);
    expect(compacted.item.aggregatedOutput).toContain("…[998,472자 생략]…");
    expect(data.item.aggregatedOutput).toBe(output);
  });

  it("shrinks text nested in MCP result blocks without touching small fields", () => {
    const data = {
      item: {
        tool: "read_text_file",
        arguments: { path: "notes.md" },
        result: { content: [{ type: "text", text: "y".repeat(50_000) }], isError: false },
      },
    };
    const compacted = compactActivityData(data) as typeof data;

    expect(compacted.item.arguments).toBe(data.item.arguments);
    expect(compacted.item.result.isError).toBe(false);
    expect(compacted.item.result.content[0]!.type).toBe("text");
    expect(compacted.item.result.content[0]!.text.length).toBeLessThan(ACTIVITY_TEXT_LIMIT);
  });

  it("keeps commands and tool arguments the work log shows up to the larger input limit", () => {
    const script = `cat <<'EOF'\n${"line\n".repeat(2_000)}EOF`;
    const data = {
      item: { command: script, arguments: { code: script }, aggregatedOutput: script },
      input: { command: script },
    };
    const compacted = compactActivityData(data) as typeof data;

    expect(compacted.item.command).toBe(script);
    expect(compacted.item.arguments).toBe(data.item.arguments);
    expect(compacted.input).toBe(data.input);
    expect(compacted.item.aggregatedOutput.length).toBeLessThan(ACTIVITY_TEXT_LIMIT);

    const huge = compactActivityData({ item: { command: "c".repeat(1_000_000) } }) as {
      item: { command: string };
    };
    expect(huge.item.command.length).toBeLessThan(16_384);
    expect(huge.item.command).toContain("자 생략]…");
  });

  it("keeps the first and last entries of a long list", () => {
    const output = Array.from({ length: 1_000 }, (_, index) => `chunk-${index}`);
    const compacted = compactActivityData({ rawOutput: { output } }) as {
      rawOutput: { output: string[] };
    };

    expect(compacted.rawOutput.output).toHaveLength(41);
    expect(compacted.rawOutput.output[0]).toBe("chunk-0");
    expect(compacted.rawOutput.output[16]).toBe("…[960개 항목 생략]…");
    expect(compacted.rawOutput.output.at(-1)).toBe("chunk-999");
  });

  it("changes nothing when run again on its own output", () => {
    const once = compactActivityData({
      result: "z".repeat(10_000),
      output: Array.from({ length: 200 }, () => "line"),
    });
    expect(compactActivityData(once)).toBe(once);
  });
});
