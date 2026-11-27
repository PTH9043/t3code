import type { Options } from "@anthropic-ai/claude-agent-sdk";

const disabledReason =
  "이 대화의 백그라운드 감시가 꺼져 있습니다. 대화 상단에서 감시를 켤 수 있습니다.";
const watchTools = ["Monitor", "ScheduleWakeup", "CronCreate"];

/** PreToolUse runs even when the user has enabled automatic tool approval. */
export function claudeChatWatchHooks(
  isEnabled: () => Promise<boolean>,
): NonNullable<Options["hooks"]> {
  return {
    PreToolUse: [
      {
        matcher: `^(${watchTools.join("|")})$`,
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse" || !watchTools.includes(input.tool_name)) {
              return {};
            }
            const args = input.tool_input;
            if (
              input.tool_name === "ScheduleWakeup" &&
              args &&
              typeof args === "object" &&
              "stop" in args &&
              args.stop === true
            ) {
              return {};
            }
            if (await isEnabled()) return {};
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: disabledReason,
              },
            };
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          async (input) => {
            if (
              input.hook_event_name !== "UserPromptSubmit" ||
              (input.source !== "loop_wakeup" && input.source !== "schedule_wakeup")
            ) {
              return {};
            }
            return (await isEnabled()) ? {} : { decision: "block", reason: disabledReason };
          },
        ],
      },
    ],
  };
}

export function isClaudeWatchTask(type: string | undefined): boolean {
  return type === "monitor" || type === "monitor_mcp";
}
