import {
  DevelopmentVerificationCommand,
  type ModelSelection,
  type WorkspaceDevelopmentState,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Schema from "effect/Schema";

const decodeCommands = Schema.decodeUnknownSync(
  Schema.Array(DevelopmentVerificationCommand).check(Schema.isMaxLength(8)),
);

export function parseDevelopmentVerificationCommands(text: string) {
  return decodeCommands(
    text.split(/\r?\n/).flatMap((line) => {
      const [command, ...args] = tokenizeCliArgs(line);
      return command ? [{ command, args }] : [];
    }),
  );
}

export function formatDevelopmentVerificationCommands(
  commands: ReadonlyArray<DevelopmentVerificationCommand>,
) {
  return commands
    .map(({ command, args }) =>
      [command, ...args]
        .map((value) => (!value || /[\s"'\\]/.test(value) ? JSON.stringify(value) : value))
        .join(" "),
    )
    .join("\n");
}

export function developmentMainModel(
  state: WorkspaceDevelopmentState | null,
  fallback: ModelSelection,
) {
  return state?.bindings.find((binding) => binding.role === "main")?.model ?? fallback;
}

export const developmentControlLabels = {
  managed: "Main이 조율",
  human: "직접 조율",
  reconciling: "상태 확인 중",
} as const;

export function parseDevelopmentTokenBudget(text: string) {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("토큰 예산은 양의 정수로 입력하거나 비워 두세요.");
  return value;
}
