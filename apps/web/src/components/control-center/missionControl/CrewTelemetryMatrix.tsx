import {
  resolveSubordinateTeam,
  type EnvironmentId,
  type MissionCrewRole,
  type MissionCrewRoleUpsertInput,
  type MissionModelTier,
  type MissionOrgTier,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  BotIcon,
  CheckIcon,
  CrownIcon,
  DownloadIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  CREW_STATUS_META,
  MODEL_TIER_META,
  ORG_TIER_META,
  buildMissionProviderOptions,
  formatRelativeTimeKo,
  isMissionCodingCapableModel,
} from "./missionControlUi.logic";

function CrewRoleRowCard(props: {
  readonly projectId: ProjectId;
  readonly role: MissionCrewRole;
  readonly providerOptions: ReturnType<typeof buildMissionProviderOptions>;
  readonly onSave: (input: MissionCrewRoleUpsertInput) => Promise<void>;
  readonly onDelete: (roleId: string) => Promise<void>;
  readonly busy: boolean;
}) {
  const { role, providerOptions } = props;
  const [providerInstanceId, setProviderInstanceId] = useState(role.providerInstanceId);
  const [modelSlug, setModelSlug] = useState(role.modelSlug);
  const [modelTier, setModelTier] = useState<MissionModelTier>(role.modelTier);
  const [orgTier, setOrgTier] = useState<MissionOrgTier>(role.orgTier ?? "L2_SPECIALIST");
  const [reportsToRoleKey, setReportsToRoleKey] = useState(role.reportsToRoleKey ?? "");
  const [canModerate, setCanModerate] = useState(role.canModerate ?? false);
  const [specialtyTagsLine, setSpecialtyTagsLine] = useState((role.specialtyTags ?? []).join(", "));
  const [fallbackInstanceId, setFallbackInstanceId] = useState(role.fallbackInstanceId ?? "");
  const [fallbackModelSlug, setFallbackModelSlug] = useState(role.fallbackModelSlug ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [systemDirective, setSystemDirective] = useState(role.systemDirective);
  const [saving, setSaving] = useState(false);

  // Sync local draft ONLY when persisted server configuration actually changes
  // (never remount or wipe user edits on heartbeat / status ticks).
  useEffect(() => {
    setProviderInstanceId(role.providerInstanceId);
    setModelSlug(role.modelSlug);
    setModelTier(role.modelTier);
    setOrgTier(role.orgTier ?? "L2_SPECIALIST");
    setReportsToRoleKey(role.reportsToRoleKey ?? "");
    setCanModerate(role.canModerate ?? false);
    setSpecialtyTagsLine((role.specialtyTags ?? []).join(", "));
    setFallbackInstanceId(role.fallbackInstanceId ?? "");
    setFallbackModelSlug(role.fallbackModelSlug ?? "");
    setSystemDirective(role.systemDirective);
  }, [
    role.providerInstanceId,
    role.modelSlug,
    role.modelTier,
    role.orgTier,
    role.reportsToRoleKey,
    role.canModerate,
    role.specialtyTags,
    role.fallbackInstanceId,
    role.fallbackModelSlug,
    role.systemDirective,
  ]);

  const isNonCodingAssigned = !isMissionCodingCapableModel(modelSlug);

  const selectedProvider = useMemo(
    () => providerOptions.find((p) => p.providerInstanceId === providerInstanceId),
    [providerInstanceId, providerOptions],
  );
  const fallbackProvider = useMemo(
    () => providerOptions.find((p) => p.providerInstanceId === fallbackInstanceId),
    [fallbackInstanceId, providerOptions],
  );

  const isDirty =
    providerInstanceId !== role.providerInstanceId ||
    modelSlug !== role.modelSlug ||
    modelTier !== role.modelTier ||
    orgTier !== (role.orgTier ?? "L2_SPECIALIST") ||
    (reportsToRoleKey || null) !== (role.reportsToRoleKey ?? null) ||
    canModerate !== (role.canModerate ?? false) ||
    specialtyTagsLine !== (role.specialtyTags ?? []).join(", ") ||
    (fallbackInstanceId || null) !== role.fallbackInstanceId ||
    (fallbackModelSlug || null) !== role.fallbackModelSlug ||
    systemDirective !== role.systemDirective;

  const statusMeta = CREW_STATUS_META[role.currentStatus];
  const orgMeta = ORG_TIER_META[orgTier];
  const isCoreRole = ["planner", "coder", "reviewer", "digest"].includes(role.roleKey);

  const handleProviderChange = (nextInstanceId: string) => {
    setProviderInstanceId(nextInstanceId);
    const nextProvider = providerOptions.find((p) => p.providerInstanceId === nextInstanceId);
    if (nextProvider && nextProvider.models.length > 0) {
      const stillValid = nextProvider.models.some((m) => m.slug === modelSlug);
      if (!stillValid) {
        setModelSlug(nextProvider.models[0]!.slug);
      }
    }
  };

  const handleFallbackProviderChange = (nextInstanceId: string) => {
    setFallbackInstanceId(nextInstanceId);
    if (!nextInstanceId) {
      setFallbackModelSlug("");
      return;
    }
    const nextProvider = providerOptions.find((p) => p.providerInstanceId === nextInstanceId);
    if (nextProvider && nextProvider.models.length > 0) {
      setFallbackModelSlug(nextProvider.models[0]!.slug);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const parsedTags = specialtyTagsLine
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      await props.onSave({
        projectId: props.projectId,
        id: role.id,
        roleKey: role.roleKey,
        displayName: role.displayName,
        description: role.description,
        providerInstanceId,
        modelSlug: modelSlug.trim() || "default",
        modelTier,
        orgTier,
        reportsToRoleKey: reportsToRoleKey.trim() || null,
        specialtyTags: parsedTags,
        canModerate,
        fallbackInstanceId: fallbackInstanceId ? fallbackInstanceId : null,
        fallbackModelSlug: fallbackInstanceId && fallbackModelSlug ? fallbackModelSlug : null,
        systemDirective,
        allowedTools: [...role.allowedTools],
        maxTurns: role.maxTurns,
        enabled: role.enabled,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <article
      data-crew-card={role.roleKey}
      className="grid gap-2.5 rounded-xl border border-border/80 bg-background/70 p-3 transition-colors hover:border-primary/30"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`size-2 shrink-0 rounded-full ${statusMeta.dotClass}`} />
            <h4 className="truncate text-sm font-semibold">{role.displayName}</h4>
            <Badge variant={orgMeta.variant} size="sm">
              {orgMeta.short}
            </Badge>
            {canModerate ? (
              <Badge variant="warning" size="sm" title="합석 회의실 감독자(진행자) 지정 가능">
                <CrownIcon className="size-2.5" />
                감독 가능
              </Badge>
            ) : null}
            <Badge variant={statusMeta.badgeVariant} size="sm">
              {statusMeta.label}
            </Badge>
          </div>
          {role.description ? (
            <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
              {role.description}
              {reportsToRoleKey ? ` · 보고선: → ${reportsToRoleKey}` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`${role.displayName} 상세 지침 및 폴백 설정`}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <Settings2Icon className="size-3.5" />
          </Button>
          {!isCoreRole ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`${role.displayName} 삭제`}
              disabled={props.busy}
              onClick={() => void props.onDelete(role.id)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* 유동 모델 변경 컨트롤: 등록된 모든 계정·모델 중 즉시 선택 */}
      <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-12">
        <select
          aria-label={`${role.displayName} 프로바이더 계정`}
          className="h-8 w-full min-w-0 truncate rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring sm:col-span-5"
          value={providerInstanceId}
          onChange={(e) => handleProviderChange(e.target.value)}
        >
          {!selectedProvider ? (
            <option value={providerInstanceId}>{providerInstanceId} (현재 설정)</option>
          ) : null}
          {providerOptions.map((opt) => (
            <option key={opt.providerInstanceId} value={opt.providerInstanceId}>
              {opt.displayName} ({opt.driverKind})
            </option>
          ))}
        </select>

        {selectedProvider && selectedProvider.models.length > 0 ? (
          <select
            aria-label={`${role.displayName} 모델`}
            className="h-8 w-full min-w-0 truncate rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring sm:col-span-5"
            value={modelSlug}
            onChange={(e) => setModelSlug(e.target.value)}
          >
            {!selectedProvider.models.some((m) => m.slug === modelSlug) ? (
              <option value={modelSlug}>
                {modelSlug}
                {isNonCodingAssigned ? " (비코딩 모델 — 변경 권장)" : ""}
              </option>
            ) : null}
            {selectedProvider.models.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <Input
            aria-label={`${role.displayName} 모델 직접 입력`}
            className="h-8 w-full min-w-0 text-xs sm:col-span-5"
            value={modelSlug}
            onChange={(e) => setModelSlug(e.target.value)}
            placeholder="모델 슬러그"
          />
        )}

        <select
          aria-label={`${role.displayName} 티어`}
          className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring sm:col-span-2"
          value={modelTier}
          onChange={(e) => setModelTier(e.target.value as MissionModelTier)}
        >
          {(["TIER_S", "TIER_A", "TIER_B"] as const).map((tier) => (
            <option key={tier} value={tier}>
              {tier.replace("TIER_", "T-")}
            </option>
          ))}
        </select>
      </div>
      {isNonCodingAssigned ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          비코딩/미디어 모델({modelSlug})이 배정되어 있습니다. 코딩·추론 모델로 변경 후 적용하세요.
        </p>
      ) : null}

      {showAdvanced ? (
        <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5 text-xs">
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                자율 운영실 상하 계층
              </span>
              <select
                className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                value={orgTier}
                onChange={(e) => setOrgTier(e.target.value as MissionOrgTier)}
              >
                {(["L0_COMMANDER", "L1_LEAD", "L2_SPECIALIST", "L3_SUPPORT"] as const).map((t) => (
                  <option key={t} value={t}>
                    {ORG_TIER_META[t].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                상위 보고 대상 (roleKey)
              </span>
              <Input
                className="h-7 text-xs"
                value={reportsToRoleKey}
                onChange={(e) => setReportsToRoleKey(e.target.value)}
                placeholder="예: planner (없으면 최상위)"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                전문 태그 (희소 선별용)
              </span>
              <Input
                className="h-7 text-xs"
                value={specialtyTagsLine}
                onChange={(e) => setSpecialtyTagsLine(e.target.value)}
                placeholder="coding, quant, review"
              />
            </label>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={canModerate}
              onChange={(e) => setCanModerate(e.target.checked)}
            />
            합석 회의실 주최자(감독자) 역할군 부여 허용
          </label>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                폴백 계정 (429/오류 시 자동 전환)
              </span>
              <select
                className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                value={fallbackInstanceId}
                onChange={(e) => handleFallbackProviderChange(e.target.value)}
              >
                <option value="">자동 선택</option>
                {providerOptions.map((opt) => (
                  <option key={opt.providerInstanceId} value={opt.providerInstanceId}>
                    {opt.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">폴백 모델</span>
              {fallbackProvider && fallbackProvider.models.length > 0 ? (
                <select
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                  value={fallbackModelSlug}
                  onChange={(e) => setFallbackModelSlug(e.target.value)}
                >
                  {fallbackProvider.models.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  className="h-7 text-xs"
                  value={fallbackModelSlug}
                  onChange={(e) => setFallbackModelSlug(e.target.value)}
                  placeholder="폴백 모델명"
                />
              )}
            </label>
          </div>
          <label className="grid gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              고정 역할 지침 (Prompt Cache Layer 1 불변 Prefix)
            </span>
            <textarea
              rows={2}
              className="w-full rounded-md border border-input bg-background p-2 text-xs outline-none focus:ring-2 focus:ring-ring"
              value={systemDirective}
              onChange={(e) => setSystemDirective(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
            <span>허용 도구(캐시 고정):</span>
            {role.allowedTools.map((tool) => (
              <Badge key={tool} variant="outline" size="sm">
                {tool}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2 tabular-nums">
          <span>컨텍스트 {Math.round(role.contextPercent)}%</span>
          <span>·</span>
          <span>
            턴 {role.turnCount}/{role.maxTurns}
          </span>
          <span>·</span>
          <span>{MODEL_TIER_META[modelTier].label}</span>
          <span>·</span>
          <span>DyLAN 기여도 {Math.round((role.importanceScore ?? 0.5) * 100)}%</span>
          {role.lastHeartbeatAtMs ? (
            <>
              <span>·</span>
              <span>최근 {formatRelativeTimeKo(role.lastHeartbeatAtMs)}</span>
            </>
          ) : null}
        </div>

        {isDirty ? (
          <Button
            type="button"
            size="xs"
            disabled={saving || props.busy}
            onClick={() => void handleSave()}
          >
            {saving ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : (
              <CheckIcon className="size-3" />
            )}
            모델 변경 적용
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function GlobalSubordinatesImportButton(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly busy: boolean;
  readonly onUpsertRole: (input: MissionCrewRoleUpsertInput) => Promise<void>;
}) {
  const envSettings = useEnvironmentSettings(props.environmentId);
  const globalSubordinates = useMemo(
    () => resolveSubordinateTeam(envSettings).members.filter((m) => m.enabled !== false),
    [envSettings],
  );
  const [importingGlobal, setImportingGlobal] = useState(false);

  if (globalSubordinates.length === 0) return null;

  const handleImportGlobalSubordinates = async () => {
    if (importingGlobal) return;
    setImportingGlobal(true);
    try {
      for (let i = 0; i < globalSubordinates.length; i += 1) {
        const sub = globalSubordinates[i]!;
        if (!isMissionCodingCapableModel(sub.model)) continue;
        const roleKey = `sub_${sub.role}_${i + 1}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const orgTier: MissionOrgTier =
          sub.role === "planner" || sub.role === "advisor" || sub.role === "diagnostician"
            ? "L1_LEAD"
            : sub.role === "writer" || sub.role === "translator"
              ? "L3_SUPPORT"
              : "L2_SPECIALIST";
        const tags =
          sub.role === "diagnostician" || sub.role === "advisor"
            ? ["review", "verification", "security"]
            : sub.role === "scout" || sub.role === "analyst"
              ? ["research", "quant", "analysis"]
              : sub.role === "writer" || sub.role === "translator"
                ? ["documentation", "summary"]
                : sub.role === "planner"
                  ? ["planning", "architecture"]
                  : ["coding", "implementation"];
        await props.onUpsertRole({
          projectId: props.projectId,
          roleKey,
          displayName: `하위 팀 · ${sub.role} (${sub.instanceId})`,
          description: sub.instructions ?? "전역 하위 팀에서 가져온 전문 역할군",
          providerInstanceId: sub.instanceId,
          modelSlug: sub.model,
          modelTier: sub.role === "writer" || sub.role === "translator" ? "TIER_B" : "TIER_A",
          orgTier,
          reportsToRoleKey: orgTier === "L1_LEAD" ? null : "planner",
          specialtyTags: tags,
          canModerate: orgTier === "L1_LEAD",
          systemDirective: sub.instructions ?? "",
        });
      }
    } finally {
      setImportingGlobal(false);
    }
  };

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={props.busy || importingGlobal}
      onClick={() => void handleImportGlobalSubordinates()}
      title="설정의 전역 하위 팀 멤버들을 이 프로젝트 통합 조직 역할군으로 한 번에 불러옵니다"
    >
      <DownloadIcon className="size-3.5" />
      전역 하위 팀 불러오기 ({globalSubordinates.length})
    </Button>
  );
}

export function CrewTelemetryMatrix(props: {
  readonly environmentId?: EnvironmentId;
  readonly projectId: ProjectId;
  readonly roles: ReadonlyArray<MissionCrewRole>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onUpsertRole: (input: MissionCrewRoleUpsertInput) => Promise<void>;
  readonly onDeleteRole: (roleId: string) => Promise<void>;
  readonly busy: boolean;
}) {
  const providerOptions = useMemo(
    () => buildMissionProviderOptions(props.providers),
    [props.providers],
  );
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newProviderId, setNewProviderId] = useState(
    providerOptions[0]?.providerInstanceId ?? "codex",
  );
  const [newModelSlug, setNewModelSlug] = useState(
    providerOptions[0]?.models[0]?.slug ?? "default",
  );
  const [newTier, setNewTier] = useState<MissionModelTier>("TIER_A");
  const [newOrgTier, setNewOrgTier] = useState<MissionOrgTier>("L2_SPECIALIST");

  const handleAddCrew = async () => {
    const key = newKey
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
    const displayName = newName.trim();
    if (!key || !displayName) return;
    await props.onUpsertRole({
      projectId: props.projectId,
      roleKey: key,
      displayName,
      providerInstanceId: newProviderId,
      modelSlug: newModelSlug || "default",
      modelTier: newTier,
      orgTier: newOrgTier,
      reportsToRoleKey:
        newOrgTier === "L2_SPECIALIST" || newOrgTier === "L3_SUPPORT" ? "planner" : null,
      canModerate: newOrgTier === "L0_COMMANDER" || newOrgTier === "L1_LEAD",
    });
    setNewKey("");
    setNewName("");
    setAdding(false);
  };

  return (
    <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BotIcon className="size-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">통합 조직 · 역할군 · 유동 모델 배정</h3>
            <p className="text-[11px] text-muted-foreground">
              자율 운영실에서는 L0→L3 상하 지휘 체계로, 합석 회의실에서는 감독자 제외 전원 동등한
              전문가로 참여합니다.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {props.environmentId ? (
            <GlobalSubordinatesImportButton
              environmentId={props.environmentId}
              projectId={props.projectId}
              busy={props.busy}
              onUpsertRole={props.onUpsertRole}
            />
          ) : null}
          <Button type="button" size="xs" variant="outline" onClick={() => setAdding((v) => !v)}>
            <PlusIcon className="size-3.5" />
            크루 추가
          </Button>
        </div>
      </div>

      {adding ? (
        <div className="grid gap-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              className="h-8 text-xs"
              placeholder="역할 키 (예: security, qa, docs)"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
            <Input
              className="h-8 text-xs"
              placeholder="표시 이름 (예: 보안 감사실)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
            <select
              className="h-8 w-full min-w-0 truncate rounded-lg border border-input bg-background px-2 text-xs"
              value={newProviderId}
              onChange={(e) => {
                setNewProviderId(e.target.value);
                const found = providerOptions.find((p) => p.providerInstanceId === e.target.value);
                if (found?.models[0]) setNewModelSlug(found.models[0].slug);
              }}
            >
              {providerOptions.map((opt) => (
                <option key={opt.providerInstanceId} value={opt.providerInstanceId}>
                  {opt.displayName}
                </option>
              ))}
            </select>
            {(() => {
              const found = providerOptions.find((p) => p.providerInstanceId === newProviderId);
              return found && found.models.length > 0 ? (
                <select
                  aria-label="새 크루 모델"
                  className="h-8 w-full min-w-0 truncate rounded-lg border border-input bg-background px-2 text-xs"
                  value={newModelSlug}
                  onChange={(e) => setNewModelSlug(e.target.value)}
                >
                  {found.models.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  className="h-8 w-full min-w-0 text-xs"
                  placeholder="모델명"
                  value={newModelSlug}
                  onChange={(e) => setNewModelSlug(e.target.value)}
                />
              );
            })()}
            <select
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs"
              value={newTier}
              onChange={(e) => setNewTier(e.target.value as MissionModelTier)}
            >
              <option value="TIER_S">Tier S (심층)</option>
              <option value="TIER_A">Tier A (구현)</option>
              <option value="TIER_B">Tier B (경량)</option>
            </select>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <select
              aria-label="새 크루 상하 계층"
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs"
              value={newOrgTier}
              onChange={(e) => setNewOrgTier(e.target.value as MissionOrgTier)}
            >
              {(["L0_COMMANDER", "L1_LEAD", "L2_SPECIALIST", "L3_SUPPORT"] as const).map((t) => (
                <option key={t} value={t}>
                  {ORG_TIER_META[t].label}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(false)}>
                취소
              </Button>
              <Button
                type="button"
                size="xs"
                disabled={!newKey.trim() || !newName.trim() || props.busy}
                onClick={() => void handleAddCrew()}
              >
                크루 저장
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid min-w-0 gap-2.5">
        {props.roles.map((role) => (
          <CrewRoleRowCard
            key={role.id}
            projectId={props.projectId}
            role={role}
            providerOptions={providerOptions}
            onSave={props.onUpsertRole}
            onDelete={props.onDeleteRole}
            busy={props.busy}
          />
        ))}
      </div>
    </section>
  );
}
