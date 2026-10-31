import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { OrchestraNodeUsage } from "./OrchestraNodeUsage";

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => {
    throw new Error("Collapsed rows must not query token usage");
  },
}));

it("defers the per-node query until its usage disclosure is explicitly opened", () => {
  const markup = renderToStaticMarkup(
    <OrchestraNodeUsage
      environmentId={EnvironmentId.make("environment")}
      threadId={ThreadId.make("thread")}
      runId="run"
      nodeId="node"
      busy={false}
    />,
  );
  expect(markup).toContain("이 단계의 토큰 사용량 보기");
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain("잠정 집계");
});
