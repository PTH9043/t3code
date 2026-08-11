import type {
  DesktopUpdateAutomationPermissions,
  WorkspaceProgramPermissions,
} from "@t3tools/contracts";
import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useDesktopUpdateState } from "../../state/desktopUpdate";
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
      (permission === "autoStart" || permission === "autoRestartAfterRepair") &&
      !window.confirm(
        permission === "autoStart"
          ? "등록된 프로그램이 T3 서버 시작과 함께 자동 실행될 수 있습니다. 자동 시작을 허용할까요?"
          : "AI 수정과 검증이 성공하면 해당 프로그램이 자동으로 재시작됩니다. 자동 재시작을 허용할까요?",
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
          description="오류 사건이 생성되면 읽기 전용 AI 진단 스레드를 자동으로 시작합니다. 실제 코드는 수정하지 않습니다."
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
      </SettingsSection>
    </SettingsPageContainer>
  );
}
