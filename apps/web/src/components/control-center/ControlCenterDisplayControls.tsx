import { Maximize2Icon, MinusIcon, MoonIcon, PlusIcon, RotateCcwIcon, SunIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useTheme } from "~/hooks/useTheme";
import { useUiScale } from "~/hooks/useUiScale";

export function ControlCenterDisplayControls() {
  const { resolvedTheme, setAppearanceMode } = useTheme();
  const { scale, decrease, increase, reset, canDecrease, canIncrease } = useUiScale();
  const toggleWindowMaximized =
    typeof window === "undefined" ? undefined : window.desktopBridge?.toggleWindowMaximized;
  const darkModeEnabled = resolvedTheme === "dark";

  return (
    <div
      aria-label="화면 표시 설정"
      className="ml-auto mr-[var(--workspace-native-controls-inset)] flex shrink-0 items-center gap-1"
      role="group"
    >
      <span className="hidden text-[11px] text-muted-foreground lg:inline">글자</span>
      <Button
        aria-label="글자 작게"
        disabled={!canDecrease}
        onClick={decrease}
        size="icon-xs"
        title="글자 작게"
        variant="ghost"
      >
        <MinusIcon />
      </Button>
      <Button
        aria-label={`글자 크기 ${scale}%, 기본 크기로 초기화`}
        className="min-w-11 px-1 font-mono text-[11px]"
        onClick={reset}
        size="xs"
        title="글자 크기 초기화"
        variant="ghost"
      >
        {scale}%{scale !== 100 ? <RotateCcwIcon className="size-3" /> : null}
      </Button>
      <Button
        aria-label="글자 크게"
        disabled={!canIncrease}
        onClick={increase}
        size="icon-xs"
        title="글자 크게"
        variant="ghost"
      >
        <PlusIcon />
      </Button>
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
      <Button
        aria-label={darkModeEnabled ? "라이트 모드로 전환" : "다크 모드로 전환"}
        aria-pressed={darkModeEnabled}
        onClick={() => setAppearanceMode(darkModeEnabled ? "light" : "dark")}
        size="icon-xs"
        title={darkModeEnabled ? "라이트 모드로 전환" : "다크 모드로 전환"}
        variant="ghost"
      >
        {darkModeEnabled ? <SunIcon /> : <MoonIcon />}
      </Button>
      {typeof toggleWindowMaximized === "function" ? (
        <Button
          aria-label="창 최대화 또는 이전 크기로 복원"
          onClick={() => void toggleWindowMaximized()}
          size="icon-xs"
          title="창 최대화/이전 크기"
          variant="ghost"
        >
          <Maximize2Icon />
        </Button>
      ) : null}
    </div>
  );
}
