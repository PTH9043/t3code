import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";

const mobileClientUpdatedAtFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short",
});

const NOTIFICATION_PREFERENCES = [
  ["notifyOnApproval", "승인 요청"],
  ["notifyOnInput", "입력 요청"],
  ["notifyOnCompletion", "완료"],
  ["notifyOnFailure", "실패"],
] as const satisfies ReadonlyArray<
  readonly [keyof RelayClientDeviceRecord["notifications"], string]
>;

export function mobileClientPlatformLabel(device: RelayClientDeviceRecord): string {
  return `iOS ${device.iosMajorVersion}${device.appVersion ? ` · T3 Code ${device.appVersion}` : ""}`;
}

export function mobileClientNotificationDetail(device: RelayClientDeviceRecord): string {
  if (!device.notifications.enabled) {
    return "이 기기에서 푸시 알림이 꺼져 있습니다.";
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) =>
    device.notifications[preference] ? [label] : [],
  );
  return enabledPreferences.length > 0
    ? `${enabledPreferences.join(", ")} 알림을 받습니다.`
    : "푸시 알림은 켜져 있지만 선택된 알림 유형이 없습니다.";
}

export function mobileClientUpdatedAtLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? "업데이트 시각 없음"
    : `${mobileClientUpdatedAtFormatter.format(date)} 업데이트`;
}
