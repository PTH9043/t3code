import {
  DEFAULT_INTERFACE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
} from "@t3tools/contracts";
import { Maximize2Icon, MinusIcon, MoonIcon, PlusIcon, RotateCcwIcon, SunIcon } from "lucide-react";

import { clampInterfaceFontSize } from "~/appearanceFonts";
import { Button } from "~/components/ui/button";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";

/** One press of the header's font buttons, in px of interface font size. */
const INTERFACE_FONT_SIZE_STEP = 1;

export function ControlCenterDisplayControls() {
  const { resolvedTheme, setAppearanceMode } = useTheme();
  // These buttons step the same preference Settings → 모양 edits. The header
  // must not keep a scale of its own: both would own
  // `documentElement.style.fontSize`, and whichever ran last silently threw the
  // other away — mounting the control center used to reset a saved size.
  const fontSize = useClientSettings((settings) => settings.fontSizeInterface);
  const settingsHydrated = useClientSettingsHydrated();
  const updateClientSettings = useUpdateClientSettings();
  const setFontSize = (next: number) => {
    // Writing before hydration would persist the defaults over the stored size.
    if (!settingsHydrated) return;
    updateClientSettings({ fontSizeInterface: clampInterfaceFontSize(next) });
  };
  const canDecrease = settingsHydrated && fontSize > MIN_INTERFACE_FONT_SIZE;
  const canIncrease = settingsHydrated && fontSize < MAX_INTERFACE_FONT_SIZE;
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
        onClick={() => setFontSize(fontSize - INTERFACE_FONT_SIZE_STEP)}
        size="icon-xs"
        title="글자 작게"
        variant="ghost"
      >
        <MinusIcon />
      </Button>
      <Button
        aria-label={`글자 크기 ${fontSize}px, 기본 크기로 초기화`}
        className="min-w-11 px-1 font-mono text-[11px]"
        onClick={() => setFontSize(DEFAULT_INTERFACE_FONT_SIZE)}
        size="xs"
        title="글자 크기 초기화"
        variant="ghost"
      >
        {fontSize}px
        {fontSize === DEFAULT_INTERFACE_FONT_SIZE ? null : <RotateCcwIcon className="size-3" />}
      </Button>
      <Button
        aria-label="글자 크게"
        disabled={!canIncrease}
        onClick={() => setFontSize(fontSize + INTERFACE_FONT_SIZE_STEP)}
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
