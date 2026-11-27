import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EnvironmentId,
  ManagedMcpServerConfig,
  McpToolCatalog,
  McpToolCatalogEntry,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  PlugZapIcon,
  RefreshCcwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { McpServerForm } from "./McpServerForm";
import {
  SectionCard,
  notifyCommandFailure,
  formatTimestamp,
} from "../control-center/controlCenterShared";

const mcpCatalogSwrCache = new Map<string, McpToolCatalog>();

function mcpCatalogCacheKey(environmentId: EnvironmentId, workspaceRoot?: string): string {
  return `${environmentId}::${workspaceRoot ?? "*"}`;
}

function hasUncheckedEnabledMcpEntries(catalog: McpToolCatalog): boolean {
  return catalog.entries.some(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.status !== "ready" &&
      entry.status !== "error" &&
      entry.status !== "missing",
  );
}

const T3_CORE_MCP_ESTIMATED_TOOLS = 26;
const ANTIGRAVITY_SAFE_MCP_TOOL_BUDGET = 40;

function estimateAntigravityMcpBudget(entries: ReadonlyArray<McpToolCatalogEntry>): {
  readonly estimatedTools: number;
  readonly budget: number;
  readonly skippedNativeRedundantCount: number;
} {
  let externalTools = 0;
  let skippedNativeRedundantCount = 0;
  for (const entry of entries) {
    if (!entry.enabled || !entry.installed || !entry.providers.includes("gemini")) continue;
    const isRedundantDefault =
      entry.scope === "environment" &&
      (entry.nativeRedundantProviders?.includes("gemini") ?? false);
    if (isRedundantDefault) {
      skippedNativeRedundantCount += 1;
      continue;
    }
    externalTools += entry.tools.length > 0 ? entry.tools.length : (entry.estimatedToolCount ?? 6);
  }
  return {
    estimatedTools: T3_CORE_MCP_ESTIMATED_TOOLS + externalTools,
    budget: ANTIGRAVITY_SAFE_MCP_TOOL_BUDGET,
    skippedNativeRedundantCount,
  };
}

