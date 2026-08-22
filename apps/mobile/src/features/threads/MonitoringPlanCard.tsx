import type { WorkspaceMonitoringPlan } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

export interface MonitoringPlanCardProps {
  readonly plan: WorkspaceMonitoringPlan;
  readonly approving: boolean;
  readonly onApprove: () => Promise<unknown>;
}

/**
 * The monitoring thread's watch-plan proposal, approved with a button rather
 * than a chat reply — same reasoning as the web banner: a reply cannot be
 * validated as consent and would cost an AI turn to interpret.
 */
export function MonitoringPlanCard(props: MonitoringPlanCardProps) {
  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        감시 계획 제안 · {props.plan.revision}판
      </Text>
      <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
        대상 {props.plan.targets.length} · 지표 {props.plan.metrics.length} · 플레이북{" "}
        {props.plan.playbooks.length}
      </Text>
      {props.plan.rationale ? (
        <Text
          className="font-sans text-sm leading-normal text-neutral-600 dark:text-neutral-400"
          numberOfLines={4}
        >
          {props.plan.rationale}
        </Text>
      ) : null}
      <Text className="font-sans text-xs leading-normal text-neutral-500 dark:text-neutral-500">
        승인하면 이 계획대로 감시를 시작합니다. 계획 내용은 제어센터에서 편집할 수 있습니다.
      </Text>
      <View className="flex-row flex-wrap gap-2.5">
        <Pressable
          className="items-center justify-center rounded-[14px] bg-blue-500 px-3.5 py-3"
          disabled={props.approving}
          onPress={() => void props.onApprove()}
        >
          <Text className="font-t3-extrabold text-sm text-white">
            {props.approving ? "승인 중…" : "승인"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
