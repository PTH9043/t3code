import { useLayoutEffect, useRef, useState } from "react";
import {
  connectUpgradeRoomView,
  upgradeRoomViewOwner,
  useUpgradeRoomConnection,
} from "./openUpgradeRoomWorkspaceTab";

/** WorkspaceTabPane's Activity suspends layout while the room tab is in the background. */
export function UpgradeRoomTabPane() {
  const slot = useRef<HTMLDivElement>(null);
  const request = useUpgradeRoomConnection((state) => state.request);
  const [status, setStatus] = useState<"opening" | "ready" | "idle" | "failed">("opening");
  const bridge = typeof window !== "undefined" && window.desktopBridge?.upgradeRoomTab;
  useLayoutEffect(() => {
    const element = slot.current;
    if (!bridge || !element) return;
    const owner = upgradeRoomViewOwner();
    let mounted = true;
    const place = () => {
      if (!mounted) return;
      const { x, y, width, height } = element.getBoundingClientRect();
      bridge.layout(owner, { x, y, width, height });
    };
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("transitionend", place, true);
    setStatus("opening");
    const attach = async () => {
      if (request) await request;
      if (!mounted) return;
      // History navigation and host reload may reuse a guest. Only a user
      // activation in connectUpgradeRoomView can start the installed launcher.
      const ready = await bridge.resume(owner);
      if (!mounted) return;
      setStatus(ready ? "ready" : request ? "failed" : "idle");
      if (ready) place();
    };
    void attach().catch(() => {
      if (mounted) setStatus("failed");
    });
    return () => {
      mounted = false;
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("transitionend", place, true);
      // A pending user-authorized link may finish offscreen. The broker owns the work.
      bridge.layout(owner, { x: 0, y: 0, width: 0, height: 0 });
    };
  }, [bridge, request]);
  return (
    <div ref={slot} className="min-h-0 min-w-0 flex-1" aria-label="AutoUsage 업그레이드">
      <div role="status" className="p-4 text-sm text-muted-foreground">
        {status === "opening" ? (
          "업그레이드 방 연결 중…"
        ) : (
          <button type="button" className="underline" onClick={connectUpgradeRoomView}>
            {status === "idle" ? "업그레이드 방 열기" : "업그레이드 방 다시 연결"}
          </button>
        )}
      </div>
    </div>
  );
}
