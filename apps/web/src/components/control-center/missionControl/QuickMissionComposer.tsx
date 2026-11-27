import type {
  MissionCreateInput,
  MissionExecutionStyle,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { PlayIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { EXECUTION_STYLE_META, QUICK_MISSION_PRESETS } from "./missionControlUi.logic";

export function QuickMissionComposer(props: {
  readonly projectId: ProjectId;
  readonly projectThreads: ReadonlyArray<{ readonly id: ThreadId; readonly title: string }>;
  readonly killSwitchActive: boolean;
  readonly busy: boolean;
  readonly onCreateMission: (input: MissionCreateInput) => Promise<void>;
}) {
  const [goalPrompt, setGoalPrompt] = useState("");
  const [doneLine, setDoneLine] = useState("");
  const [executionStyle, setExecutionStyle] = useState<MissionExecutionStyle>("hierarchical_ops");
  const [maxSteps, setMaxSteps] = useState(12);
  const [maxMinutes, setMaxMinutes] = useState(60);
  const [verificationCmdLine, setVerificationCmdLine] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string>("__new__");
  const [requireFinalApproval, setRequireFinalApproval] = useState(true);

  const handleSubmit = async () => {
    const trimmed = goalPrompt.trim();
    if (!trimmed || props.busy || props.killSwitchActive) return;
    const doneCriteria = doneLine
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const verificationCommands = verificationCmdLine
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    await props.onCreateMission({
      projectId: props.projectId,
      goalPrompt: trimmed,
      executionStyle,
      ...(executionStyle === "persistent_goal"
        ? {
            maxSteps,
            maxMinutes,
            ...(verificationCommands.length > 0 ? { verificationCommands } : {}),
          }
        : {}),
      ...(doneCriteria.length > 0 ? { doneCriteria } : {}),
      ...(selectedThreadId !== "__new__"
        ? { threadId: selectedThreadId as ThreadId, createNewThread: false }
        : { createNewThread: true }),
      requireFinalApproval,
    });
    setGoalPrompt("");
    setDoneLine("");
    setVerificationCmdLine("");
  };

  return (
    <section className="grid min-w-0 gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-center gap-2">
        <SparklesIcon className="size-4 text-primary" />
        <div>
          <h3 className="text-sm font-semibold">지시하기 · 새 자율 미션 (지속 목표 통합)</h3>
          <p className="text-[11px] text-muted-foreground">
            L0/L1 지휘 계층이 L2 실무 크루에게 작업을 배정하고 이종 교차 검수 후 보고합니다.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {(["hierarchical_ops", "persistent_goal"] as const).map((style) => {
          const meta = EXECUTION_STYLE_META[style];
          const active = executionStyle === style;
          return (
            <button
              key={style}
              type="button"
              onClick={() => setExecutionStyle(style)}
              className={`rounded-xl border p-2 text-left transition-colors ${
                active
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/80 bg-background/60 text-muted-foreground hover:bg-muted/50"
              }`}
            >
              <div className="text-[11px] font-semibold">{meta.label}</div>
              <div className="mt-0.5 line-clamp-1 text-[10px] opacity-80">{meta.hint}</div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {QUICK_MISSION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => {
              setGoalPrompt(preset.goalPrompt);
              setDoneLine(preset.doneCriteria.join(", "));
            }}
            className="rounded-full border border-border/80 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <textarea
        rows={3}
        aria-label="자율 미션 목표"
        placeholder="예: 로그인 세션 갱신 버그 원인을 분석하고 격리 워크트리에서 수정 및 테스트 통과시켜 줘."
        className="w-full resize-none rounded-xl border border-input bg-background p-2.5 text-xs leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-ring"
        value={goalPrompt}
        onChange={(e) => setGoalPrompt(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void handleSubmit();
          }
        }}
      />

      <Input
        className="h-8 text-xs"
        placeholder="완료 조건 (쉼표 구분, 선택): 예) 단위 테스트 통과, 타입 에러 0건"
        value={doneLine}
        onChange={(e) => setDoneLine(e.target.value)}
      />

      {executionStyle === "persistent_goal" ? (
        <div className="grid min-w-0 gap-2 rounded-xl border border-border/70 bg-muted/20 p-2.5">
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              <span>최대 스텝 (지속 루프)</span>
              <Input
                type="number"
                min={1}
                max={60}
                className="h-7 text-xs"
                value={maxSteps}
                onChange={(e) => setMaxSteps(Math.max(1, Number(e.target.value) || 12))}
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              <span>최대 시간 (분)</span>
              <Input
                type="number"
                min={5}
                max={480}
                className="h-7 text-xs"
                value={maxMinutes}
                onChange={(e) => setMaxMinutes(Math.max(5, Number(e.target.value) || 60))}
              />
            </label>
          </div>
          <Input
            className="h-7 text-xs"
            placeholder="자동 검증 명령 (쉼표 구분, 선택): 예) vp test, vp check"
            value={verificationCmdLine}
            onChange={(e) => setVerificationCmdLine(e.target.value)}
          />
        </div>
      ) : null}

      <div className="grid min-w-0 gap-2">
        <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
          <span>실행할 실제 대화창</span>
          <select
            aria-label="실행할 실제 대화창 선택"
            className="h-8 w-full min-w-0 truncate rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            value={selectedThreadId}
            onChange={(e) => setSelectedThreadId(e.target.value)}
          >
            <option value="__new__">+ 새 실제 대화창 자동 생성 후 실행</option>
            {props.projectThreads.map((t) => (
              <option key={t.id} value={t.id}>
                기존 대화창: {t.title.length > 60 ? `${t.title.slice(0, 60)}…` : t.title}
              </option>
            ))}
          </select>
        </label>

        {props.killSwitchActive ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/8 px-2.5 py-1.5 text-[11px] text-destructive">
            자율 운영실이 종료된 상태입니다. 상단의 <strong>운영실 재가동</strong>을 누르면 새
            미션을 시작할 수 있습니다.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 rounded border-input accent-primary"
              checked={requireFinalApproval}
              onChange={(e) => setRequireFinalApproval(e.target.checked)}
            />
            최종 반영 전 내 결재 받기 (Tier 2)
          </label>

          <Button
            type="button"
            size="sm"
            disabled={!goalPrompt.trim() || props.busy || props.killSwitchActive}
            onClick={() => void handleSubmit()}
          >
            <PlayIcon className="size-3.5" />
            미션 시작
          </Button>
        </div>
      </div>
    </section>
  );
}
