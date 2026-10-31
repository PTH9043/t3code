import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { WorkspacePromptTokens } from "./WorkspacePromptDiagnostics";

it("distinguishes reference input estimates, required overflow and actual usage", () => {
  const markup = renderToStaticMarkup(
    <WorkspacePromptTokens
      estimate={{
        version: 1,
        status: "estimated",
        scope: "workspace-prompt",
        encoding: "o200k_base",
        total: 1200,
        limit: 1000,
        mandatoryOverflow: 200,
        sections: { task: 500, instructions: 600, memory: 0, library: 0 },
      }}
    />,
  );
  expect(markup).toContain("1,200");
  expect(markup).toContain("선택 기억");
  expect(markup).toContain("200 토큰");
  expect(markup).toContain("선택 자료는 제외했습니다");
  expect(markup).toContain("실제 과금 토큰은 포함하지 않습니다");
});
