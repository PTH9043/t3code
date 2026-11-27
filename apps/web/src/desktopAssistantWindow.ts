/** The desktop preload supplies the bridge before the renderer modules load. */
export function isDesktopAssistantWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    new URL(window.location.href).searchParams.get("desktopAssistant") === "1" &&
    typeof window.desktopBridge?.getAssistantSettings === "function"
  );
}
