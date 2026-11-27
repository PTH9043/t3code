import {
  WorkspaceMeetingParticipantId,
  type ModelSelection,
  type ServerConfig,
} from "@t3tools/contracts";
import { Modal, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { buildModelOptions } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import type { MobileOrchestraConfig } from "../../state/thread-orchestra-config";

export function MobileOrchestraSettings(props: {
  readonly visible: boolean;
  readonly active: boolean;
  readonly config: MobileOrchestraConfig;
  readonly currentModel: ModelSelection;
  readonly serverConfig: ServerConfig | null;
  readonly onChange: (config: MobileOrchestraConfig) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const options = buildModelOptions(props.serverConfig, null);
  const update = (patch: Partial<MobileOrchestraConfig>) =>
    props.onChange({ ...props.config, ...patch });
  return (
    <Modal visible={props.visible} animationType="slide" onRequestClose={props.onClose}>
      <View className="flex-1 bg-screen">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 20 + insets.top,
            paddingBottom: 20 + insets.bottom,
            gap: 16,
          }}
        >
          <View className="flex-row items-center justify-between">
            <Text className="text-lg font-t3-bold text-foreground">이 대화의 통합 작업</Text>
            <Pressable accessibilityRole="button" onPress={props.onClose}>
              <Text className="text-foreground">닫기</Text>
            </Pressable>
          </View>
          {props.active ? (
            <Text className="text-xs text-foreground-muted">
              변경한 설정은 다음 통합 작업부터 적용됩니다.
            </Text>
          ) : null}
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-foreground">다음 메시지로 통합 작업 시작</Text>
            <Switch
              accessibilityLabel="통합 작업 시작 선택"
              value={props.config.enabled}
              onValueChange={(enabled) =>
                update({ enabled, ...(enabled ? { activationId: uuidv4() } : {}) })
              }
            />
          </View>
          <Text className="text-xs text-foreground-muted">
            작업이 끝나면 일반 대화로 돌아갑니다. 감독자와 후보 설정은 이 대화에 유지됩니다.
          </Text>
          <Text className="font-t3-bold text-foreground">실행 방식</Text>
          <View className="flex-row flex-wrap gap-2">
            {(
              [
                ["once", "한 번 실행"],
                ["persistent", "목표 완료까지 지속"],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityState={{ selected: props.config.executionMode === value }}
                className="rounded-lg border border-border p-2"
                onPress={() => update({ executionMode: value })}
              >
                <Text className="text-foreground">
                  {props.config.executionMode === value ? "●" : "○"} {label}
                </Text>
              </Pressable>
            ))}
          </View>
          {props.config.executionMode === "persistent" && (
            <View className="gap-1">
              <Text className="text-foreground">별도 감시 AI 확인 간격 · 초</Text>
              <TextInput
                accessibilityLabel="별도 감시 AI 확인 간격 · 초"
                keyboardType="number-pad"
                placeholder="지정하지 않으면 감시 안 함"
                value={props.config.watchdogIntervalSeconds?.toString() ?? ""}
                className="rounded-lg border border-border p-2 text-foreground"
                onChangeText={(raw) => {
                  const value = Number(raw);
                  if (raw !== "" && (!Number.isSafeInteger(value) || value <= 0)) return;
                  update({ watchdogIntervalSeconds: raw === "" ? undefined : value });
                }}
              />
              <Text className="text-xs text-foreground-muted">
                지정한 감독 AI 모델로 별도 세션을 실행하며 사용량이 발생합니다.
              </Text>
            </View>
          )}
          <View className="flex-row flex-wrap gap-2">
            {(
              [
                ["collaboration", "바로 실행"],
                ["meeting", "토론 먼저"],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityState={{ selected: props.config.style === value }}
                className="rounded-lg border border-border p-2"
                onPress={() => update({ style: value })}
              >
                <Text className="text-foreground">
                  {props.config.style === value ? "●" : "○"} {label}
                </Text>
              </Pressable>
            ))}
          </View>
          {(
            [
              ["askFirst", "질문 먼저"],
              ["reviewPlan", "실행 전 계획 확인"],
            ] as const
          ).map(([key, label]) => (
            <View key={key} className="flex-row items-center justify-between">
              <Text className="text-foreground">{label}</Text>
              <Switch
                accessibilityLabel={label}
                value={props.config[key]}
                onValueChange={(value) => update({ [key]: value })}
              />
            </View>
          ))}
          <Text className="font-t3-bold text-foreground">감독자와 작업자 후보</Text>
          <Text className="text-xs text-foreground-muted">
            감독자와 작업자의 역할을 직접 적어 지정할 수 있습니다. 작업자 없이 감독자만 선택해도
            됩니다.
          </Text>
          {props.config.participants.map((seat) => {
            const option = options.find(
              (candidate) =>
                candidate.selection.instanceId === seat.modelSelection.instanceId &&
                candidate.selection.model === seat.modelSelection.model,
            );
            const descriptors = resolveProviderOptionDescriptors({
              capabilities: option?.capabilities,
              selections: seat.modelSelection.options,
            });
            const setOption = (id: string, value: string | boolean) =>
              update({
                participants: props.config.participants.map((entry) =>
                  entry.id === seat.id
                    ? {
                        ...entry,
                        modelSelection: {
                          ...entry.modelSelection,
                          options: [
                            ...(entry.modelSelection.options ?? []).filter(
                              (item) => item.id !== id,
                            ),
                            { id, value },
                          ],
                        },
                      }
                    : entry,
                ),
              });
            return (
              <View key={seat.id} className="gap-2 rounded-xl border border-border p-3">
                <Text className="text-sm font-t3-bold text-foreground">
                  {seat.displayName} · {seat.modelSelection.model}
                </Text>
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: props.config.chairParticipantId === seat.id }}
                  onPress={() => update({ chairParticipantId: seat.id })}
                >
                  <Text className="text-foreground">
                    {props.config.chairParticipantId === seat.id ? "●" : "○"} 감독 AI로 지정
                  </Text>
                </Pressable>
                <TextInput
                  accessibilityLabel={`${seat.displayName} 역할`}
                  multiline
                  maxLength={4000}
                  placeholder="이 AI의 역할"
                  value={seat.roleDescription ?? ""}
                  className="rounded-lg border border-border p-2 text-foreground"
                  onChangeText={(roleDescription) =>
                    update({
                      participants: props.config.participants.map((entry) =>
                        entry.id === seat.id ? { ...entry, roleDescription } : entry,
                      ),
                    })
                  }
                />
                {descriptors.map((descriptor) => (
                  <View key={descriptor.id} className="gap-1">
                    <Text className="text-xs text-foreground-muted">{descriptor.label}</Text>
                    {descriptor.type === "boolean" ? (
                      <Switch
                        accessibilityLabel={`${seat.displayName} ${descriptor.label}`}
                        value={descriptor.currentValue ?? false}
                        onValueChange={(value) => setOption(descriptor.id, value)}
                      />
                    ) : (
                      <View className="flex-row flex-wrap gap-2">
                        {descriptor.options.map((choice) => (
                          <Pressable
                            key={choice.id}
                            accessibilityRole="radio"
                            accessibilityState={{
                              selected: getProviderOptionCurrentValue(descriptor) === choice.id,
                            }}
                            className="rounded-lg border border-border p-2"
                            onPress={() => setOption(descriptor.id, choice.id)}
                          >
                            <Text className="text-xs text-foreground">
                              {getProviderOptionCurrentValue(descriptor) === choice.id ? "●" : "○"}{" "}
                              {choice.label}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </View>
                ))}
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    update({
                      participants: props.config.participants.filter(
                        (entry) => entry.id !== seat.id,
                      ),
                      ...(props.config.chairParticipantId === seat.id
                        ? { chairParticipantId: null }
                        : {}),
                    })
                  }
                >
                  <Text className="text-sm text-foreground">참가자 제거</Text>
                </Pressable>
              </View>
            );
          })}
          <Text className="text-sm font-t3-bold text-foreground">
            AI 추가 ({props.config.participants.length}명)
          </Text>
          {options.length === 0 ? (
            <Text className="text-xs text-foreground-muted">
              연결된 AI 목록을 불러오지 못했습니다.
            </Text>
          ) : null}
          {options.map((option) => (
            <Pressable
              key={option.key}
              accessibilityRole="button"
              className="rounded-lg border border-border p-2"
              onPress={() =>
                update({
                  participants: [
                    ...props.config.participants,
                    {
                      id: WorkspaceMeetingParticipantId.make(`seat-${uuidv4()}`),
                      displayName: option.providerLabel,
                      modelSelection: option.selection,
                    },
                  ],
                })
              }
            >
              <Text className="text-sm text-foreground">
                + {option.providerLabel} · {option.label}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            className="rounded-lg bg-fill p-3"
            onPress={props.onClose}
          >
            <Text className="text-center font-t3-bold text-foreground">설정 완료</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}
