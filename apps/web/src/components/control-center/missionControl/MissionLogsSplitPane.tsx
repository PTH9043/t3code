import type {
  MissionActivityItem,
  MissionHandoffItem,
  MissionInspectArtifactResult,
} from "@t3tools/contracts";
import {
  ActivityIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileCode2Icon,
  MessageSquareShareIcon,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { formatClockTimeKo } from "./missionControlUi.logic";

export function MissionLogsSplitPane(props: {
  readonly activities: ReadonlyArray<MissionActivityItem>;
  readonly handoffs: ReadonlyArray<MissionHandoffItem>;
  readonly onInspectArtifact: (artifactId: string) => Promise<MissionInspectArtifactResult | null>;
}) {
  const [expandedHandoffId, setExpandedHandoffId] = useState<string | null>(null);
  const [artifactView, setArtifactView] = useState<MissionInspectArtifactResult | null>(null);
  const [loadingArtifactId, setLoadingArtifactId] = useState<string | null>(null);

  const handleInspect = async (artifactId: string) => {
    if (artifactView?.artifactId === artifactId) {
      setArtifactView(null);
      return;
    }
    setLoadingArtifactId(artifactId);
    try {
      const res = await props.onInspectArtifact(artifactId);
      setArtifactView(res);
    } finally {
      setLoadingArtifactId(null);
    }
  };

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* 좌측: 활동 로그 */}
      <div className="grid gap-2.5 rounded-2xl border border-border bg-card p-4 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ActivityIcon className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">활동 로그</h3>
          </div>
          <Badge variant="outline" size="sm">
            {props.activities.length}건
          </Badge>
        </div>

        <div className="grid max-h-80 gap-1.5 overflow-y-auto pr-1">
          {props.activities.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              아직 기록된 자율 활동이 없습니다.
            </p>
          ) : (
            props.activities.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-2 rounded-lg border border-border/50 bg-background/60 px-2.5 py-2 text-xs"
              >
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                  {formatClockTimeKo(item.createdAtMs)}
                </span>
                <span className="shrink-0 font-semibold text-foreground">
                  {item.roleDisplayName}
                </span>
                <span className="min-w-0 flex-1 break-words text-foreground/85">
                  {item.message}
                </span>
                {item.artifactId ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={loadingArtifactId === item.artifactId}
                    onClick={() => void handleInspect(item.artifactId!)}
                  >
                    <FileCode2Icon className="size-3" />
                    원문
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 우측: 에이전트 교신 (A→B Pass-by-Reference 타임라인) */}
      <div className="grid gap-2.5 rounded-2xl border border-border bg-card p-4 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageSquareShareIcon className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">크루 교신 (Pass-by-Reference 포인터)</h3>
          </div>
          <Badge variant="outline" size="sm">
            {props.handoffs.length}건
          </Badge>
        </div>

        <div className="grid max-h-80 gap-1.5 overflow-y-auto pr-1">
          {props.handoffs.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              크루 간 핸드오프 패킷이 아직 없습니다.
            </p>
          ) : (
            props.handoffs.map((item) => {
              const expanded = expandedHandoffId === item.id;
              const packet = item.packet;
              return (
                <article
                  key={item.id}
                  className="grid gap-1.5 rounded-lg border border-border/60 bg-background/60 p-2.5 text-xs"
                >
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 text-left"
                    onClick={() => setExpandedHandoffId(expanded ? null : item.id)}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      {expanded ? (
                        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {formatClockTimeKo(item.createdAtMs)}
                      </span>
                      <span className="truncate font-semibold">{item.fromActor}</span>
                      <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
                      <span className="truncate font-semibold text-primary">{item.toActor}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {packet ? (
                        <Badge variant="outline" size="sm">
                          ~{packet.estimatedTokens}T · Hop {packet.hopCount}
                        </Badge>
                      ) : null}
                    </div>
                  </button>

                  <p className="truncate pl-5 text-[11px] text-muted-foreground">{item.subject}</p>

                  {expanded && packet ? (
                    <div className="mt-1 grid gap-1.5 rounded-lg bg-muted/35 p-2.5 text-[11px]">
                      <ul className="grid gap-0.5 pl-4 list-disc text-foreground/90">
                        {packet.summary3Lines.map((line, idx) => (
                          <li key={idx}>{line}</li>
                        ))}
                      </ul>
                      {packet.pointers.changedFiles.length > 0 ? (
                        <p className="font-mono text-[10px] text-muted-foreground">
                          파일: {packet.pointers.changedFiles.join(", ")}
                        </p>
                      ) : null}
                      {packet.pointers.artifactIds.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1">
                          {packet.pointers.artifactIds.map((artId) => (
                            <Button
                              key={artId}
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={loadingArtifactId === artId}
                              onClick={() => void handleInspect(artId)}
                            >
                              <FileCode2Icon className="size-3" />
                              {artId} 원문 열람
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </div>
      </div>

      {/* 아티팩트 원문 인라인 뷰어 */}
      {artifactView ? (
        <div className="lg:col-span-2 grid gap-2 rounded-2xl border border-primary/30 bg-card p-4 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <FileCode2Icon className="size-4 text-primary" />
              <span className="font-mono font-semibold">{artifactView.artifactId}</span>
              <Badge variant="outline" size="sm">
                {artifactView.toolName} · {(artifactView.rawByteSize / 1024).toFixed(1)} KB
              </Badge>
            </div>
            <Button type="button" size="xs" variant="ghost" onClick={() => setArtifactView(null)}>
              닫기
            </Button>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {artifactView.content}
          </pre>
        </div>
      ) : null}
    </section>
  );
}
