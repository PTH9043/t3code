import { BrowserMockup } from "./BrowserMockup";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ server, onOpen }: Props) {
  const subtitle = describeServer(server);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <BrowserMockup className="size-7 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{subtitle}</span>
        <span className="truncate text-xs text-muted-foreground">
          {server.host}:{server.port}
        </span>
      </div>
      {server.listening ? <PulsingDot /> : <DimDot />}
    </button>
  );
}

function describeServer(server: PreviewableServer): string {
  if (server.processName) return server.processName;
  if (server.listening) return "수신 중";
  if (server.source === "configured") return "구성됨";
  return "최근 확인됨";
}

function PulsingDot() {
  return (
    <span aria-label="수신 중" className="relative inline-flex size-2 shrink-0">
      <span className="absolute inset-0 animate-status-ping rounded-full bg-success opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-success" />
    </span>
  );
}

function DimDot() {
  return (
    <span
      aria-label="현재 수신하지 않음"
      className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
    />
  );
}
