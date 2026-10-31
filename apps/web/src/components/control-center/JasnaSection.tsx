import type {
  DesktopJasnaBridge,
  DesktopJasnaJob,
  DesktopJasnaModel,
  DesktopJasnaSnapshot,
} from "@t3tools/contracts";
import { FilmIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "../ui/card";

const active = (job: DesktopJasnaJob) =>
  job.status === "starting" || job.status === "running" || job.status === "cancelling";

function statusLabel(status: DesktopJasnaJob["status"]): string {
  switch (status) {
    case "starting":
      return "시작 중";
    case "running":
      return "복원 중";
    case "cancelling":
      return "중지 중";
    case "completed":
      return "완료";
    case "failed":
      return "실패";
    case "cancelled":
      return "중지됨";
  }
}

export function JasnaSection() {
  const bridge: DesktopJasnaBridge | undefined =
    typeof window === "undefined" ? undefined : window.desktopBridge?.jasna;
  const [snapshot, setSnapshot] = useState<DesktopJasnaSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<DesktopJasnaModel | "">("");
  const generation = useRef(0);
  const busyRef = useRef(false);

  const run = useCallback(async (action: () => Promise<DesktopJasnaSnapshot>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const value = await action();
      if (request === generation.current) setSnapshot(value);
    } catch (cause) {
      if (request === generation.current) {
        setError(cause instanceof Error ? cause.message : "영상 복원 요청을 처리하지 못했습니다.");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    const request = ++generation.current;
    void bridge.snapshot().then(
      (value) => {
        if (mounted && request === generation.current) setSnapshot(value);
      },
      (cause: unknown) => {
        if (mounted && request === generation.current)
          setError(
            cause instanceof Error ? cause.message : "영상 복원 상태를 불러오지 못했습니다.",
          );
      },
    );
    return () => {
      mounted = false;
    };
  }, [bridge]);

  const hasActiveJobs = snapshot?.jobs.some(active) ?? false;
  useEffect(() => {
    if (!bridge || !hasActiveJobs) return;
    let mounted = true;
    let pending = false;
    const refresh = () => {
      if (busyRef.current || pending) return;
      pending = true;
      const request = ++generation.current;
      void bridge
        .snapshot()
        .then(
          (value) => {
            if (mounted && request === generation.current) setSnapshot(value);
          },
          (cause: unknown) => {
            if (mounted && request === generation.current)
              setError(
                cause instanceof Error ? cause.message : "영상 복원 상태를 불러오지 못했습니다.",
              );
          },
        )
        .finally(() => {
          pending = false;
        });
    };
    const timer = window.setInterval(refresh, 1_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [bridge, hasActiveJobs]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FilmIcon className="size-4" />
          영상 복원
        </CardTitle>
        <CardDescription>
          Jasna로 이 컴퓨터의 영상을 복원합니다. 원본은 그대로 두고 새 파일로 저장합니다.
        </CardDescription>
      </CardHeader>
      <CardPanel className="grid gap-4">
        {!bridge ? (
          <p className="text-sm text-muted-foreground">
            영상 복원은 Jasna가 설치된 데스크톱 앱에서 사용할 수 있습니다.
          </p>
        ) : (
          <>
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(bridge.pickExecutable)}
                >
                  Jasna 실행 파일 선택
                </Button>
                <span className="min-w-0 break-all text-sm">
                  {snapshot?.executablePath ?? "선택하지 않음"}
                </span>
                {snapshot?.executablePath ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(bridge.clearExecutable)}
                  >
                    선택 해제
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(bridge.pickInput)}
                >
                  입력 영상 선택
                </Button>
                <span className="min-w-0 break-all text-sm">
                  {snapshot?.inputPath ?? "선택하지 않음"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(bridge.pickOutput)}
                >
                  저장할 파일 선택
                </Button>
                <span className="min-w-0 break-all text-sm">
                  {snapshot?.outputPath ?? "선택하지 않음"}
                </span>
              </div>
            </div>
            <label className="grid gap-1 text-sm">
              복원 모델
              <select
                className="w-full max-w-sm rounded-md border border-input bg-background px-3 py-2"
                value={model}
                onChange={(event) => setModel(event.currentTarget.value as DesktopJasnaModel | "")}
              >
                <option value="">Jasna 기본 설정</option>
                <option value="basicvsrpp">BasicVSR++</option>
                <option value="ltx">LTX Standard</option>
                <option value="ltx-4step">LTX Good</option>
                <option value="ltx-8step">LTX High</option>
                <option value="ltx-undistilled">LTX Top</option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              이미 있는 파일은 덮어쓰지 않습니다. LTX 모델은 Jasna 후원 라이선스와 모델 파일이
              필요합니다. 첫 실행은 GPU 준비로 오래 걸릴 수 있습니다.
            </p>
            <div>
              <Button
                size="sm"
                disabled={
                  busy || !snapshot?.executablePath || !snapshot.inputPath || !snapshot.outputPath
                }
                onClick={() => {
                  if (!snapshot?.executablePath || !snapshot.inputPath || !snapshot.outputPath)
                    return;
                  const selection = {
                    executablePath: snapshot.executablePath,
                    inputPath: snapshot.inputPath,
                    outputPath: snapshot.outputPath,
                    model: model || null,
                  };
                  void run(() => bridge.start(selection));
                }}
              >
                복원 시작
              </Button>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {snapshot?.jobs.map((job) => (
              <div key={job.id} className="grid gap-2 rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{statusLabel(job.status)}</strong>
                  {active(job) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || job.status === "cancelling"}
                      onClick={() => void run(() => bridge.cancel(job.id))}
                    >
                      중지
                    </Button>
                  ) : null}
                </div>
                <div className="break-all text-muted-foreground">{job.outputPath}</div>
                <div className="text-muted-foreground">모델: {job.model ?? "Jasna 기본 설정"}</div>
                {job.error ? <p className="text-destructive">{job.error}</p> : null}
                {job.logTail ? (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs">
                    {job.logTail}
                  </pre>
                ) : null}
              </div>
            ))}
          </>
        )}
      </CardPanel>
    </Card>
  );
}
