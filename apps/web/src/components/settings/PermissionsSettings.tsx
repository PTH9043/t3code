import type {
  DesktopUpdateAutomationPermissions,
  WorkspaceProgramPermissions,
} from "@t3tools/contracts";
import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { useProjects } from "../../state/entities";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const DEFAULT_UPDATE_AUTOMATION_PERMISSIONS: DesktopUpdateAutomationPermissions = {
  autoDownload: false,
  autoInstall: false,
};

type UpdateAutomationPermission = keyof DesktopUpdateAutomationPermissions;
type ProgramPermission = keyof WorkspaceProgramPermissions;

export function PermissionsSettingsPanel() {
  const updateState = useDesktopUpdateState();
  const programPermissions = usePrimarySettings((settings) => settings.workspaceProgramPermissions);
  const selfMonitoring = usePrimarySettings((settings) => settings.selfMonitoring);
  const projects = useProjects();
  const monitoredProjects = projects.filter(
    (project) => project.workspaceControl?.monitoring.enabled === true,
  );
  const updateSettings = useUpdatePrimarySettings();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const supportsUpdateAutomation =
    typeof bridge?.getUpdateAutomationPermissions === "function" &&
    typeof bridge.setUpdateAutomationPermissions === "function";
  const [permissions, setPermissions] = useState(DEFAULT_UPDATE_AUTOMATION_PERMISSIONS);
  const [loading, setLoading] = useState(supportsUpdateAutomation);
  const [savingPermission, setSavingPermission] = useState<UpdateAutomationPermission | null>(null);

  useEffect(() => {
    if (!supportsUpdateAutomation) {
      setLoading(false);
      return;
    }

    let disposed = false;
    void bridge
      .getUpdateAutomationPermissions()
      .then((nextPermissions) => {
        if (!disposed) setPermissions(nextPermissions);
      })
      .catch(() => {
        if (disposed) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "업데이트 권한을 불러오지 못했습니다",
            description: "잠시 후 다시 시도해 주세요.",
          }),
        );
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [bridge, supportsUpdateAutomation]);

  const updatePermission = useCallback(
    (permission: UpdateAutomationPermission, enabled: boolean) => {
      if (!supportsUpdateAutomation || savingPermission !== null) return;
      if (
        permission === "autoInstall" &&
        enabled &&
        !window.confirm(
          "업데이트 다운로드가 끝나면 앱이 자동으로 종료되고 설치 후 다시 시작됩니다. 실행 중인 에이전트 작업이나 터미널 명령이 중단될 수 있습니다. 자동 설치를 허용할까요?",
        )
      ) {
        return;
      }

      const previousPermissions = permissions;
      const nextPermissions = { ...permissions, [permission]: enabled };
      setPermissions(nextPermissions);
      setSavingPermission(permission);
      void bridge
        .setUpdateAutomationPermissions(nextPermissions)
        .then(setPermissions)
        .catch(() => {
          setPermissions(previousPermissions);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "업데이트 권한을 저장하지 못했습니다",
              description: "변경 사항을 되돌렸습니다. 잠시 후 다시 시도해 주세요.",
            }),
          );
        })
        .finally(() => setSavingPermission(null));
    },
    [bridge, permissions, savingPermission, supportsUpdateAutomation],
  );

  const controlsDisabled = loading || savingPermission !== null || !supportsUpdateAutomation;
  const desktopOnlyStatus = supportsUpdateAutomation
    ? null
    : "데스크톱 앱에서만 설정할 수 있습니다.";
  const buildStatus =
    supportsUpdateAutomation && updateState?.enabled === false
      ? "현재 개발 빌드에서는 업데이트 기능이 비활성화되어 있지만 권한은 저장됩니다."
      : null;

  const updateProgramPermission = (permission: ProgramPermission, enabled: boolean) => {
    if (
      enabled &&
      (permission === "autoStart" ||
        permission === "autoRestartAfterRepair" ||
        permission === "monitoringAutoActions") &&
      !window.confirm(
        permission === "autoStart"
          ? "등록된 프로그램이 T3 서버 시작과 함께 자동 실행될 수 있습니다. 자동 시작을 허용할까요?"
          : permission === "autoRestartAfterRepair"
            ? "AI 수정과 검증이 성공하면 해당 프로그램이 자동으로 재시작됩니다. 자동 재시작을 허용할까요?"
            : "모니터링 모드가 '플레이북' 자율 범위일 때, 승인한 계획의 규칙(재시작·중지·시작·수정 run)을 사람에게 묻지 않고 실행합니다. 허용할까요?",
      )
    ) {
      return;
    }
    updateSettings({
      workspaceProgramPermissions: {
        ...programPermissions,
        [permission]: enabled,
      },
    });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="애플리케이션 업데이트">
        <SettingsRow
          {...searchableSetting("automatic-update-download")}
          description="새 버전을 발견하면 별도의 확인 없이 설치 파일을 백그라운드에서 내려받도록 허용합니다. 앱은 재시작되지 않습니다."
          status={
            desktopOnlyStatus ??
            buildStatus ??
            (savingPermission === "autoDownload"
              ? "권한 저장 중…"
              : permissions.autoDownload
                ? "허용됨"
                : "허용 안 함")
          }
          control={
            <Switch
              aria-label="자동 다운로드 권한"
              checked={permissions.autoDownload}
              disabled={controlsDisabled}
              onCheckedChange={(checked) => updatePermission("autoDownload", checked)}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("automatic-update-install")}
          description="다운로드가 완료되면 앱을 자동으로 종료하고 업데이트를 설치한 뒤 다시 시작하도록 허용합니다."
          status={
            desktopOnlyStatus ??
            buildStatus ??
            (savingPermission === "autoInstall"
              ? "권한 저장 중…"
              : permissions.autoInstall
                ? "허용됨 · 자동 재시작 포함"
                : "허용 안 함")
          }
          control={
            <Switch
              aria-label="자동 설치 및 재시작 권한"
              checked={permissions.autoInstall}
              disabled={controlsDisabled}
              onCheckedChange={(checked) => updatePermission("autoInstall", checked)}
            />
          }
        />
        <div className="mx-3 mt-2 flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm text-amber-800 sm:mx-4 dark:text-amber-100/90">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <p className="leading-relaxed">
            자동 설치 전 서버 연결을 하나씩 정리하며, 설치 인계가 실패하면 사용 중이던 백엔드를 다시
            시작합니다. 진행 중인 에이전트 턴과 터미널 명령은 중단될 수 있으므로 중요한 작업이 끝난
            뒤에만 허용하는 것을 권장합니다.
          </p>
        </div>
      </SettingsSection>
      <SettingsSection title="프로젝트 프로그램 운영">
        <SettingsRow
          {...searchableSetting("workspace-program-manual-control")}
          description="제어센터가 직접 실행한 프로그램의 시작·중지·재시작을 허용합니다. 외부 프로세스에는 적용되지 않습니다."
          status={programPermissions.manualControl ? "허용됨" : "허용 안 함"}
          control={
            <Switch
              aria-label="프로그램 수동 제어 권한"
              checked={programPermissions.manualControl}
              onCheckedChange={(checked) => updateProgramPermission("manualControl", checked)}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("workspace-program-log-collection")}
          description="프로그램의 제한된 최근 로그를 수집해 상태 표시와 오류 증거에 사용합니다. 비밀 값은 저장 전에 가립니다."
          status={programPermissions.collectLogs ? "허용됨" : "허용 안 함"}
          control={
            <Switch
              aria-label="프로그램 로그 수집 권한"
              checked={programPermissions.collectLogs}
              onCheckedChange={(checked) => updateProgramPermission("collectLogs", checked)}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("workspace-program-auto-start")}
          description="프로그램별 자동 시작 설정이 켜진 항목을 T3 서버 시작 시 실행하도록 허용합니다."
          status={programPermissions.autoStart ? "허용됨" : "허용 안 함"}
          control={
            <Switch
              aria-label="프로그램 자동 시작 권한"
              checked={programPermissions.autoStart}
              onCheckedChange={(checked) => updateProgramPermission("autoStart", checked)}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("workspace-program-auto-diagnosis")}
          description="장애가 보고되면 읽기 전용 AI 진단 대화를 자동으로 시작합니다. 실제 코드는 수정하지 않습니다."
          status={programPermissions.autoDiagnosis ? "허용됨" : "허용 안 함"}
          control={
            <Switch
              aria-label="오류 자동 AI 진단 권한"
              checked={programPermissions.autoDiagnosis}
              onCheckedChange={(checked) => updateProgramPermission("autoDiagnosis", checked)}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("workspace-program-auto-restart-after-repair")}
          description="사용자가 지시한 수정 작업과 필수 검증이 성공한 경우 해당 프로그램만 자동 재시작합니다."
          status={programPermissions.autoRestartAfterRepair ? "허용됨" : "허용 안 함"}
          control={
            <Switch
              aria-label="수정 후 프로그램 자동 재시작 권한"
              checked={programPermissions.autoRestartAfterRepair}
              onCheckedChange={(checked) =>
                updateProgramPermission("autoRestartAfterRepair", checked)
              }
            />
          }
        />
        <SettingsRow
          {...searchableSetting("workspace-program-monitoring-auto-actions")}
          description="프로그램 모니터링 모드가 '승인한 플레이북 안에서 자율'일 때, 승인된 규칙에 한해 재시작·중지·시작·수정 run을 묻지 않고 실행합니다. 꺼져 있으면 모니터링은 관찰·진단만 하고 모든 행동을 묻습니다."
          status={programPermissions.monitoringAutoActions ? "허용됨" : "허용 안 함"}
          control={
            <Switch
              aria-label="모니터링 자동 조치 권한"
              checked={programPermissions.monitoringAutoActions}
              onCheckedChange={(checked) =>
                updateProgramPermission("monitoringAutoActions", checked)
              }
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="T3 Code 자체 감시">
        <SettingsRow
          {...searchableSetting("self-monitoring-enabled")}
          description="이 서버의 이벤트 루프 지연, 느린·실패한 작업 span, 메모리·CPU(데스크톱이 호스트이면 데스크톱 프로세스까지)를 프로그램 모니터링 모드의 감시 대상으로 올립니다. 발견은 아래에서 고른 프로젝트의 모니터링 스레드 하나로만 갑니다."
          status={
            !selfMonitoring.enabled
              ? "꺼짐"
              : monitoredProjects.length === 0
                ? "켜짐 · 모니터링이 켜진 프로젝트가 없어 대기 중"
                : "켜짐"
          }
          control={
            <Switch
              aria-label="T3 Code 자체 감시"
              checked={selfMonitoring.enabled}
              onCheckedChange={(enabled) =>
                updateSettings({ selfMonitoring: { ...selfMonitoring, enabled } })
              }
            />
          }
        />
        <SettingsRow
          {...searchableSetting("self-monitoring-project")}
          description="비워 두면 모니터링이 켜진 첫 프로젝트가 받습니다. 프로젝트를 고르면 그 프로젝트의 모니터링이 켜져 있을 때만 감시합니다. 대상은 다음 '다시 분석' 때 감시 계획에 반영됩니다."
          control={
            <select
              aria-label="자체 감시 수신 프로젝트"
              className="h-9 min-w-56 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring"
              value={selfMonitoring.projectId ?? ""}
              disabled={!selfMonitoring.enabled}
              onChange={(event) =>
                updateSettings({
                  selfMonitoring: {
                    ...selfMonitoring,
                    projectId: event.target.value === "" ? null : (event.target.value as never),
                  },
                })
              }
            >
              <option value="">모니터링이 켜진 첫 프로젝트</option>
              {projects.map((project) => (
                <option key={`${project.environmentId}:${project.id}`} value={project.id}>
                  {project.title}
                  {project.workspaceControl?.monitoring.enabled ? "" : " (모니터링 꺼짐)"}
                </option>
              ))}
            </select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