export function McpToolsSection(props: {
  environmentId: EnvironmentId;
  readOnly?: boolean;
  id?: string;
  workspaceRoot?: string;
}) {
  const settings = useEnvironmentSettings(props.environmentId, (value) => value);
  const connected = useEnvironment(props.environmentId)?.connection.phase === "connected";
  const getTools = useAtomCommand(serverEnvironment.getMcpTools, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const cacheKey = mcpCatalogCacheKey(props.environmentId, props.workspaceRoot);
  const [catalog, setCatalog] = useState<McpToolCatalog | null>(
    () => mcpCatalogSwrCache.get(cacheKey) ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ManagedMcpServerConfig | null>(null);
  const requestGeneration = useRef(0);
  const autoProbedKeys = useRef<Set<string>>(new Set());
  const refresh = useCallback(
    async (check: boolean) => {
      if (!connected) return;
      const generation = ++requestGeneration.current;
      setBusy(true);
      try {
        const result = await getTools({
          environmentId: props.environmentId,
          input: { check, ...(props.workspaceRoot ? { workspaceRoot: props.workspaceRoot } : {}) },
        });
        if (generation !== requestGeneration.current) return;
        if (
          !notifyCommandFailure(result, "MCP 도구를 확인하지 못했습니다.") &&
          result._tag === "Success"
        ) {
          mcpCatalogSwrCache.set(cacheKey, result.value);
          setCatalog(result.value);
          // BUG-08: Automatically probe enabled servers that remain in unchecked state on mount
          if (
            !check &&
            !autoProbedKeys.current.has(cacheKey) &&
            hasUncheckedEnabledMcpEntries(result.value)
          ) {
            autoProbedKeys.current.add(cacheKey);
            const probeResult = await getTools({
              environmentId: props.environmentId,
              input: {
                check: true,
                ...(props.workspaceRoot ? { workspaceRoot: props.workspaceRoot } : {}),
              },
            });
            if (generation !== requestGeneration.current) return;
            if (probeResult._tag === "Success") {
              mcpCatalogSwrCache.set(cacheKey, probeResult.value);
              setCatalog(probeResult.value);
            }
          }
        }
      } finally {
        if (generation === requestGeneration.current) setBusy(false);
      }
    },
    [cacheKey, connected, getTools, props.environmentId, props.workspaceRoot],
  );
  useEffect(() => {
    setCatalog(mcpCatalogSwrCache.get(cacheKey) ?? null);
    setBusy(false);
    void refresh(false);
    return () => {
      requestGeneration.current++;
    };
  }, [cacheKey, refresh]);
  const save = async (patch: ServerSettingsPatch) => {
    if (!connected) return false;
    setBusy(true);
    try {
      const result = await update({
        environmentId: props.environmentId,
        input: { patch },
      });
      if (notifyCommandFailure(result, "MCP 설정을 저장하지 못했습니다.")) return false;
      await refresh(false);
      return true;
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (entry: McpToolCatalogEntry, enabled: boolean) => {
    if (!entry.builtinId) {
      const config = settings.customMcpServers[entry.id.slice("custom:".length)];
      if (config)
        await save({ customMcpServersToUpsert: { [config.name]: { ...config, enabled } } });
    } else if (props.workspaceRoot) {
      const enabledBuiltins = (catalog?.entries ?? []).flatMap((item) =>
        item.builtinId && (item.id === entry.id ? enabled : item.enabled) ? [item.builtinId] : [],
      );
      await save({
        mcpProjectProfilesToUpsert: {
          [props.workspaceRoot]: { workspaceRoot: props.workspaceRoot, enabledBuiltins },
        },
      });
    } else await save({ mcpTools: { [entry.builtinId]: enabled } });
  };

  const antigravityBudget = catalog ? estimateAntigravityMcpBudget(catalog.entries) : null;

  return (
    <SectionCard
      id={props.id ?? "mcp-tools"}
      icon={PlugZapIcon}
      title="MCP 도구"
      scopeLabel={props.workspaceRoot ? "현재 프로젝트" : "현재 환경"}
      description="Codex·Claude·Antigravity·Grok의 도구와 사용자 MCP 서버를 관리하세요. 새 AI 세션부터 적용됩니다."
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !connected}
          onClick={() => void refresh(true)}
        >
          <RefreshCcwIcon />
          {busy ? "확인 중…" : "연결 검사"}
        </Button>
      }
    >
      <div className="mb-3 rounded-xl border border-border bg-background/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheckIcon className="size-4 shrink-0 text-emerald-500" />
            <span className="text-sm font-semibold">T3 Code 내장 도구 (t3-code)</span>
            <Badge size="sm" variant="success">
              항상 최우선 활성
            </Badge>
          </div>
          {antigravityBudget ? (
            <Badge
              size="sm"
              variant={
                antigravityBudget.estimatedTools > antigravityBudget.budget ? "warning" : "outline"
              }
            >
              Antigravity 예상 도구 {antigravityBudget.estimatedTools} / {antigravityBudget.budget}
              개
            </Badge>
          ) : null}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          협업 브라우저(<code>preview_open</code>·<code>preview_click</code>·
          <code>preview_type</code>·<code>preview_evaluate</code>), 장기기억(
          <code>workspace_memory</code>), 하위 위임(
          <code>workspace_delegate</code>), 앱 실행(<code>workspace_launch_app</code>) 등 핵심{" "}
          {T3_CORE_MCP_ESTIMATED_TOOLS}개 도구는 개별 비활성화 없이 모든 세션에서 1순위로 자동
          연결됩니다. Antigravity 세션 중 도구 누락이 감지되면 T3가 <code>t3-code</code> 최우선
          모드로 자동 재연결해 복구합니다.
        </p>
        {antigravityBudget && antigravityBudget.estimatedTools > antigravityBudget.budget ? (
          <p className="mt-2 text-xs text-warning">
            Antigravity 예상 도구 수가 안전 권장치({antigravityBudget.budget}개)를 초과했습니다.
            세션 시작 시 <code>t3-code</code> 핵심 도구를 먼저 보장하고 초과 외부 MCP는 자동으로
            후순위 제외됩니다.
          </p>
        ) : null}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {catalog?.entries.map((entry) => (
          <div key={entry.id} className="rounded-xl border border-border bg-background/45 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-sm font-semibold">{entry.name}</span>
                <Badge
                  size="sm"
                  variant={
                    entry.status === "ready"
                      ? "success"
                      : entry.status === "error"
                        ? "error"
                        : "outline"
                  }
                >
                  {entry.status === "ready" ? <CheckCircle2Icon /> : null}
                  {entry.status === "ready"
                    ? "연결 확인"
                    : entry.status === "error"
                      ? "연결 오류"
                      : entry.status === "missing"
                        ? "설치 필요"
                        : "검사 전"}
                </Badge>
              </div>
              <Switch
                aria-label={`${entry.name} 사용`}
                checked={entry.enabled}
                disabled={props.readOnly || busy || !connected || !entry.installed}
                onCheckedChange={(enabled) => void toggle(entry, enabled)}
              />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {entry.description}
            </p>
            {entry.nativeRedundantProviders?.includes("gemini") ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge size="sm" variant="outline">
                  {entry.scope === "project"
                    ? "Antigravity 프로젝트 강제 포함"
                    : "Antigravity 기본 제외 (내장 도구 중복 · 예산 보호)"}
                </Badge>
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                {entry.providers
                  .map((provider) =>
                    provider === "claudeAgent"
                      ? "Claude"
                      : provider === "gemini"
                        ? "Antigravity"
                        : provider === "grok"
                          ? "Grok"
                          : "Codex",
                  )
                  .join(" · ")}
              </span>
              {entry.version ? <span>v{entry.version}</span> : null}
              <span>{entry.scope === "project" ? "프로젝트 설정" : "환경 설정"}</span>
              <a
                className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
                href={entry.source}
                target="_blank"
                rel="noreferrer"
              >
                공식 출처
                <ExternalLinkIcon className="size-3" />
              </a>
            </div>
            {entry.error ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {entry.error}
              </p>
            ) : null}
            {!entry.builtinId && !props.readOnly ? (
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setEditing(settings.customMcpServers[entry.id.slice("custom:".length)] ?? null)
                  }
                >
                  수정
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void save({ customMcpServerIdsToRemove: [entry.id.slice("custom:".length)] })
                  }
                >
                  등록 해제
                </Button>
              </div>
            ) : null}
            {entry.tools.length > 0 ? (
              <p className="mt-2 text-[10px] text-muted-foreground">
                최근 검사 · {formatTimestamp(entry.checkedAt)}
              </p>
            ) : null}
            {entry.tools.length > 0 ? (
              <details className="mt-3 border-t border-border/60 pt-3 text-xs">
                <summary className="cursor-pointer font-medium">
                  제공 도구 {entry.tools.length}개
                </summary>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {entry.tools.map((tool) => (
                    <code key={tool} className="rounded bg-muted px-1.5 py-1 text-[10px]">
                      {tool}
                    </code>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ))}
      </div>
      {props.workspaceRoot &&
      settings.mcpProjectProfiles[props.workspaceRoot] &&
      !props.readOnly ? (
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          disabled={busy || !connected}
          onClick={() => void save({ mcpProjectProfileRootsToRemove: [props.workspaceRoot!] })}
        >
          환경의 기본 도구 설정 사용
        </Button>
      ) : null}
      {!props.readOnly ? (
        <McpServerForm
          key={editing?.name ?? "new"}
          editing={editing}
          existingNames={Object.keys(settings.customMcpServers)}
          {...(props.workspaceRoot ? { workspaceRoot: props.workspaceRoot } : {})}
          busy={busy || !connected}
          cancel={() => setEditing(null)}
          save={async (config) => {
            const saved = await save({ customMcpServersToUpsert: { [config.name]: config } });
            if (saved) setEditing(null);
            return saved;
          }}
        />
      ) : null}
      {!catalog ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {!connected
            ? "서버 연결을 기다리고 있습니다."
            : busy
              ? "설치된 도구를 확인하고 있습니다."
              : "연결 검사를 눌러 도구를 불러오세요."}
        </p>
      ) : null}
    </SectionCard>
  );
}
