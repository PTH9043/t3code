import type {
  ProviderDriverKind,
  ServerProviderUsage,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { providerQuotaWindows } from "@t3tools/client-runtime/state/token-usage";
import { GaugeIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";

const compactNumber = new Intl.NumberFormat("ko-KR", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const resetTime = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTokens(tokens: number): string {
  return `${compactNumber.format(tokens)} 토큰`;
}

function quotaWindowLabel(window: ServerProviderUsageWindow, fallback: string): string {
  if (window.label) return window.label;
  if (window.windowDurationMinutes === 300) return "5시간";
  if (window.windowDurationMinutes === 10_080) return "7일";
  return fallback;
}

function UsageWindow({
  label,
  window,
}: {
  readonly label: string;
  readonly window: ServerProviderUsageWindow;
}) {
  const usedPercent = Math.min(100, Math.max(0, window.usedPercent));
  const resetLabel =
    window.resetsAt !== undefined ? `${resetTime.format(window.resetsAt * 1_000)} 초기화` : null;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="font-medium text-foreground">{quotaWindowLabel(window, label)}</span>
        <span className="font-mono tabular-nums text-muted-foreground">
          {usedPercent.toFixed(usedPercent % 1 === 0 ? 0 : 1)}%
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={`${quotaWindowLabel(window, label)} 사용량`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedPercent}
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${usedPercent}%` }} />
      </div>
      {resetLabel ? <span className="text-[10px] text-muted-foreground">{resetLabel}</span> : null}
    </div>
  );
}

function UsageMetric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-md bg-background/55 px-2.5 py-2">
      <dt className="text-[10px] font-medium text-muted-foreground">{label}</dt>
      <dd
        className="mt-0.5 truncate text-xs font-semibold tabular-nums text-foreground"
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function sourceLabel(usage: ServerProviderUsage | undefined): string {
  if (!usage) return "수집 전";
  if (usage.source === "provider") return "CLI 계정 누적";
  if (usage.source === "combined") return "계정 누적 + 현재 실행";
  return "현재 서버 실행";
}

function creditsLabel(usage: ServerProviderUsage | undefined): string | null {
  if (usage?.credits?.unlimited) return "무제한";
  if (usage?.credits?.hasCredits === false) return null;
  if (usage?.credits?.balance !== undefined) {
    const balance = Number(usage.credits.balance.replaceAll(",", ""));
    if (Number.isFinite(balance))
      return balance > 0 ? balance.toLocaleString("ko-KR", { maximumFractionDigits: 6 }) : null;
  }
  return usage?.credits?.hasCredits === true ? "사용 가능" : null;
}

export function ProviderAccountUsage({
  usage,
  driver,
  className,
}: {
  readonly usage: ServerProviderUsage | undefined;
  readonly driver?: ProviderDriverKind;
  readonly className?: string;
}) {
  const credits = creditsLabel(usage);
  const quotaWindows = providerQuotaWindows(usage, { includeExtra: true });
  return (
    <section
      className={cn(
        "grid gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5",
        className,
      )}
      aria-label="계정 사용량"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <GaugeIcon className="size-3.5 text-primary" />
          계정 사용량
        </span>
        <Badge variant={usage ? "outline" : "warning"} size="sm">
          {sourceLabel(usage)}
        </Badge>
      </div>

      <dl className={cn("grid grid-cols-2 gap-1.5", credits ? "sm:grid-cols-5" : "sm:grid-cols-4")}>
        <UsageMetric
          label="누적 토큰"
          value={
            usage?.lifetimeTokens === undefined ? "정보 없음" : formatTokens(usage.lifetimeTokens)
          }
        />
        <UsageMetric
          label="이번 실행"
          value={usage === undefined ? "정보 없음" : formatTokens(usage.sessionTokens)}
        />
        <UsageMetric
          label="세션"
          value={usage === undefined ? "정보 없음" : `${usage.sessionCount}개`}
        />
        <UsageMetric
          label="활성 세션"
          value={usage === undefined ? "정보 없음" : `${usage.activeSessionCount}개`}
        />
        {credits ? <UsageMetric label="크레딧" value={credits} /> : null}
      </dl>

      {quotaWindows.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {quotaWindows.map((window) => (
            <UsageWindow
              key={window.id}
              label={driver === "codex" && window.id === "secondary" ? "주간 한도" : window.label}
              window={{
                label: window.label,
                usedPercent: window.usedPercent,
                ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
              }}
            />
          ))}
        </div>
      ) : (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          할당량과 초기화 시각은 해당 CLI가 계정 한도 정보를 제공할 때 표시됩니다.
        </p>
      )}

      {usage?.peakDailyTokens !== undefined || usage?.currentStreakDays !== undefined ? (
        <p className="text-[10px] text-muted-foreground">
          {usage.peakDailyTokens !== undefined
            ? `일일 최고 ${formatTokens(usage.peakDailyTokens)}`
            : null}
          {usage.peakDailyTokens !== undefined && usage.currentStreakDays !== undefined
            ? " · "
            : null}
          {usage.currentStreakDays !== undefined ? `연속 ${usage.currentStreakDays}일` : null}
        </p>
      ) : null}
    </section>
  );
}
