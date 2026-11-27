import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DriveBackupDryRunResult,
  DriveBackupRunKind,
  DriveBackupRunStatus,
  DriveBackupSyncMirrorResult,
  DriveBackupTarget,
  DriveBackupTargetKind,
  DriveBackupTransportMode,
  DriveBackupVerifyRestoreResult,
  EnrolledGoogleAccountSummary,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CloudIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  HardDriveIcon,
  KeyRoundIcon,
  PlayIcon,
  RefreshCcwIcon,
  ScanSearchIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SectionCard, notifyCommandFailure, notifySuccess } from "./controlCenterShared";

export function formatBackupBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 100 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

export function summarizeSelectedTargets(targets: ReadonlyArray<DriveBackupTarget>): {
  readonly selectedCount: number;
  readonly totalCount: number;
  readonly riskySelectedCount: number;
  readonly gitRepoCount: number;
} {
  let selectedCount = 0;
  let riskySelectedCount = 0;
  let gitRepoCount = 0;
  for (const t of targets) {
    if (t.enabled) {
      selectedCount += 1;
      if (t.riskWarning) riskySelectedCount += 1;
    }
    if (t.isGitRepo) gitRepoCount += 1;
  }
  return {
    selectedCount,
    totalCount: targets.length,
    riskySelectedCount,
    gitRepoCount,
  };
}

export function runStatusLabelKr(status: DriveBackupRunStatus): string {
  switch (status) {
    case "running":
      return "실행 중";
    case "succeeded":
      return "성공";
    case "partial":
      return "부분 성공";
    case "failed":
      return "실패";
    case "skipped_busy":
      return "유휴 양보";
  }
}

export function runStatusBadgeVariant(
  status: DriveBackupRunStatus,
): "success" | "warning" | "error" | "info" | "outline" {
  switch (status) {
    case "succeeded":
      return "success";
    case "running":
      return "info";
    case "skipped_busy":
    case "partial":
      return "warning";
    case "failed":
      return "error";
  }
}

export function runKindLabelKr(kind: DriveBackupRunKind): string {
  switch (kind) {
    case "backup":
      return "선택 백업";
    case "restore_verify":
      return "복구 검증";
    case "knowledge_mirror":
      return "지식 미러";
  }
}

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString("ko-KR");
}

