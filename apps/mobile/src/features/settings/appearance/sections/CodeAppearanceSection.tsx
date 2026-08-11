import { useCallback } from "react";

import {
  CODE_FONT_SIZE_STEP,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
} from "../../../../lib/appearancePreferences";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import {
  AppearancePreviewSeparator,
  CodeAppearancePreview,
} from "../components/AppearancePreviews";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";

export function CodeAppearanceSection() {
  const { isReady, appearance, setCodeFontSize, setCodeWordBreak } = useAppearancePreferences();
  const custom = appearance.isCodeFontSizeCustom;

  const handleToggleCustom = useCallback(
    (enabled: boolean) => {
      setCodeFontSize(enabled ? appearance.codeFontSize : null);
    },
    [appearance.codeFontSize, setCodeFontSize],
  );

  return (
    <SettingsSection card title="코드와 변경 비교">
      <CodeAppearancePreview
        fontSize={appearance.codeFontSize}
        wordBreak={appearance.codeWordBreak}
      />
      <AppearancePreviewSeparator />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="chevron.left.forwardslash.chevron.right"
        label="사용자 지정 글자 크기"
        onValueChange={handleToggleCustom}
        value={custom}
      />
      {custom ? (
        <FontSizeSliderRow
          disabled={!isReady}
          icon="textformat.size"
          label="글자 크기"
          max={MAX_CODE_FONT_SIZE}
          min={MIN_CODE_FONT_SIZE}
          onChange={setCodeFontSize}
          step={CODE_FONT_SIZE_STEP}
          value={appearance.codeFontSize}
          valueLabel={`${appearance.codeFontSize} pt`}
        />
      ) : null}
      <SettingsSwitchRow
        disabled={!isReady}
        icon="text.word.spacing"
        label="긴 단어 줄바꿈"
        onValueChange={setCodeWordBreak}
        value={appearance.codeWordBreak}
      />
    </SettingsSection>
  );
}
