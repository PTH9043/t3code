import type { DesktopAssistantSettings, DesktopAssistantSettingsPatch } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

/** Desktop owns this state so updates from two windows cannot overwrite one another. */
export function useDesktopAssistant() {
  const [settings, setSettings] = useState<DesktopAssistantSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.desktopBridge;
  useEffect(() => {
    if (!bridge?.getAssistantSettings) return;
    let live = true;
    let changed = false;
    const unsubscribe = bridge.onAssistantSettingsChanged?.((next) => {
      changed = true;
      if (live) setSettings(next);
    });
    void bridge
      .getAssistantSettings()
      .then((next) => {
        if (live && !changed) setSettings(next);
      })
      .catch(() => {
        if (live) setError("비서 설정을 불러오지 못했습니다.");
      });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [bridge]);
  const update = useCallback(
    async (patch: DesktopAssistantSettingsPatch) => {
      if (!bridge?.setAssistantSettings) return;
      try {
        const next = await bridge.setAssistantSettings(patch);
        if (!bridge.onAssistantSettingsChanged) setSettings(next);
        setError(null);
      } catch {
        setError("비서 설정을 저장하지 못했습니다.");
      }
    },
    [bridge],
  );
  const open = useCallback(async () => {
    try {
      await bridge?.openAssistant?.();
      setError(null);
    } catch {
      setError("비서 창을 열지 못했습니다.");
    }
  }, [bridge]);
  const close = useCallback(async () => {
    try {
      await bridge?.closeAssistant?.();
      setError(null);
    } catch {
      setError("비서 창을 닫지 못했습니다.");
    }
  }, [bridge]);
  return { available: !!bridge?.getAssistantSettings, settings, error, update, open, close };
}
