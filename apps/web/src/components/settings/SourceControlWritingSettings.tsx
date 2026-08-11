import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";
import type { SourceControlWritingStyleMode } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveSourceControlWriterModelSelection } from "@t3tools/shared/serverSettings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const MODE_OPTIONS: Record<SourceControlWritingStyleMode, { label: string; description: string }> =
  {
    repo_conventions: {
      label: "저장소 작성 관례",
      description: "각 프로젝트의 최근 변경 설명과 변경 요청 제목의 스타일을 따릅니다.",
    },
    conventional_commits: {
      label: "Conventional Commits 규칙",
      description:
        "변경 설명에는 Conventional Commits 접두사를 사용하고, 변경 요청 제목과 설명은 간결하게 작성합니다.",
    },
    custom: {
      label: "사용자 지정 지침",
      description:
        "모든 프로젝트의 변경 설명과 변경 요청 제목 및 설명에 사용자가 작성한 지침을 적용합니다.",
    },
  };

export function SourceControlWritingSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const customInstructionsRef = useRef<HTMLTextAreaElement>(null);
  const style = settings.sourceControlWritingStyle;
  const defaults = DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
  const isSourceControlWritingStyleDirty =
    style.mode !== defaults.mode || style.customInstructions !== defaults.customInstructions;

  const defaultModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const usesDedicatedModel = settings.sourceControlWriterModelSelection !== null;
  const resolvedSourceControlWriterSelection = resolveSourceControlWriterModelSelection(
    settings,
    serverProviders,
  );
  const activeSelection =
    resolvedSourceControlWriterSelection === settings.textGenerationModelSelection
      ? defaultModelSelection
      : resolvedSourceControlWriterSelection;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );

  return (
    <SettingsSection title="텍스트 생성">
      <SettingsRow
        title="소스 제어 작성 스타일"
        description={MODE_OPTIONS[style.mode].description}
        resetAction={
          isSourceControlWritingStyleDirty ? (
            <SettingResetButton
              label="소스 제어 작성 스타일"
              onClick={() =>
                updateSettings({
                  sourceControlWritingStyle: {
                    mode: defaults.mode,
                    customInstructions: defaults.customInstructions,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={style.mode}
            onValueChange={(value) => {
              const customInstructions = customInstructionsRef.current?.value.trim();
              updateSettings({
                sourceControlWritingStyle: {
                  mode: value as SourceControlWritingStyleMode,
                  ...(customInstructions !== undefined ? { customInstructions } : {}),
                },
              });
            }}
          >
            <SelectTrigger className="w-full sm:w-56" aria-label="소스 제어 작성 스타일">
              <SelectValue>{MODE_OPTIONS[style.mode].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MODE_OPTIONS) as SourceControlWritingStyleMode[]).map((mode) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {MODE_OPTIONS[mode].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        {style.mode === "custom" ? (
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={style.customInstructions}
              ref={customInstructionsRef}
              defaultValue={style.customInstructions}
              onBlur={(event) => {
                const customInstructions = event.target.value.trim();
                if (customInstructions !== style.customInstructions) {
                  updateSettings({ sourceControlWritingStyle: { customInstructions } });
                }
              }}
              rows={4}
              placeholder="제목은 간결하게 작성하고 설명에는 짧은 글머리표를 사용하세요."
              aria-label="사용자 지정 소스 제어 작성 지침"
            />
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        title="변경 요청 템플릿 따르기"
        description="현재 저장소에 템플릿이 있으면 그 구조에 맞춰 변경 요청 설명을 작성합니다."
        resetAction={
          style.followChangeRequestTemplates !== defaults.followChangeRequestTemplates ? (
            <SettingResetButton
              label="변경 요청 템플릿"
              onClick={() =>
                updateSettings({
                  sourceControlWritingStyle: {
                    followChangeRequestTemplates: defaults.followChangeRequestTemplates,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={style.followChangeRequestTemplates}
            onCheckedChange={(checked) =>
              updateSettings({
                sourceControlWritingStyle: {
                  followChangeRequestTemplates: Boolean(checked),
                },
              })
            }
            aria-label="변경 요청 템플릿 따르기"
          />
        }
      />

      <SettingsRow
        title="소스 제어 작성 모델"
        description="변경 설명, 변경 요청 제목과 설명, 브랜치 또는 북마크 이름 생성에 별도 모델을 사용할 수 있습니다. 끄면 전역 텍스트 생성 모델을 사용합니다."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {usesDedicatedModel ? (
              <ProviderModelPicker
                activeInstanceId={activeSelection.instanceId}
                model={activeSelection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                triggerAriaLabel="소스 제어 작성 모델"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    sourceControlWriterModelSelection: createModelSelection(instanceId, model),
                  });
                }}
              />
            ) : null}
            <Switch
              checked={usesDedicatedModel}
              onCheckedChange={(checked) =>
                updateSettings({
                  sourceControlWriterModelSelection: checked
                    ? createModelSelection(
                        defaultModelSelection.instanceId,
                        defaultModelSelection.model,
                        defaultModelSelection.options,
                      )
                    : null,
                })
              }
              aria-label="별도의 소스 제어 작성 모델 사용"
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