export function DriveBackupSection({ project }: { readonly project: EnvironmentProject }) {
  const stateAtom = useMemo(
    () =>
      orchestrationEnvironment.driveBackupState({
        environmentId: project.environmentId,
        input: {},
      }),
    [project.environmentId],
  );
  const stateQuery = useEnvironmentQuery(stateAtom);
  const updateConfigCmd = useAtomCommand(orchestrationEnvironment.updateDriveBackupConfig);
  const upsertTargetCmd = useAtomCommand(orchestrationEnvironment.upsertDriveBackupTarget);
  const deleteTargetCmd = useAtomCommand(orchestrationEnvironment.deleteDriveBackupTarget);
  const dryRunCmd = useAtomCommand(orchestrationEnvironment.dryRunDriveBackup);
  const runNowCmd = useAtomCommand(orchestrationEnvironment.runDriveBackupNow);
  const verifyRestoreCmd = useAtomCommand(orchestrationEnvironment.verifyDriveBackupRestore);
  const syncMirrorCmd = useAtomCommand(orchestrationEnvironment.syncDriveKnowledgeMirror);

  const snapshot = stateQuery.data;
  const config = snapshot?.config;

  const [transportMode, setTransportMode] = useState<DriveBackupTransportMode>("gdrive_api");
  const [localDriveRoot, setLocalDriveRoot] = useState("");
  const [gdriveFolderName, setGdriveFolderName] = useState("T3-Backup");
  const [gdriveKnowledgeFolderName, setGdriveKnowledgeFolderName] = useState("T3-Knowledge");
  const [gdriveEmail, setGdriveEmail] = useState("");
  const [gdriveClientId, setGdriveClientId] = useState("");
  const [gdriveClientSecret, setGdriveClientSecret] = useState("");
  const [gdriveRefreshToken, setGdriveRefreshToken] = useState("");
  const [encryptionEnabled, setEncryptionEnabled] = useState(true);
  const [encryptionPassphrase, setEncryptionPassphrase] = useState("");
  const [retentionCount, setRetentionCount] = useState("7");
  const [includeCoreSettings, setIncludeCoreSettings] = useState(true);
  const [includeCoreSqliteSnapshot, setIncludeCoreSqliteSnapshot] = useState(false);
  const [autoSyncIdleOnly, setAutoSyncIdleOnly] = useState(true);

  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoPath, setNewRepoPath] = useState("");
  const [newRepoKind, setNewRepoKind] = useState<DriveBackupTargetKind>("repo");

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DriveBackupDryRunResult | null>(null);
  const [verifyResult, setVerifyResult] = useState<DriveBackupVerifyRestoreResult | null>(null);
  const [mirrorResult, setMirrorResult] = useState<DriveBackupSyncMirrorResult | null>(null);
  const [linkedGoogleAccounts, setLinkedGoogleAccounts] = useState<
    ReadonlyArray<EnrolledGoogleAccountSummary>
  >([]);

  const refreshLinkedAccounts = useCallback(async () => {
    const listAccounts =
      typeof window !== "undefined"
        ? window.desktopBridge?.googleSignIn?.listAccountsT3
        : undefined;
    if (!listAccounts) return;
    try {
      const res = await listAccounts();
      setLinkedGoogleAccounts(res.accounts);
    } catch {
      // ignore if unavailable
    }
  }, []);

  useEffect(() => {
    void refreshLinkedAccounts();
  }, [refreshLinkedAccounts]);

  const handleBindGoogleAccount = async (account: EnrolledGoogleAccountSummary) => {
    const bindFn =
      typeof window !== "undefined"
        ? window.desktopBridge?.googleSignIn?.bindDriveBackupAccountT3
        : undefined;
    if (!bindFn) return;
    setBusyAction(`bind-google:${account.subject}`);
    try {
      const res = await bindFn(account.subject);
      notifySuccess(
        "Google Drive 백업 계정 연결 완료",
        `${res.email ?? account.email ?? account.subject} 계정이 드라이브 백업 대상으로 활성화되었습니다.`,
      );
      stateQuery.refresh();
    } catch {
      toastManager.add({
        type: "error",
        title: "Google Drive 계정 연결 실패",
        description: "설정 → Google 계정에서 Drive 백업 권한 체크 후 계정을 등록해 주세요.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    if (!config) return;
    setTransportMode(config.transportMode);
    setLocalDriveRoot(config.localDriveRoot ?? "");
    setGdriveFolderName(config.gdriveFolderName);
    setGdriveKnowledgeFolderName(config.gdriveKnowledgeFolderName);
    setGdriveEmail(config.gdriveConnectedEmail ?? "");
    setEncryptionEnabled(config.encryptionEnabled);
    setRetentionCount(String(config.retentionCount));
    setIncludeCoreSettings(config.includeCoreSettings);
    setIncludeCoreSqliteSnapshot(config.includeCoreSqliteSnapshot);
    setAutoSyncIdleOnly(config.autoSyncIdleOnly);
  }, [config]);

  const summary = useMemo(
    () => summarizeSelectedTargets(snapshot?.targets ?? []),
    [snapshot?.targets],
  );

  const handleSaveConfig = async () => {
    setBusyAction("save-config");
    try {
      const parsedRetention = Math.max(1, Math.min(90, Number(retentionCount) || 7));
      const result = await updateConfigCmd({
        environmentId: project.environmentId,
        input: {
          transportMode,
          localDriveRoot: localDriveRoot.trim() || null,
          gdriveFolderName: gdriveFolderName.trim() || "T3-Backup",
          gdriveKnowledgeFolderName: gdriveKnowledgeFolderName.trim() || "T3-Knowledge",
          gdriveConnectedEmail: gdriveEmail.trim() || null,
          ...(gdriveClientId.trim() ? { gdriveClientId: gdriveClientId.trim() } : {}),
          ...(gdriveClientSecret.trim() ? { gdriveClientSecret: gdriveClientSecret.trim() } : {}),
          ...(gdriveRefreshToken.trim() ? { gdriveRefreshToken: gdriveRefreshToken.trim() } : {}),
          encryptionEnabled,
          ...(encryptionPassphrase.trim()
            ? { encryptionPassphrase: encryptionPassphrase.trim() }
            : {}),
          retentionCount: parsedRetention,
          includeCoreSettings,
          includeCoreSqliteSnapshot,
          autoSyncIdleOnly,
        },
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "구글 드라이브 백업 설정 저장 실패");
        return;
      }
      setGdriveClientId("");
      setGdriveClientSecret("");
      setGdriveRefreshToken("");
      setEncryptionPassphrase("");
      notifySuccess(
        "백업 설정 저장 완료",
        "암호화 키와 OAuth 자격증명은 로컬 DPAPI에 안전 보관됩니다.",
      );
      stateQuery.refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleTarget = async (
    target: DriveBackupTarget,
    patch: Partial<
      Pick<DriveBackupTarget, "enabled" | "syncFiles" | "syncT3Scope" | "syncDriveToLocalRag">
    >,
  ) => {
    setBusyAction(`target:${target.id}`);
    try {
      const result = await upsertTargetCmd({
        environmentId: project.environmentId,
        input: {
          id: target.id,
          kind: target.kind,
          projectId: target.projectId,
          displayName: target.displayName,
          rootPath: target.rootPath,
          enabled: patch.enabled ?? target.enabled,
          syncFiles: patch.syncFiles ?? target.syncFiles,
          syncT3Scope: patch.syncT3Scope ?? target.syncT3Scope,
          syncDriveToLocalRag: patch.syncDriveToLocalRag ?? target.syncDriveToLocalRag,
          excludeGlobs: [...target.excludeGlobs],
        },
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "백업 대상 변경 실패");
        return;
      }
      stateQuery.refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleAddTarget = async () => {
    const name = newRepoName.trim();
    const rootPath = newRepoPath.trim();
    if (!name || !rootPath) return;
    setBusyAction("add-target");
    try {
      const result = await upsertTargetCmd({
        environmentId: project.environmentId,
        input: {
          kind: newRepoKind,
          displayName: name,
          rootPath,
          enabled: true,
          syncFiles: true,
          syncT3Scope: false,
          syncDriveToLocalRag: false,
        },
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "저장소·폴더 추가 실패");
        return;
      }
      setNewRepoName("");
      setNewRepoPath("");
      notifySuccess("백업 대상 추가 완료", `'${name}' 항목이 선택 목록에 추가되었습니다.`);
      stateQuery.refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteTarget = async (target: DriveBackupTarget) => {
    setBusyAction(`delete:${target.id}`);
    try {
      const result = await deleteTargetCmd({
        environmentId: project.environmentId,
        input: { targetId: target.id },
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "백업 대상 제거 실패");
        return;
      }
      notifySuccess("대상 제거됨", `'${target.displayName}' 항목을 목록에서 제거했습니다.`);
      stateQuery.refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleDryRun = async () => {
    setBusyAction("dry-run");
    try {
      const result = await dryRunCmd({
        environmentId: project.environmentId,
        input: {},
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "Dry-Run 미리보기 실패");
        return;
      }
      setDryRunResult(result.value);
      notifySuccess(
        "미리보기 완료",
        `선택 ${result.value.selectedTargetsCount}개 · 파일 ${result.value.totalFilesCount.toLocaleString()}개 · 차단 시크릿 ${result.value.totalBlockedSecretsCount}건`,
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunBackup = async (forceWhenBusy = false) => {
    setBusyAction("run-now");
    try {
      const result = await runNowCmd({
        environmentId: project.environmentId,
        input: { forceWhenBusy },
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "구글 드라이브 백업 실행 실패");
        return;
      }
      const run = result.value;
      if (run.status === "skipped_busy") {
        notifySuccess("유휴 대기 양보", run.errorMessage ?? "활성 작업 완료 후 다시 실행하세요.");
      } else {
        notifySuccess(
          "선택 항목 백업 완료",
          `파일 ${run.fileCount.toLocaleString()}개 (${formatBackupBytes(run.archiveBytes)}) · 차단 시크릿 ${run.skippedSecretsCount}건`,
        );
      }
      stateQuery.refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerifyRestore = async (runId?: string) => {
    setBusyAction("verify-restore");
    try {
      const result = await verifyRestoreCmd({
        environmentId: project.environmentId,
        input: runId ? { runId } : {},
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "복구 무결성 검증 실패");
        return;
      }
      setVerifyResult(result.value);
      notifySuccess("복구 무결성 검증 통과", result.value.message);
      stateQuery.refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleSyncMirror = async () => {
    setBusyAction("sync-mirror");
    try {
      const result = await syncMirrorCmd({
        environmentId: project.environmentId,
        input: {},
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "드라이브 지식 미러 동기화 실패");
        return;
      }
      setMirrorResult(result.value);
      notifySuccess("지식 미러 동기화 완료", result.value.message);
      stateQuery.refresh();
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section id="drive-backup" className="grid gap-5 scroll-mt-24">
      <SectionCard
        icon={CloudIcon}
        scopeLabel="전역 선택형 백업"
        title="구글 드라이브 선택형 백업 & 양방향 지식 미러"
        description="T3에 등록된 프로젝트 폴더와 직접 지정한 저장소 중 사용자가 직접 켠(ON) 항목만 AES-256-GCM 암호화하여 Google Drive에 백업합니다. 비선택 폴더는 0바이트도 전송하지 않으며 .env·개인키·지갑 파일은 자동 차단됩니다."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() => stateQuery.refresh()}
            >
              <RefreshCcwIcon className="size-3.5" />
              새로고침
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busyAction !== null || summary.selectedCount === 0}
              onClick={handleDryRun}
            >
              <ScanSearchIcon className="size-3.5" />
              미리보기 (Dry-Run)
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busyAction !== null || summary.selectedCount === 0}
              onClick={() => handleRunBackup(false)}
            >
              <PlayIcon className="size-3.5" />
              지금 선택 항목 백업
            </Button>
          </div>
        }
      >
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={summary.selectedCount > 0 ? "info" : "outline"}>
              선택 대상 {summary.selectedCount} / {summary.totalCount}개
            </Badge>
            <Badge variant={config?.encryptionEnabled ? "success" : "warning"}>
              <KeyRoundIcon className="size-3" />
              {config?.encryptionEnabled
                ? config.keyFingerprint
                  ? `AES-256-GCM 활성 (${config.keyFingerprint})`
                  : "암호화 비밀번호 미설정"
                : "평문 압축(.t3arc)"}
            </Badge>
            <Badge variant={config?.transportMode === "local_drive_folder" ? "info" : "outline"}>
              {config?.transportMode === "local_drive_folder"
                ? "모드 A: 로컬 Google Drive 폴더"
                : config?.gdriveHasCredentials
                  ? "모드 B: Drive API v3 연결됨"
                  : "모드 B: Drive API 미연결"}
            </Badge>
            <Badge variant={(snapshot?.activeWorkCount ?? 0) > 0 ? "warning" : "success"}>
              진행 중 활성 작업 {snapshot?.activeWorkCount ?? 0}건
            </Badge>
            {summary.riskySelectedCount > 0 ? (
              <Badge variant="warning">
                <AlertTriangleIcon className="size-3" />
                민감 폴더 {summary.riskySelectedCount}개 선택됨 — 암호화 필수
              </Badge>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() => handleVerifyRestore()}
            >
              <ShieldCheckIcon className="size-3.5" />
              최근 백업 복구 무결성 검증
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busyAction !== null}
              onClick={handleSyncMirror}
            >
              <HardDriveIcon className="size-3.5" />
              드라이브 지식 폴더 → 로컬 미러 동기화
            </Button>
            {(snapshot?.activeWorkCount ?? 0) > 0 ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busyAction !== null || summary.selectedCount === 0}
                onClick={() => handleRunBackup(true)}
              >
                활성 작업 무시하고 읽기 전용 백업 강제 실행
              </Button>
            ) : null}
          </div>

          {verifyResult ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/8 p-3 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-300">
                <CheckCircle2Icon className="size-4" />
                {verifyResult.message}
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground break-all">
                SHA-256: {verifyResult.manifestSha256} · 경로: {verifyResult.archivePath}
              </div>
            </div>
          ) : null}

          {mirrorResult ? (
            <div className="rounded-xl border border-sky-500/30 bg-sky-500/8 p-3 text-xs">
              <div className="font-semibold text-sky-700 dark:text-sky-300">
                {mirrorResult.message}
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground break-all">
                로컬 미러 경로: {mirrorResult.mirrorLocalDir} (전송{" "}
                {formatBackupBytes(mirrorResult.totalBytes)})
              </div>
            </div>
          ) : null}
        </div>
      </SectionCard>

      {/* 2. 연결 방식 & 암호화·보존 설정 */}
      <SectionCard
        icon={KeyRoundIcon}
        scopeLabel="전송 · 암호화 설정"
        title="Google Drive 연결 방식 및 Zero-Knowledge 암호화"
        description="Google Drive for Desktop 없이도 Google Drive API v3 (OAuth2 drive.file 최소 스코프)로 직접 백업하거나, PC에 설치된 Google Drive 로컬 폴더에 즉시 기록할 수 있습니다."
        action={
          <Button type="button" size="sm" disabled={busyAction !== null} onClick={handleSaveConfig}>
            설정 저장
          </Button>
        }
      >
        <div className="grid gap-4">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={transportMode === "gdrive_api" ? "default" : "outline"}
              onClick={() => setTransportMode("gdrive_api")}
            >
              모드 B: Google Drive API v3 (권장 · 앱 설치 불필요)
            </Button>
            <Button
              type="button"
              size="sm"
              variant={transportMode === "local_drive_folder" ? "default" : "outline"}
              onClick={() => setTransportMode("local_drive_folder")}
            >
              모드 A: 로컬 Google Drive 폴더 직결
            </Button>
          </div>

          {transportMode === "local_drive_folder" ? (
            <div className="grid gap-2 rounded-xl border border-border bg-muted/20 p-3.5">
              <label className="text-xs font-medium">로컬 Google Drive 루트 폴더 경로</label>
              <Input
                value={localDriveRoot}
                onChange={(e) => setLocalDriveRoot(e.target.value)}
                placeholder="예: G:\내 드라이브 또는 D:\GoogleDriveSync"
              />
              {snapshot && snapshot.detectedLocalDriveRoots.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>자동 감지됨:</span>
                  {snapshot.detectedLocalDriveRoots.map((root) => (
                    <Button
                      key={root}
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => setLocalDriveRoot(root)}
                    >
                      {root}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Google Drive 데스크톱 마운트 폴더가 감지되지 않았습니다. 직접 로컬 동기화 폴더를
                  지정하거나 모드 B(API v3)를 사용하세요.
                </p>
              )}
            </div>
          ) : (
            <div className="grid gap-3 rounded-xl border border-border bg-muted/20 p-3.5">
              {linkedGoogleAccounts.length > 0 ? (
                <div className="grid gap-2 rounded-lg border border-primary/25 bg-primary/5 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-foreground">
                      등록된 T3 로컬 Google 계정에서 1클릭 연결
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      수동 토큰 입력 없이 DPAPI에 저장된 Drive 권한을 바로 사용합니다.
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {linkedGoogleAccounts.map((acc) => (
                      <Button
                        key={acc.subject}
                        type="button"
                        size="xs"
                        variant={
                          config?.gdriveConnectedEmail && config.gdriveConnectedEmail === acc.email
                            ? "default"
                            : "outline"
                        }
                        disabled={busyAction !== null || !acc.driveBackupLinked}
                        onClick={() => void handleBindGoogleAccount(acc)}
                      >
                        {acc.label || acc.email || acc.subject}
                        {acc.tier ? ` (${acc.tier.toUpperCase()})` : ""}
                        {acc.driveBackupLinked ? "" : " · Drive 미연결"}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium">Google Drive 백업 루트 폴더명</label>
                  <Input
                    value={gdriveFolderName}
                    onChange={(e) => setGdriveFolderName(e.target.value)}
                    placeholder="T3-Backup"
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium">
                    양방향 지식 미러 폴더명 (드라이브 → T3)
                  </label>
                  <Input
                    value={gdriveKnowledgeFolderName}
                    onChange={(e) => setGdriveKnowledgeFolderName(e.target.value)}
                    placeholder="T3-Knowledge"
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium">연결 Google 계정 표시 이메일 (선택)</label>
                  <Input
                    value={gdriveEmail}
                    onChange={(e) => setGdriveEmail(e.target.value)}
                    placeholder="user@gmail.com"
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium">
                    OAuth2 Client ID (수동 입력 · 변경 시)
                  </label>
                  <Input
                    value={gdriveClientId}
                    onChange={(e) => setGdriveClientId(e.target.value)}
                    placeholder={
                      config?.gdriveHasCredentials
                        ? "저장됨 (변경하려면 새 값 입력)"
                        : "xxxx.apps.googleusercontent.com"
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium">OAuth2 Client Secret</label>
                  <Input
                    type="password"
                    value={gdriveClientSecret}
                    onChange={(e) => setGdriveClientSecret(e.target.value)}
                    placeholder={
                      config?.gdriveHasCredentials
                        ? "•••••••• (DPAPI 암호화 보관 중)"
                        : "GOCSPX-..."
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium">
                    OAuth2 Refresh Token (`drive.file` 스코프)
                  </label>
                  <Input
                    type="password"
                    value={gdriveRefreshToken}
                    onChange={(e) => setGdriveRefreshToken(e.target.value)}
                    placeholder={
                      config?.gdriveHasCredentials ? "•••••••• (DPAPI 암호화 보관 중)" : "1//0..."
                    }
                  />
                </div>
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <label className="text-xs font-medium">AES-256-GCM 암호화 비밀번호 (4자 이상)</label>
              <Input
                type="password"
                value={encryptionPassphrase}
                onChange={(e) => setEncryptionPassphrase(e.target.value)}
                placeholder={
                  config?.keyFingerprint
                    ? `설정됨 (지문 ${config.keyFingerprint}) — 변경 시 입력`
                    : "새 백업 복구 비밀번호 입력"
                }
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs font-medium">대상별 롤링 보존 세대 수 (1~90)</label>
              <Input
                type="number"
                min={1}
                max={90}
                value={retentionCount}
                onChange={(e) => setRetentionCount(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">로컬 스테이징 · 미러 경로</span>
              <span className="truncate font-mono text-[11px]" title={snapshot?.localStagingDir}>
                롤링: {snapshot?.localStagingDir ?? "-"}
              </span>
              <span className="truncate font-mono text-[11px]" title={snapshot?.mirrorLocalDir}>
                미러: {snapshot?.mirrorLocalDir ?? "-"}
              </span>
            </div>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs">
              <span>Zero-Knowledge AES-256-GCM 로컬 암호화 (.t3enc)</span>
              <Switch checked={encryptionEnabled} onCheckedChange={setEncryptionEnabled} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs">
              <span>다른 채팅방/오케스트라 작업 실행 중 자동 유휴 양보</span>
              <Switch checked={autoSyncIdleOnly} onCheckedChange={setAutoSyncIdleOnly} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs">
              <span>T3 코어 설정·단축키 백업 (비밀키 자동 마스킹)</span>
              <Switch checked={includeCoreSettings} onCheckedChange={setIncludeCoreSettings} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs">
              <span>T3 state.sqlite 읽기 전용 스냅샷 포함 (VACUUM INTO · 대용량)</span>
              <Switch
                checked={includeCoreSqliteSnapshot}
                onCheckedChange={setIncludeCoreSqliteSnapshot}
              />
            </label>
          </div>
        </div>
      </SectionCard>

      {/* 3. 선택형 프로젝트 & 저장소 체크리스트 */}
      <SectionCard
        icon={FolderGit2Icon}
        scopeLabel="Opt-In 선택 목록"
        title="백업할 T3 프로젝트 폴더 · Git 저장소 선택"
        description="기본값은 모두 OFF입니다. 백업을 켠(ON) 항목만 패킹·암호화되어 업로드되며, 비선택 항목은 드라이브로 0바이트도 전송되지 않습니다."
      >
        <div className="grid gap-4">
          <div className="grid gap-2">
            {(snapshot?.targets ?? []).map((target) => {
              const isCurrentProject = target.projectId === project.id;
              return (
                <div
                  key={target.id}
                  className={`grid gap-2.5 rounded-xl border p-3.5 transition-colors ${
                    target.enabled ? "border-primary/40 bg-primary/4" : "border-border bg-card/60"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold">{target.displayName}</span>
                        <Badge variant="outline" size="sm">
                          {target.kind === "project"
                            ? "T3 프로젝트"
                            : target.kind === "core"
                              ? "T3 본체"
                              : "추가 저장소"}
                        </Badge>
                        {isCurrentProject ? (
                          <Badge variant="info" size="sm">
                            현재 프로젝트
                          </Badge>
                        ) : null}
                        {target.isGitRepo ? (
                          <Badge variant="success" size="sm">
                            Git bundle 지원
                          </Badge>
                        ) : null}
                        {!target.existsOnDisk ? (
                          <Badge variant="error" size="sm">
                            경로 없음
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                        {target.rootPath}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                        <span>대화 {target.threadCount.toLocaleString()}건</span>
                        <span>장기기억 {target.memoryCount.toLocaleString()}건</span>
                        <span>최근 백업: {formatMs(target.lastBackedUpAtMs)}</span>
                      </div>
                      {target.riskWarning ? (
                        <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-amber-500/12 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                          <AlertTriangleIcon className="size-3.5 shrink-0" />
                          {target.riskWarning}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">
                        {target.enabled ? "백업 ON" : "제외 (OFF)"}
                      </span>
                      <Switch
                        checked={target.enabled}
                        disabled={busyAction !== null}
                        onCheckedChange={(checked) =>
                          handleToggleTarget(target, { enabled: checked })
                        }
                      />
                      {target.kind === "repo" ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={busyAction !== null}
                          onClick={() => handleDeleteTarget(target)}
                          aria-label={`${target.displayName} 제거`}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {target.enabled ? (
                    <div className="flex flex-wrap gap-3 border-t border-border/60 pt-2.5 text-xs">
                      <label className="inline-flex items-center gap-2">
                        <Switch
                          checked={target.syncFiles}
                          disabled={busyAction !== null}
                          onCheckedChange={(checked) =>
                            handleToggleTarget(target, { syncFiles: checked })
                          }
                        />
                        <span>폴더 파일 · Git bundle 업로드</span>
                      </label>
                      {target.projectId ? (
                        <label className="inline-flex items-center gap-2">
                          <Switch
                            checked={target.syncT3Scope}
                            disabled={busyAction !== null}
                            onCheckedChange={(checked) =>
                              handleToggleTarget(target, { syncT3Scope: checked })
                            }
                          />
                          <span>이 프로젝트의 T3 대화·기억·미션 추출 백업</span>
                        </label>
                      ) : null}
                      <label className="inline-flex items-center gap-2">
                        <Switch
                          checked={target.syncDriveToLocalRag}
                          disabled={busyAction !== null}
                          onCheckedChange={(checked) =>
                            handleToggleTarget(target, { syncDriveToLocalRag: checked })
                          }
                        />
                        <span>드라이브 지식 → 로컬 RAG 활용</span>
                      </label>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* 사용자 저장소 / 폴더 직접 추가 */}
          <div className="grid gap-2.5 rounded-xl border border-dashed border-border bg-muted/15 p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <FolderPlusIcon className="size-3.5 text-primary" />
              추가 폴더 · Git 저장소 직접 등록
            </div>
            <div className="grid gap-2 sm:grid-cols-12">
              <Input
                className="sm:col-span-3"
                value={newRepoName}
                onChange={(e) => setNewRepoName(e.target.value)}
                placeholder="표시 이름 (예: MyResearch)"
              />
              <Input
                className="sm:col-span-6"
                value={newRepoPath}
                onChange={(e) => setNewRepoPath(e.target.value)}
                placeholder="절대 경로 (예: D:\Projects\MyResearch)"
              />
              <select
                value={newRepoKind}
                onChange={(e) => setNewRepoKind(e.target.value as DriveBackupTargetKind)}
                className="h-9 rounded-lg border border-input bg-background px-2.5 text-xs sm:col-span-2"
              >
                <option value="repo">Git 저장소/폴더</option>
                <option value="project">프로젝트</option>
              </select>
              <Button
                type="button"
                size="sm"
                className="sm:col-span-1"
                disabled={busyAction !== null || !newRepoName.trim() || !newRepoPath.trim()}
                onClick={handleAddTarget}
              >
                추가
              </Button>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* 4. Dry-Run 미리보기 결과 */}
      {dryRunResult ? (
        <SectionCard
          icon={ScanSearchIcon}
          scopeLabel="사전 검증"
          title="Dry-Run 선택 백업 미리보기"
          description={`선택 ${dryRunResult.selectedTargetsCount}개 · 총 ${dryRunResult.totalFilesCount.toLocaleString()}개 파일 · 원문 ${formatBackupBytes(dryRunResult.totalRawBytes)} → 예상 압축 ${formatBackupBytes(dryRunResult.totalEstimatedArchiveBytes)} · 차단 시크릿 ${dryRunResult.totalBlockedSecretsCount}건`}
        >
          <div className="grid gap-2">
            {dryRunResult.targets.map((item) => (
              <div
                key={item.targetId}
                className="rounded-lg border border-border bg-card/70 p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{item.displayName}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    파일 {item.includedFilesCount.toLocaleString()}개 · 원문{" "}
                    {formatBackupBytes(item.estimatedRawBytes)} · 예상 압축{" "}
                    {formatBackupBytes(item.estimatedArchiveBytes)}
                  </span>
                </div>
                {item.blockedSecretsCount > 0 ? (
                  <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                    자동 차단된 민감 파일 {item.blockedSecretsCount}건:{" "}
                    {item.blockedSecretsSample.join(", ")}
                  </p>
                ) : null}
                {item.warnings.length > 0 ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    참고: {item.warnings.join(" / ")}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {/* 5. 최근 실행 이력 */}
      <SectionCard
        icon={ShieldCheckIcon}
        scopeLabel="실행 원장"
        title="최근 백업 · 복구 검증 · 지식 미러 이력"
        description="모든 백업·검증·동기화 실행의 용량, 차단 시크릿 수, SHA-256 매니페스트 해시를 기록합니다."
      >
        {(snapshot?.recentRuns ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            아직 실행된 구글 드라이브 백업 이력이 없습니다.
          </p>
        ) : (
          <div className="grid gap-2">
            {(snapshot?.recentRuns ?? []).map((run) => (
              <div
                key={run.runId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={runStatusBadgeVariant(run.status)} size="sm">
                      {runStatusLabelKr(run.status)}
                    </Badge>
                    <Badge variant="outline" size="sm">
                      {runKindLabelKr(run.kind)}
                    </Badge>
                    <span className="font-mono text-[11px] text-muted-foreground">{run.runId}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {formatMs(run.startedAtMs)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                    <span>파일 {run.fileCount.toLocaleString()}개</span>
                    <span>
                      {formatBackupBytes(run.rawBytes)} → {formatBackupBytes(run.archiveBytes)}
                    </span>
                    <span>차단 시크릿 {run.skippedSecretsCount}건</span>
                    {run.manifestSha256 ? (
                      <span className="font-mono">SHA256:{run.manifestSha256.slice(0, 12)}</span>
                    ) : null}
                  </div>
                  {run.errorMessage ? (
                    <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                      {run.errorMessage}
                    </p>
                  ) : null}
                </div>
                {run.kind === "backup" && run.status === "succeeded" ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={() => handleVerifyRestore(run.runId)}
                  >
                    복구 검증
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
