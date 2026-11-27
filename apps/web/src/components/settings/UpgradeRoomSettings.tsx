import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const OFFLINE_QUESTION_LABELS = {
  decide: "스스로 판단해 계속",
  wait: "T3가 켜질 때까지 대기",
} as const;

export function UpgradeRoomSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsSection title="업그레이드 방">
      <SettingsRow
        {...searchableSetting("upgrade-room-downtime-summary")}
        description="T3를 다시 켰을 때 업그레이드 방에 꺼져 있던 동안 진행된 작업을 작은 창으로 보여 줍니다."
        control={
          <Switch
            checked={settings.upgradeRoomDowntimeSummary}
            onCheckedChange={(checked) =>
              updateSettings({ upgradeRoomDowntimeSummary: Boolean(checked) })
            }
            aria-label="T3가 꺼진 동안 한 작업 표시"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("upgrade-room-offline-questions")}
        description="스스로 판단: 사용자가 자리에 없다고 알리고 모델이 판단해 계속합니다. 대기: T3가 다시 켜질 때까지 기다립니다."
        resetAction={
          settings.upgradeRoomOfflineQuestions !==
          DEFAULT_UNIFIED_SETTINGS.upgradeRoomOfflineQuestions ? (
            <SettingResetButton
              label="T3가 꺼져 있을 때 모델의 질문"
              onClick={() =>
                updateSettings({
                  upgradeRoomOfflineQuestions: DEFAULT_UNIFIED_SETTINGS.upgradeRoomOfflineQuestions,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.upgradeRoomOfflineQuestions}
            onValueChange={(value) => {
              if (value === "decide" || value === "wait") {
                updateSettings({ upgradeRoomOfflineQuestions: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="T3가 꺼져 있을 때 모델의 질문">
              <SelectValue>
                {OFFLINE_QUESTION_LABELS[settings.upgradeRoomOfflineQuestions]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="decide">
                {OFFLINE_QUESTION_LABELS.decide}
              </SelectItem>
              <SelectItem hideIndicator value="wait">
                {OFFLINE_QUESTION_LABELS.wait}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
