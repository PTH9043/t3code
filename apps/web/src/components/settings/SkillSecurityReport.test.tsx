import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { SkillSecurityReportView } from "./SkillSecurityReport";

it("shows the finding location and incomplete reasons without claiming safety", () => {
  const html = renderToStaticMarkup(
    <SkillSecurityReportView
      report={{
        version: 1,
        complete: false,
        scannedFiles: 1,
        findings: [{ kind: "download-execution", file: "scripts/run.sh", line: 3 }],
        skipped: [{ reason: "symlink", file: "linked" }],
      }}
    />,
  );
  expect(html).toContain("검사 불완전");
  expect(html).toContain("다운로드 후 명령 실행 패턴");
  expect(html).toContain("scripts/run.sh:3");
  expect(html).toContain("심링크를 따라가지 않음");
  expect(html).toContain("안전을 보장하지 않습니다");
});

it("distinguishes an older unscanned skill from a complete scan with no findings", () => {
  expect(renderToStaticMarkup(<SkillSecurityReportView report={undefined} />)).toContain(
    "검사 기록이 없습니다",
  );
  const html = renderToStaticMarkup(
    <SkillSecurityReportView
      report={{ version: 1, complete: true, scannedFiles: 1, findings: [], skipped: [] }}
    />,
  );
  expect(html).toContain("검사 완료");
  expect(html).toContain("0개 징후");
});
