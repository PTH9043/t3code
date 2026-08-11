import { View } from "react-native";

import { T3HeaderButton } from "../../native/T3HeaderButton.android";
import type { SidebarHeaderActionsProps } from "./sidebar-header-actions";

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View className="h-11 flex-row gap-1">
      <T3HeaderButton
        accessibilityLabel="설정 열기"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
