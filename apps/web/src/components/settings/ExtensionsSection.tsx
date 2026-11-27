import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EnvironmentId,
  ExtensionActionInput,
  ExtensionCatalog,
  ManagedMcpProvider,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { BlocksIcon, RefreshCcwIcon } from "lucide-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { SectionCard, notifyCommandFailure } from "../control-center/controlCenterShared";
import { SkillSecurityReportView } from "./SkillSecurityReport";

const providerLabel = {
  codex: "Codex",
  claudeAgent: "Claude",
  gemini: "Antigravity",
  grok: "Grok",
};
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
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | undefined>();
  const [instances, setInstances] = useState<NonNullable<ExtensionCatalog["instances"]>>([]);
  const [skillScope, setSkillScope] = useState<"project" | "user">("project");
  const [kind, setKind] = useState<"plugin" | "skill">("plugin");
  const [target, setTarget] = useState("");
  const [trust, setTrust] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [extensionQuery, setExtensionQuery] = useState("");
  const generation = useRef(0);
  const hasLoaded = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    try {
      const result = await get({
        environmentId: props.environmentId,
        input: {
          ...(props.workspaceRoot ? { workspaceRoot: props.workspaceRoot } : {}),
          ...(instanceId ? { providerInstanceId: instanceId } : {}),
        },
      });
      if (request !== generation.current) return;
      if (
        !notifyCommandFailure(result, "확장 도구를 읽지 못했습니다.") &&
        result._tag === "Success"
      ) {
        setCatalog(result.value);
        setInstances(result.value.instances ?? []);
        hasLoaded.current = true;
      }
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [get, instanceId, props.environmentId, props.workspaceRoot]);
  useEffect(() => {
    setCatalog(null);
    if (hasLoaded.current) void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const run = async (input: ExtensionActionInput) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await manage({
        environmentId: props.environmentId,
        input: { ...input, ...(instanceId ? { providerInstanceId: instanceId } : {}) },
      });
      if (notifyCommandFailure(result, "확장 도구 작업에 실패했습니다.")) {
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          setMessage(failure instanceof Error ? failure.message : "확장 도구 작업에 실패했습니다.");
        }
        return;
      }
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
      {instances.length ? (
        <label className="mb-3 grid gap-1 text-xs">
          계정
          <select
            className="rounded-lg border bg-background p-2 text-sm"
            disabled={busy}
            value={instanceId ?? ""}
            onChange={(event) => {
              const chosen = instances.find((item) => item.instanceId === event.target.value);
              setInstanceId(chosen?.instanceId);
              if (chosen) setProvider(chosen.provider);
            }}
          >
            <option value="">각 제공자의 기본 계정</option>
            {instances.map((item) => (
              <option key={item.instanceId} value={item.instanceId}>
                {providerLabel[item.provider]} · {item.displayName} ({item.instanceId})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {!catalog ? (
        <p className="text-sm text-muted-foreground">
          목록 확인을 눌러 Codex·Claude·Antigravity·Grok의 스킬과 플러그인을 불러오세요.
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
          {(catalog.recoveryWarnings ?? []).map((warning) => (
            <p key={warning} role="alert" className="mb-2 break-all text-xs text-destructive">
              {warning}
            </p>
          ))}
          <div className="max-h-96 overflow-y-auto divide-y divide-border rounded-xl border border-border">
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card/95 px-3 py-2 backdrop-blur-xs">
              <input
                type="search"
                aria-label="스킬·플러그인 검색"
                placeholder="스킬·플러그인 이름 또는 설명 검색…"
                value={extensionQuery}
                onChange={(event) => setExtensionQuery(event.currentTarget.value)}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {catalog.entries
              .filter((entry) => {
                const q = extensionQuery.trim().toLowerCase();
                if (!q) return true;
                return `${entry.name} ${entry.source} ${entry.provider} ${entry.kind}`
                  .toLowerCase()
                  .includes(q);
              })
              .map((entry) => {
                const estimatedTokens = Math.max(
                  12,
                  Math.ceil(`${entry.name} ${entry.source}`.length / 3),
                );
                return (
                  <div key={`${entry.provider}:${entry.kind}:${entry.id}`} className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{entry.name}</span>
                      <Badge size="sm" variant="outline">
                        {providerLabel[entry.provider]} ·{" "}
                        {entry.kind === "skill" ? "스킬" : "플러그인"} ·{" "}
                        {entry.enabled ? "사용 중" : "꺼짐"}
                      </Badge>
                      <Badge size="sm" variant="outline" className="font-mono text-[10px]">
                        ~{estimatedTokens} tok
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
                    {entry.kind === "skill" ? (
                      <SkillSecurityReportView report={entry.securityScan} />
                    ) : null}
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
                                  ...((entry.kind === "skill" ||
                                    entry.scope === "project" ||
                                    entry.scope === "local") &&
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
                );
              })}
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
                onChange={(event) => {
                  setProvider(event.target.value as ManagedMcpProvider);
                  setInstanceId(undefined);
                }}
              >
                {Object.entries(providerLabel).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {kind === "skill" && props.workspaceRoot ? (
              <label className="grid gap-1 text-xs">
                스킬 설치 범위
                <select
                  className="rounded-lg border bg-background p-2 text-sm"
                  value={skillScope}
                  onChange={(event) =>
                    setSkillScope(event.target.value === "user" ? "user" : "project")
                  }
                >
                  <option value="project">현재 프로젝트</option>
                  <option value="user">선택한 계정</option>
                </select>
              </label>
            ) : null}
            <label className="grid gap-1 text-xs">
              종류
              <select
                className="rounded-lg border bg-background p-2 text-sm"
                value={kind}
                onChange={(event) => setKind(event.target.value === "skill" ? "skill" : "plugin")}
              >
                <option value="plugin">플러그인</option>
                <option value="skill">스킬</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs md:col-span-2">
              {kind === "skill"
                ? "GitHub 스킬 폴더 주소 또는 서버의 로컬 폴더 경로"
                : provider === "grok"
                  ? "Git 저장소 URL 또는 로컬 플러그인 경로"
                  : "플러그인@마켓플레이스"}
              <input
                className="rounded-lg border bg-background p-2 text-sm"
                value={target}
                placeholder={
                  kind === "skill"
                    ? "https://github.com/소유자/저장소/tree/main/경로/스킬"
                    : undefined
                }
                onChange={(event) => setTarget(event.target.value)}
              />
            </label>
            {kind === "skill" ? (
              <div className="grid gap-2 text-xs md:col-span-2">
                <p>
                  SKILL.md가 있는 공개 GitHub 폴더를 설치합니다. 주소의 브랜치는 설치 시 리비전으로
                  확인하며, 업데이트는 원래 주소에서 다시 가져옵니다.
                </p>
                <p>
                  예시 찾기:{" "}
                  <a
                    className="underline"
                    href="https://github.com/openai/skills/tree/main/skills/.curated"
                    target="_blank"
                    rel="noreferrer"
                  >
                    OpenAI 스킬
                  </a>{" "}
                  ·{" "}
                  <a
                    className="underline"
                    href="https://github.com/anthropics/skills/tree/main/skills"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Anthropic 스킬
                  </a>
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  disabled={busy}
                  onClick={() =>
                    void run({
                      provider,
                      kind: "skill",
                      target: "t3-skill:resume-writing-ko",
                      action: "install",
                      ...(props.workspaceRoot
                        ? { workspaceRoot: props.workspaceRoot, scope: skillScope }
                        : {}),
                    })
                  }
                >
                  한국어 자기소개서 스킬 설치
                </Button>
                <p className="text-muted-foreground">
                  이 스킬은 T3가 제공하는 작성 도우미입니다. ChatGPT의 개별 GPT를 직접 가져오는
                  기능과는 다릅니다.
                </p>
              </div>
            ) : null}
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
                ? "스킬은 선택한 범위에, Claude 플러그인은 프로젝트에, Codex·Grok 플러그인은 CLI의 사용자 범위에 설치됩니다."
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
                  ...(kind === "skill" && props.workspaceRoot ? { scope: skillScope } : {}),
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
