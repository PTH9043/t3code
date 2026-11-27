import { describe, expect, it } from "vite-plus/test";
import { windowsAgentInstructions } from "./windowsAgentInstructions.ts";

describe("Windows agent instructions", () => {
  it("prohibits direct and indirect PowerShell use on Windows", () => {
    const instructions = windowsAgentInstructions("win32");
    expect(instructions).toContain("powershell.exe");
    expect(instructions).toContain("pwsh.exe");
    expect(instructions).toContain("간접 실행하지 마세요");
    expect(instructions).toContain("cmd.exe");
    expect(instructions).toContain("-2147024894");
    expect(instructions).toContain("workspace_launch_app");
    expect(instructions).toContain("WinSta0\\Default");
    expect(instructions).toContain("정책 거부는 우회하지 말고");
  });

  it("does not impose the Windows shell instruction on other platforms", () => {
    expect(windowsAgentInstructions("linux")).toBe("");
    expect(windowsAgentInstructions("darwin")).toBe("");
  });
});
