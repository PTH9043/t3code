import { lazy, Suspense, useEffect } from "react";

import { openAiHelp, useAiHelpStore } from "./aiHelpStore";

const AiHelpDialog = lazy(() => import("./AiHelpDialog"));

/** Loads the guide only when requested and keeps the current conversation in place. */
export function AiHelpHost() {
  const isOpen = useAiHelpStore((state) => state.isOpen);
  const setOpen = useAiHelpStore((state) => state.setOpen);

  useEffect(() => {
    const unsubscribeMenu = window.desktopBridge?.onMenuAction?.((action) => {
      if (action === "open-ai-help") openAiHelp();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "F1" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        document.querySelector('[role="dialog"], [aria-modal="true"]')
      )
        return;
      event.preventDefault();
      openAiHelp();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unsubscribeMenu?.();
    };
  }, []);

  return isOpen ? (
    <Suspense fallback={null}>
      <AiHelpDialog onClose={() => setOpen(false)} />
    </Suspense>
  ) : null;
}
