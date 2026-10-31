import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EnvironmentId,
  ExtensionActionInput,
  ExtensionCatalog,
  ManagedMcpProvider,
} from "@t3tools/contracts";
import { BlocksIcon, RefreshCcwIcon } from "lucide-react";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { SectionCard, notifyCommandFailure } from "../control-center/controlCenterShared";

const providerLabel = { codex: "Codex", claudeAgent: "Claude", grok: "Grok" };
const actionLabel = {
  install: "설치",
  update: "업데이트",
  enable: "켜기",
  disable: "끄기",
  uninstall: "설치 해제",
};
export function ExtensionsSection(props: {
  environmentId: EnvironmentId;
  workspaceRoot?: string;
  readOnly?: boolean;
}) {
  const get = useAtomCommand(serverEnvironment.getExtensions, { reportFailure: false });
  const manage = useAtomCommand(serverEnvironment.manageExtension, { reportFailure: false });
  const [catalog, setCatalog] = useState<ExtensionCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<ManagedMcpProvider>("grok");
  const [kind, setKind] = useState<"plugin" | "skill">("plugin");
  const [target, setTarget] = useState("");
  const [trust, setTrust] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    try {
      const result = await get({
        environmentId: props.environmentId,
        input: props.workspaceRoot ? { workspaceRoot: props.workspaceRoot } : {},
      });
      if (request !== generation.current) return;
      if (
        !notifyCommandFailure(result, "확장 도구를 읽지 못했습니다.") &&
        result._tag === "Success"
      )
        setCatalog(result.value);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [get, props.environmentId, props.workspaceRoot]);
  useEffect(() => {
    setCatalog(null);
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const run = async (input: ExtensionActionInput) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await manage({ environmentId: props.environmentId, input });
      if (notifyCommandFailure(result, "확장 도구 작업에 실패했습니다.")) return;
      if (result._tag === "Success") {
        setMessage(result.value.message);
        setTarget("");
        setTrust(false);
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard
      id="extensions"
      icon={BlocksIcon}
      title="스킬·플러그인"
      scopeLabel={props.workspaceRoot ? "현재 프로젝트" : "현재 환경"}
      description="설치된 CLI의 확장 도구와 출처를 확인하고 관리하세요. 변경은 새 AI 세션부터 적용됩니다."
      action={
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          <RefreshCcwIcon />
          {busy ? "확인 중…" : "목록 확인"}
        </Button>
      }
    >
      {!catalog ? (
        <p className="text-sm text-muted-foreground">
          목록 확인을 눌러 Codex·Claude·Grok의 스킬과 플러그인을 불러오세요.
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {catalog.providers.map((item) => (
              <Badge key={item.provider} variant={item.error ? "error" : "outline"}>
                {providerLabel[item.provider]} ·{" "}
                {item.error ? "CLI 확인 필요" : `${item.actions.length}개 관리 작업`}
              </Badge>
            ))}
          </div>
          {catalog.providers
            .filter((item) => item.error)
            .map((item) => (
              <p key={item.provider} className="mb-2 text-xs text-destructive">
                {providerLabel[item.provider]} · {item.error}
              </p>
            ))}
          <div className="max-h-96 overflow-y-auto divide-y divide-border rounded-xl border border-border">
            {catalog.entries.map((entry) => (
              <div key={`${entry.provider}:${entry.kind}:${entry.id}`} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{entry.name}</span>
                  <Badge size="sm" variant="outline">
                    {providerLabel[entry.provider]} · {entry.kind === "skill" ? "스킬" : "플러그인"}{" "}
                    · {entry.enabled ? "사용 중" : "꺼짐"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {entry.version ? `v${entry.version} · ` : ""}
                    {entry.scope === "user"
                      ? "사용자"
                      : entry.scope === "managed"
                        ? "조직 관리"
                        : entry.scope === "local"
                          ? "프로젝트(로컬)"
                          : "프로젝트"}
                  </span>
                </div>
                <p className="mt-1 break-all text-xs text-muted-foreground">{entry.source}</p>
                {!props.readOnly && entry.actions.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {entry.actions
                      .filter(
                        (action) =>
                          action !== "install" &&
                          !(entry.enabled ? action === "enable" : action === "disable"),
                      )
                      .map((action) => (
                        <Button
                          key={action}
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void run({
                              provider: entry.provider,
                              kind: entry.kind,
                              ...(entry.scope !== "managed" ? { scope: entry.scope } : {}),
                              target: entry.id,
                              action,
                              ...((entry.scope === "project" || entry.scope === "local") &&
                              props.workspaceRoot
                                ? { workspaceRoot: props.workspaceRoot }
                                : {}),
                            })
                          }
                        >
                          {actionLabel[action]}
                        </Button>
                      ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    출처의 관리 기능을 사용하세요.
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {!props.readOnly ? (
        <details className="mt-4 rounded-xl border border-border p-4">
          <summary className="cursor-pointer text-sm font-semibold">확장 도구 설치</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-xs">
              제공자
              <select
                className="rounded-lg border bg-background p-2 text-sm"
                value={provider}
                onChange={(event) => setProvider(event.target.value as ManagedMcpProvider)}
              >
                {Object.entries(providerLabel).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              종류
              <select
                className="rounded-lg border bg-background p-2 text-sm"
                value={kind}
                onChange={(event) => setKind(event.target.value === "skill" ? "skill" : "plugin")}
              >
                <option value="plugin">플러그인</option>
                <option value="skill">로컬 스킬 폴더</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs md:col-span-2">
              {kind === "skill"
                ? "SKILL.md가 있는 폴더의 절대 경로"
                : provider === "grok"
                  ? "Git 저장소 URL 또는 로컬 플러그인 경로"
                  : "플러그인@마켓플레이스"}
              <input
                className="rounded-lg border bg-background p-2 text-sm"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
            </label>
            {kind === "plugin" && provider === "grok" ? (
              <label className="flex items-center gap-2 text-xs md:col-span-2">
                <input
                  type="checkbox"
                  checked={trust}
                  onChange={(event) => setTrust(event.target.checked)}
                />
                이 출처의 플러그인 도구와 훅 실행 허용
              </label>
            ) : null}
            <p className="text-xs text-muted-foreground md:col-span-2">
              {props.workspaceRoot
                ? "스킬·Claude 플러그인은 현재 프로젝트, Codex·Grok 플러그인은 CLI의 사용자 범위에 설치됩니다."
                : "서버 사용자의 CLI에 설치합니다."}{" "}
              Grok은 Claude·공유 스킬도 찾아 표시합니다.
            </p>
            <Button
              className="w-fit"
              size="sm"
              disabled={
                busy || !target.trim() || (kind === "plugin" && provider === "grok" && !trust)
              }
              onClick={() =>
                void run({
                  provider,
                  kind,
                  target: target.trim(),
                  action: "install",
                  trust,
                  ...(props.workspaceRoot ? { workspaceRoot: props.workspaceRoot } : {}),
                })
              }
            >
              설치
            </Button>
          </div>
        </details>
      ) : null}
      {message ? (
        <p role="status" className="mt-3 whitespace-pre-wrap text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </SectionCard>
  );
}
