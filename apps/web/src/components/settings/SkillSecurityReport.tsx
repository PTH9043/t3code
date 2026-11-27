import type { SkillSecurityReport } from "@t3tools/contracts";

const findingLabels: Record<SkillSecurityReport["findings"][number]["kind"], string> = {
  "instruction-override": "기존 지시 무시 문구",
  "hidden-text": "숨김 또는 방향 제어 문자",
  "download-execution": "다운로드 후 명령 실행 패턴",
  "credential-access": "인증정보 접근 패턴",
  "credential-network": "인증정보 접근과 네트워크 사용이 같은 파일에 있음",
  "embedded-secret": "인증정보처럼 보이는 값",
  "encoded-execution": "인코딩된 내용의 실행 패턴",
  "permission-change": "권한 검사 우회 설정 패턴",
};
const skipLabels: Record<SkillSecurityReport["skipped"][number]["reason"], string> = {
  symlink: "심링크를 따라가지 않음",
  "non-regular": "일반 파일이 아니거나 하드링크임",
  "too-large": "파일 크기 제한 초과",
  "file-limit": "파일 수 제한 초과",
  "total-limit": "전체 크기 제한 초과",
  "depth-limit": "폴더 깊이 제한 초과",
  unreadable: "읽을 수 없음",
  encoding: "텍스트 인코딩을 확인할 수 없음",
  changed: "읽는 동안 파일이 변경됨",
  "finding-limit": "검출 결과 수 제한 초과",
  "line-limit": "줄 수 제한 초과",
  "line-length": "한 줄의 크기 제한 초과",
  "scan-error": "검사를 완료하지 못함",
};

export function SkillSecurityReportView({ report }: { report: SkillSecurityReport | undefined }) {
  if (!report)
    return (
      <p className="mt-2 text-xs text-muted-foreground">설치 당시 보안 검사 기록이 없습니다.</p>
    );
  const group = <T,>(items: ReadonlyArray<T>) => {
    const counts = new Map<string, { item: T; count: number }>();
    for (const item of items) {
      const key = JSON.stringify(item);
      const previous = counts.get(key);
      counts.set(key, { item, count: (previous?.count ?? 0) + 1 });
    }
    return [...counts.entries()];
  };
  return (
    <details className="mt-2 text-xs" open={!report.complete || report.findings.length > 0}>
      <summary className="cursor-pointer font-medium">
        설치·업데이트 당시 정적 검사 · {report.complete ? "검사 완료" : "검사 불완전"} ·{" "}
        {report.findings.length}개 징후
      </summary>
      <p className="mt-1 text-muted-foreground">
        {report.scannedFiles}개 파일을 명령 실행 없이 확인했습니다. 징후는 위험을 확정하지 않으며,
        결과가 없어도 안전을 보장하지 않습니다.
      </p>
      {report.findings.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {group(report.findings).map(([key, { item: finding, count }]) => (
            <li key={key}>
              {findingLabels[finding.kind]} ·{" "}
              <span className="break-all">
                {finding.file}:{finding.line}
              </span>
              {count > 1 ? ` · 같은 표시 ${count}건` : null}
            </li>
          ))}
        </ul>
      ) : null}
      {report.skipped.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
          {group(report.skipped).map(([key, { item, count }]) => (
            <li key={key}>
              {skipLabels[item.reason]} · <span className="break-all">{item.file}</span>
              {count > 1 ? ` · 같은 표시 ${count}건` : null}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
