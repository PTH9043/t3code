import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import {
  AndroidHeaderIconButton,
  type AndroidHeaderAction,
} from "../../components/AndroidScreenHeader";
import { ControlPill } from "../../components/ControlPill";

export function ThreadAndroidHeaderActions(props: {
  readonly onOpenViewer: () => void;
  readonly actions: readonly AndroidHeaderAction[];
}) {
  return (
    <>
      <ControlPill label="대화 뷰어" variant="pill" onPress={props.onOpenViewer} />
      <AndroidAnchoredMenu
        title="대화 작업"
        actions={props.actions.map(({ accessibilityLabel, icon, disabled }) => ({
          id: accessibilityLabel,
          title: accessibilityLabel,
          image: typeof icon === "string" ? icon : undefined,
          attributes: { disabled },
        }))}
        onPressAction={({ nativeEvent }) => {
          const action = props.actions.find(
            (item) => item.accessibilityLabel === nativeEvent.event,
          );
          if (action && !action.disabled) action.onPress();
        }}
      >
        {(open) => (
          <AndroidHeaderIconButton
            accessibilityLabel="대화 작업 더 보기"
            icon="ellipsis"
            onPress={open}
          />
        )}
      </AndroidAnchoredMenu>
    </>
  );
}
