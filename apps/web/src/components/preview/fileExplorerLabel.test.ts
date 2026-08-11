import { describe, expect, it } from "vite-plus/test";

import { revealInFileExplorerLabel } from "./fileExplorerLabel";

describe("revealInFileExplorerLabel", () => {
  it.each([
    ["MacIntel", "Finder에서 보기"],
    ["Win32", "파일 탐색기에서 보기"],
    ["Linux x86_64", "파일 앱에서 보기"],
  ])("maps %s to %s", (platform, expected) => {
    expect(revealInFileExplorerLabel(platform)).toBe(expected);
  });
});
