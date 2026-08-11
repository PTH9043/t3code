import type { EnvironmentId } from "@t3tools/contracts";
import { Globe, History, RadioTower } from "lucide-react";

import type { BrowserHistoryEntry } from "~/browserHistoryStore";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "~/components/ui/empty";

import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewRecentUrlCard } from "./PreviewRecentUrlCard";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

interface Props {
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentlySeenUrls?: ReadonlyArray<string> | undefined;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  onRemoveRecent: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

export function PreviewEmptyState({
  environmentId,
  configuredUrls,
  recentlySeenUrls,
  recentEntries,
  onRemoveRecent,
  onOpenUrl,
}: Props) {
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
    recentlySeenUrls,
  });
  const recents = recentEntries.filter((entry) => URL.canParse(entry.url)).slice(0, 8);

  if (servers.length === 0 && recents.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <Globe className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>아직 미리보기가 없습니다</EmptyTitle>
        <EmptyDescription>
          위에 URL을 입력하거나 개발 스크립트를 실행하세요. 수신 중인 localhost 포트가 자동으로
          여기에 표시됩니다.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="m-auto flex w-full max-w-xl flex-col gap-6">
        {recents.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <History className="size-4 shrink-0" />
              <h2 className="font-medium">최근 사용</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {recents.map((entry) => (
                <PreviewRecentUrlCard
                  key={entry.url}
                  entry={entry}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {servers.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RadioTower className="size-4 shrink-0" />
              <h2 className="font-medium">로컬 서버</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {servers.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              수신 중인 포트를 선택하면 이 브라우저 탭에서 열립니다.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
