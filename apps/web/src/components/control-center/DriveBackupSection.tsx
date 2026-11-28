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
  EnvironmentId,
  GoogleEnrollmentStatusResult,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CloudIcon,
  FolderGit2Icon,
  FolderOpenIcon,
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
    case "paused":
      return "일시정지됨";
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
    case "paused":
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
    case "exchange_sync":
      return "PC↔VPS 교환소";
  }
}

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString("ko-KR");
}

export type DriveBackupSectionProps =
  | { readonly project: EnvironmentProject; readonly environmentId?: EnvironmentId }
  | { readonly project?: undefined; readonly environmentId: EnvironmentId };

export function DriveBackupSection({ project, environmentId }: DriveBackupSectionProps) {
  const targetEnvironmentId = environmentId ?? project!.environmentId;
  const stateAtom = useMemo(
    () =>
      orchestrationEnvironment.driveBackupState({
        environmentId: targetEnvironmentId,
        input: {},
      }),
    [targetEnvironmentId],
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
  const [passphraseBackupAck, setPassphraseBackupAck] = useState(false);
  const [retentionCount, setRetentionCount] = useState("7");
  const [includeCoreSettings, setIncludeCoreSettings] = useState(true);
  const [includeCoreSqliteSnapshot, setIncludeCoreSqliteSnapshot] = useState(false);
  const [includeEventArchives, setIncludeEventArchives] = useState(false);
  const [autoSyncIdleOnly, setAutoSyncIdleOnly] = useState(true);
  const [autoScheduleEnabled, setAutoScheduleEnabled] = useState(false);
  const [idleMinMinutes, setIdleMinMinutes] = useState("10");
  const [pauseOnBattery, setPauseOnBattery] = useState(true);
  const [readLimitMBps, setReadLimitMBps] = useState("50");
  const [uploadLimitMbps, setUploadLimitMbps] = useState("20");
  const [workerRssLimitMb, setWorkerRssLimitMb] = useState("300");
  const [fullSnapshotIntervalDays, setFullSnapshotIntervalDays] = useState("7");
  const [snapshotLocalRetentionCount, setSnapshotLocalRetentionCount] = useState("1");

  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoPath, setNewRepoPath] = useState("");
  const [newRepoKind, setNewRepoKind] = useState<DriveBackupTargetKind>("knowledge");
  const [newRepoUploadKnowledge, setNewRepoUploadKnowledge] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DriveBackupDryRunResult | null>(null);
  const [verifyResult, setVerifyResult] = useState<DriveBackupVerifyRestoreResult | null>(null);
  const [mirrorResult, setMirrorResult] = useState<DriveBackupSyncMirrorResult | null>(null);
  const [linkedGoogleStatus, setLinkedGoogleStatus] = useState<GoogleEnrollmentStatusResult | null>(
    null,
  );
  const linkedGoogleAccounts = linkedGoogleStatus?.accounts ?? [];

  const refreshLinkedAccounts = useCallback(async () => {
    const listAccounts =
      typeof window !== "undefined"
        ? window.desktopBridge?.googleSignIn?.listAccountsT3
        : undefined;
    if (!listAccounts) return;
    try {
      const res = await listAccounts();
      setLinkedGoogleStatus(res);
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
      await refreshLinkedAccounts();
      stateQuery.refresh();
    } catch {
      toastManager.add({
        type: "error",
        title: "Google Drive 계정 연결 실패",
        description: "해당 계정의 Drive 권한을 먼저 허용해 주세요.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleGrantDriveForAccount = async (account: EnrolledGoogleAccountSummary) => {
    const grantFn =
      typeof window !== "undefined"
        ? window.desktopBridge?.googleSignIn?.grantDrivePermissionT3
        : undefined;
    if (!grantFn) return;
    if (!linkedGoogleStatus?.hasClientSecret) {
      toastManager.add({
        type: "error",
        title: "OAuth Client Secret 1회 설정 필요",
        description: "설정 → Google 계정에서 OAuth Client Secret을 먼저 1회 저장해 주세요.",
      });
      return;
    }
    setBusyAction(`grant-google:${account.subject}`);
    try {
      const updated = await grantFn({
        subject: account.subject,
        ...(account.email ? { loginHint: account.email } : {}),
      });
      notifySuccess(
        "Google Drive 권한 허용 완료",
        `${updated.email ?? account.email ?? account.subject} 계정이 Drive 백업에 자동 연결되었습니다.`,
      );
      await refreshLinkedAccounts();
      stateQuery.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Google Drive 권한 허용 실패",
        description:
          error instanceof Error ? error.message : "브라우저에서 Drive 권한을 허용해 주세요.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleAddAndGrantDrive = async () => {
    const addFn =
      typeof window !== "undefined" ? window.desktopBridge?.googleSignIn?.addAccountT3 : undefined;
    if (!addFn) return;
    if (!linkedGoogleStatus?.oauthConfigured || !linkedGoogleStatus.hasClientSecret) {
      toastManager.add({
        type: "error",
        title: "최초 1회 OAuth 앱 설정 필요",
        description:
          "설정 → Google 계정에서 OAuth Client ID와 Client Secret을 먼저 1회 저장해 주세요.",
      });
      return;
    }
    setBusyAction("grant-google:new");
    try {
      const added = await addFn({ grantDrive: true });
      notifySuccess(
        "Google 계정 로그인 및 Drive 허용 완료",
        `${added.email ?? added.name ?? added.subject} 계정이 Drive 백업에 연결되었습니다.`,
      );
      await refreshLinkedAccounts();
      stateQuery.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Google Drive 연결 실패",
        description:
          error instanceof Error ? error.message : "브라우저에서 권한 허용을 완료해 주세요.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelGoogleAuth = async () => {
    try {
      await window.desktopBridge?.googleSignIn?.cancel?.();
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
    setIncludeEventArchives(config.includeEventArchives);
    setAutoSyncIdleOnly(config.autoSyncIdleOnly);
    setAutoScheduleEnabled(config.autoScheduleEnabled);
    setIdleMinMinutes(String(Math.max(1, Math.round(config.idleMinSeconds / 60))));
    setPauseOnBattery(config.pauseOnBattery);
    setReadLimitMBps(String(config.readLimitMBps));
    setUploadLimitMbps(String(config.uploadLimitMbps));
    setWorkerRssLimitMb(String(config.workerRssLimitMb));
    setFullSnapshotIntervalDays(String(config.fullSnapshotIntervalDays));
    setSnapshotLocalRetentionCount(String(config.snapshotLocalRetentionCount));
  }, [config]);

  const summary = useMemo(
    () => summarizeSelectedTargets(snapshot?.targets ?? []),
    [snapshot?.targets],
  );

  const handleSaveConfig = async () => {
    if (encryptionPassphrase.trim().length > 0 && !passphraseBackupAck) {
      toastManager.add({
        type: "error",
        title: "백업 비밀번호 외부 보관 확인 필요",
        description:
          "백업 비밀번호는 T3 밖(비밀번호 관리자 등)에 별도로 보관해야 복구할 수 있습니다. 아래 확인 체크박스를 선택해 주세요.",
      });
      return;
    }
    setBusyAction("save-config");
    try {
      const parsedRetention = Math.max(1, Math.min(90, Number(retentionCount) || 7));
      const result = await updateConfigCmd({
        environmentId: targetEnvironmentId,
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
            ? {
                encryptionPassphrase: encryptionPassphrase.trim(),
                passphraseBackupAcknowledged: passphraseBackupAck,
              }
            : {}),
          retentionCount: parsedRetention,
          includeCoreSettings,
          includeCoreSqliteSnapshot,
          includeEventArchives,
          autoSyncIdleOnly,
          autoScheduleEnabled,
          idleMinSeconds: Math.max(60, (Number(idleMinMinutes) || 10) * 60),
          pauseOnBattery,
          readLimitMBps: Math.max(0, Number(readLimitMBps) || 50),
          uploadLimitMbps: Math.max(0, Number(uploadLimitMbps) || 20),
          workerRssLimitMb: Math.max(128, Number(workerRssLimitMb) || 300),
          fullSnapshotIntervalDays: Math.max(1, Number(fullSnapshotIntervalDays) || 7),
          snapshotLocalRetentionCount: Math.max(1, Number(snapshotLocalRetentionCount) || 1),
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
      setPassphraseBackupAck(false);
      notifySuccess("백업 설정 저장 완료", "설정과 키 지문(key_fingerprint)이 저장되었습니다.");
      stateQuery.refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleTarget = async (
    target: DriveBackupTarget,
    patch: Partial<
      Pick<
        DriveBackupTarget,
        | "enabled"
        | "syncFiles"
        | "syncT3Scope"
        | "syncDriveToLocalRag"
        | "syncLocalToDriveKnowledge"
      >
    >,
  ) => {
    setBusyAction(`target:${target.id}`);
    try {
      const result = await upsertTargetCmd({
        environmentId: targetEnvironmentId,
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
          syncLocalToDriveKnowledge:
            patch.syncLocalToDriveKnowledge ?? Boolean(target.syncLocalToDriveKnowledge),
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

  const handlePickFolder = async () => {
    const pickFn = typeof window !== "undefined" ? window.desktopBridge?.pickFolder : undefined;
    if (!pickFn) return;
    setBusyAction("pick-folder");
    try {
      const picked = await pickFn();
      if (!picked) return;
      setNewRepoPath(picked);
      if (!newRepoName.trim()) {
        const trimmed = picked.replace(/[\\/]+$/, "");
        const parts = trimmed.split(/[\\/]/).filter(Boolean);
        const leaf = parts[parts.length - 1] ?? "";
        const suggested = /^[a-zA-Z]:$/.test(leaf)
          ? `${leaf[0]!.toUpperCase()}드라이브 지식`
          : leaf || "지식 폴더";
        setNewRepoName(suggested);
      }
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
        environmentId: targetEnvironmentId,
        input: {
          kind: newRepoKind,
          displayName: name,
          rootPath,
          enabled: true,
          syncFiles: true,
          syncT3Scope: false,
          syncDriveToLocalRag: false,
          syncLocalToDriveKnowledge: newRepoUploadKnowledge,
        },
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "저장소·폴더 추가 실패");
        return;
      }
      setNewRepoName("");
      setNewRepoPath("");
      setNewRepoUploadKnowledge(false);
      notifySuccess("백업·지식 대상 추가 완료", `'${name}' 항목이 목록에 추가되었습니다.`);
      stateQuery.refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteTarget = async (target: DriveBackupTarget) => {
    setBusyAction(`delete:${target.id}`);
    try {
      const result = await deleteTargetCmd({
        environmentId: targetEnvironmentId,
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
        environmentId: targetEnvironmentId,
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
        environmentId: targetEnvironmentId,
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
        environmentId: targetEnvironmentId,
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
        environmentId: targetEnvironmentId,
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

          {config?.lastAuthErrorCode === "invalid_grant" ? (
            <div
              role="status"
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs"
            >
              <div className="flex items-center gap-1.5 font-semibold text-amber-800 dark:text-amber-200">
                <AlertTriangleIcon className="size-4 shrink-0" />
                Google OAuth 토큰 만료(invalid_grant) — 자동 백업이 멈췄습니다
              </div>
              <p className="mt-1 leading-relaxed text-amber-900/90 dark:text-amber-100/90">
                OAuth 앱이 Testing이면 7일마다 만료됩니다. Google Cloud 콘솔에서{" "}
                <strong>Production으로 게시</strong>한 뒤 아래에서 Google 계정의 Drive 권한을 다시
                허용해 주세요.
              </p>
              {config.lastAuthErrorAtMs ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  최근 감지 시각: {formatMs(config.lastAuthErrorAtMs)}
                </p>
              ) : null}
            </div>
          ) : config?.lastAuthErrorCode === "auth_failed" ? (
            <div
              role="status"
              className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
            >
              <div className="font-semibold">Google Drive 인증 갱신 오류</div>
              <p className="mt-1">
                {config.lastAuthErrorMessage ?? "OAuth 자격증명을 다시 확인해 주세요."}
              </p>
            </div>
          ) : null}

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
              지식 폴더 양방향 동기화 (올리기 · 내려받기)
            </Button>
            {(snapshot?.activeWorkCount ?? 0) > 0 ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busyAction !== null || summary.selectedCount === 0}
                onClick={() => handleRunBackup(true)}
              >
                저속 제한 없이 최대 속도로 백업 실행
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
                로컬 미러 경로: {mirrorResult.mirrorLocalDir} (내려받기{" "}
                {formatBackupBytes(mirrorResult.totalBytes)}
                {mirrorResult.uploadedBytes
                  ? ` · 업로드 ${formatBackupBytes(mirrorResult.uploadedBytes)}`
                  : ""}
                )
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
              <div className="grid gap-2.5 rounded-lg border border-primary/25 bg-primary/5 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-foreground">
                      Google 계정에서 Drive 권한 1클릭 허용 · 전환
                    </span>
                    {config?.gdriveHasCredentials ? (
                      <Badge variant="success" size="sm">
                        {config.gdriveConnectedEmail ?? "Drive 권한 허용됨"}
                      </Badge>
                    ) : (
                      <Badge variant="outline" size="sm">
                        미허용
                      </Badge>
                    )}
                  </div>
                  {busyAction?.startsWith("grant-google:") ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => void handleCancelGoogleAuth()}
                    >
                      인증 취소
                    </Button>
                  ) : null}
                </div>

                {linkedGoogleAccounts.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {linkedGoogleAccounts.map((acc) => {
                      const isActive =
                        acc.driveBackupLinked &&
                        (linkedGoogleStatus?.activeDriveSubject === acc.subject ||
                          (!linkedGoogleStatus?.activeDriveSubject &&
                            Boolean(config?.gdriveConnectedEmail) &&
                            config?.gdriveConnectedEmail === acc.email));
                      const label = acc.email ?? acc.name ?? acc.subject;
                      return acc.driveBackupLinked ? (
                        <Button
                          key={acc.subject}
                          type="button"
                          size="xs"
                          variant={isActive ? "default" : "outline"}
                          disabled={busyAction !== null}
                          onClick={() => void handleBindGoogleAccount(acc)}
                        >
                          {label}
                          {isActive ? " ✓" : " (백업에 사용)"}
                        </Button>
                      ) : (
                        <Button
                          key={acc.subject}
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busyAction !== null}
                          onClick={() => void handleGrantDriveForAccount(acc)}
                        >
                          {label} · Drive 권한 허용
                        </Button>
                      );
                    })}
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busyAction !== null}
                      onClick={() => void handleAddAndGrantDrive()}
                    >
                      + 다른 Google 계정 허용
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {linkedGoogleStatus?.oauthConfigured
                        ? "버튼을 눌러 Google 계정에 로그인하고 Drive 권한을 허용하세요."
                        : "설정 → Google 계정에서 OAuth Client ID/Secret을 1회 저장하면 여기서 1클릭으로 Drive 권한을 허용할 수 있습니다."}
                    </span>
                    {linkedGoogleStatus?.oauthConfigured ? (
                      <Button
                        type="button"
                        size="xs"
                        disabled={busyAction !== null}
                        onClick={() => void handleAddAndGrantDrive()}
                      >
                        Google 계정에서 Drive 권한 허용하기
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>

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
              </div>

              <details className="rounded-lg border border-border/60 bg-background/50 p-3 text-xs">
                <summary className="cursor-pointer font-medium text-muted-foreground">
                  고급: 수동 OAuth 토큰 직접 입력 (직접 Refresh Token을 관리할 때만 사용)
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium">
                      연결 Google 계정 표시 이메일 (선택)
                    </label>
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
                          ? "•••••••• (로컬 암호화 보관 중 · Windows DPAPI)"
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
                        config?.gdriveHasCredentials
                          ? "•••••••• (로컬 암호화 보관 중 · Windows DPAPI)"
                          : "1//0..."
                      }
                    />
                  </div>
                </div>
              </details>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <label className="text-xs font-medium">AES-256-GCM 암호화 비밀번호 (4자 이상)</label>
              <Input
                type="password"
                value={encryptionPassphrase}
                onChange={(e) => {
                  setEncryptionPassphrase(e.target.value);
                  if (e.target.value.trim().length === 0) setPassphraseBackupAck(false);
                }}
                placeholder={
                  config?.keyFingerprint
                    ? `설정됨 (지문 ${config.keyFingerprint}) — 변경 시 입력`
                    : "새 백업 복구 비밀번호 입력"
                }
              />
              {config?.keyFingerprint ? (
                <span className="font-mono text-[11px] text-muted-foreground">
                  현재 키 지문(key_fingerprint): {config.keyFingerprint} (원문 미노출)
                </span>
              ) : null}
              {encryptionPassphrase.trim().length > 0 ? (
                <label className="mt-1 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-900 dark:text-amber-100">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0"
                    checked={passphraseBackupAck}
                    onChange={(e) => setPassphraseBackupAck(e.target.checked)}
                  />
                  <span>
                    이 비밀번호를 T3 밖(비밀번호 관리자 등)에 별도로 보관해야 백업을 복구할 수
                    있음을 확인했습니다.
                  </span>
                </label>
              ) : null}
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
              <span>
                다른 채팅방/작업 실행 중 저속 백그라운드 모드 (읽기 ≤10 MB/s · 업로드 ≤5 Mbps로
                천천히 백업)
              </span>
              <Switch checked={autoSyncIdleOnly} onCheckedChange={setAutoSyncIdleOnly} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs">
              <span>무방해 자동 백업 일정 (기본 OFF · dry-run/수동 1회/복원 검증 후 활성화)</span>
              <Switch checked={autoScheduleEnabled} onCheckedChange={setAutoScheduleEnabled} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs">
              <span>배터리/저전력 모드 시 시작 보류 및 자동 일시정지</span>
              <Switch checked={pauseOnBattery} onCheckedChange={setPauseOnBattery} />
            </label>
          </div>

          <div className="grid gap-3 rounded-xl border border-border/70 bg-muted/15 p-3.5 sm:grid-cols-3">
            <div className="grid gap-1">
              <label className="text-[11px] font-medium">유휴 대기 시간 (분 · 기본 10)</label>
              <Input
                type="number"
                min={1}
                max={1440}
                value={idleMinMinutes}
                onChange={(e) => setIdleMinMinutes(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <label className="text-[11px] font-medium">디스크 읽기 제한 (MB/s · 기본 50)</label>
              <Input
                type="number"
                min={0}
                max={2000}
                value={readLimitMBps}
                onChange={(e) => setReadLimitMBps(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <label className="text-[11px] font-medium">업로드 속도 제한 (Mbps · 기본 20)</label>
              <Input
                type="number"
                min={0}
                max={10000}
                value={uploadLimitMbps}
                onChange={(e) => setUploadLimitMbps(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <label className="text-[11px] font-medium">
                워커 메모리 RSS 상한 (MB · 기본 300)
              </label>
              <Input
                type="number"
                min={128}
                max={2048}
                value={workerRssLimitMb}
                onChange={(e) => setWorkerRssLimitMb(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <label className="text-[11px] font-medium">
                전체 SQLite 스냅샷 주기 (일 · 기본 7)
              </label>
              <Input
                type="number"
                min={1}
                max={90}
                value={fullSnapshotIntervalDays}
                onChange={(e) => setFullSnapshotIntervalDays(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <label className="text-[11px] font-medium">
                대용량 스냅샷 로컬 보존 세대 (기본 1)
              </label>
              <Input
                type="number"
                min={1}
                max={10}
                value={snapshotLocalRetentionCount}
                onChange={(e) => setSnapshotLocalRetentionCount(e.target.value)}
              />
            </div>
          </div>
        </div>
      </SectionCard>

      {/* 3. 선택형 프로젝트 · 통합 T3 데이터 · 다른 드라이브 지식 폴더 */}
      <SectionCard
        icon={FolderGit2Icon}
        scopeLabel="Opt-In 선택 목록"
        title="백업 · 지식 업로드 대상 선택"
        description="T3 전체 데이터(장기기억·첨부파일·RAG·아카이브·DB·설정)는 하나의 스위치로 묶여 있습니다. 아래에서 C:/D:/E:/F: 등 다른 드라이브의 지식 폴더도 바로 찾아 올릴 수 있습니다."
      >
        <div className="grid gap-4">
          <div className="grid gap-2">
            {(snapshot?.targets ?? []).map((target) => {
              const isCurrentProject = project ? target.projectId === project.id : false;
              const isUnifiedUserdata = target.kind === "userdata";
              const canDelete = target.kind === "repo" || target.kind === "knowledge";
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
                        <Badge variant={isUnifiedUserdata ? "info" : "outline"} size="sm">
                          {target.kind === "project"
                            ? "T3 프로젝트"
                            : target.kind === "core"
                              ? "T3 본체"
                              : target.kind === "userdata"
                                ? "T3 전체 데이터"
                                : target.kind === "knowledge"
                                  ? "지식 폴더"
                                  : "추가 저장소"}
                        </Badge>
                        {target.syncLocalToDriveKnowledge ? (
                          <Badge variant="success" size="sm">
                            T3-Knowledge 원본 업로드
                          </Badge>
                        ) : null}
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
                      {isUnifiedUserdata ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          포함: 장기기억(memory-v2) · 첨부파일 · RAG · 아카이브 · state.sqlite 및
                          watchdog-journal 스냅샷 · 설정 (시크릿·로그 자동 제외)
                        </p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                        {target.kind === "project" ? (
                          <>
                            <span>대화 {target.threadCount.toLocaleString()}건</span>
                            <span>장기기억 {target.memoryCount.toLocaleString()}건</span>
                          </>
                        ) : null}
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
                      {canDelete ? (
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
                        <span>
                          {isUnifiedUserdata
                            ? "T3 전체 데이터 암호화 증분 백업 (T3-Backup)"
                            : "폴더 파일 암호화 백업 (T3-Backup)"}
                        </span>
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
                      {!isUnifiedUserdata ? (
                        <label className="inline-flex items-center gap-2">
                          <Switch
                            checked={Boolean(target.syncLocalToDriveKnowledge)}
                            disabled={busyAction !== null}
                            onCheckedChange={(checked) =>
                              handleToggleTarget(target, { syncLocalToDriveKnowledge: checked })
                            }
                          />
                          <span>
                            원본 그대로 지식 폴더(
                            {config?.gdriveKnowledgeFolderName ?? "T3-Knowledge"}
                            )에도 업로드
                          </span>
                        </label>
                      ) : null}
                      {!isUnifiedUserdata ? (
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
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* 다른 드라이브 지식 폴더 · 저장소 직접 추가 */}
          <div className="grid gap-2.5 rounded-xl border border-dashed border-border bg-muted/15 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <FolderPlusIcon className="size-3.5 text-primary" />
                다른 드라이브 지식 폴더 · 저장소 추가 (C: / D: / E: / F: ...)
              </div>
              {typeof window !== "undefined" && window.desktopBridge?.pickFolder ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busyAction !== null}
                  onClick={() => void handlePickFolder()}
                >
                  <FolderOpenIcon className="size-3.5" />
                  폴더 찾기
                </Button>
              ) : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-12">
              <Input
                className="sm:col-span-3"
                value={newRepoName}
                onChange={(e) => setNewRepoName(e.target.value)}
                placeholder="표시 이름 (예: F드라이브 지식)"
              />
              <Input
                className="sm:col-span-5"
                value={newRepoPath}
                onChange={(e) => setNewRepoPath(e.target.value)}
                placeholder="폴더 경로 (예: F:\지식자료 또는 [폴더 찾기] 클릭)"
              />
              <select
                value={newRepoKind}
                onChange={(e) => setNewRepoKind(e.target.value as DriveBackupTargetKind)}
                className="h-9 rounded-lg border border-input bg-background px-2.5 text-xs sm:col-span-3"
              >
                <option value="knowledge">지식 폴더 (다른 드라이브 자료)</option>
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
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="size-3.5 shrink-0"
                checked={newRepoUploadKnowledge}
                onChange={(e) => setNewRepoUploadKnowledge(e.target.checked)}
              />
              <span>
                원본 파일 그대로 Google Drive 지식 폴더(
                {config?.gdriveKnowledgeFolderName ?? "T3-Knowledge"})에도 업로드 (미체크 시{" "}
                {config?.gdriveFolderName ?? "T3-Backup"}에 암호화 백업만 수행)
              </span>
            </label>
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
