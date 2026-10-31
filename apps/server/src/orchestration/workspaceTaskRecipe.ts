import {
  WorkspaceTaskInboxError,
  type WorkspaceTaskInputs,
  type WorkspaceTaskRecipeDefinition,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

export function taskHash(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function canonicalTaskInputs(inputs: WorkspaceTaskInputs) {
  return Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)));
}
export function taskInputHash(recipeId: string, inputs: WorkspaceTaskInputs, revision?: number) {
  return taskHash([recipeId, revision ?? null, canonicalTaskInputs(inputs)]);
}
export function resolveTaskInputs(
  recipe: WorkspaceTaskRecipeDefinition,
  inputs: WorkspaceTaskInputs,
): WorkspaceTaskInputs {
  const known = new Set(recipe.parameters.map((item) => item.name));
  for (const key of Object.keys(inputs))
    if (!known.has(key))
      throw new WorkspaceTaskInboxError({ message: `정의되지 않은 입력 항목입니다: ${key}` });
  return Object.fromEntries(
    recipe.parameters.map((field) => {
      const value = inputs[field.name] ?? field.defaultValue;
      if (field.required && !value.trim())
        throw new WorkspaceTaskInboxError({ message: `필수 입력을 채우세요: ${field.label}` });
      return [field.name, value];
    }),
  );
}
export function renderTaskTemplate(template: string, inputs: WorkspaceTaskInputs): string {
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(inputs, name))
      throw new WorkspaceTaskInboxError({
        message: `업무 양식에 알 수 없는 입력 참조가 있습니다: ${name}`,
      });
    return inputs[name]!;
  });
}
export function validateTaskRecipe(recipe: WorkspaceTaskRecipeDefinition): void {
  if (new Set(recipe.parameters.map((item) => item.name)).size !== recipe.parameters.length)
    throw new WorkspaceTaskInboxError({ message: "입력 항목 이름은 중복될 수 없습니다." });
  resolveTaskInputs(
    { ...recipe, parameters: recipe.parameters.map((item) => ({ ...item, required: false })) },
    {},
  );
  renderTaskTemplate(
    recipe.taskTemplate,
    Object.fromEntries(recipe.parameters.map((item) => [item.name, "value"])),
  );
  if (recipe.execution === "script" && !recipe.script.trim())
    throw new WorkspaceTaskInboxError({
      message: "AI 없이 실행할 업무에는 실행 명령이 필요합니다.",
    });
  const commands = [
    recipe.script,
    ...recipe.verificationCommands,
    ...(recipe.precheck.kind === "command" ? [recipe.precheck.command] : []),
  ];
  if (commands.some((command) => /\b(?:powershell|pwsh)(?:\.exe)?\b|\.ps1\b/i.test(command)))
    throw new WorkspaceTaskInboxError({
      message:
        "이 환경의 자동 업무는 PowerShell을 사용하지 않습니다. CMD 또는 프로그램 직접 호출 명령을 입력하세요.",
    });
  if (commands.some((command) => /\{\{/.test(command)))
    throw new WorkspaceTaskInboxError({
      message:
        "명령에는 입력값을 직접 삽입하지 않습니다. T3_TASK_INPUTS_JSON 환경 변수를 읽으세요.",
    });
}
export function taskInstructions(
  recipe: WorkspaceTaskRecipeDefinition,
  inputs: WorkspaceTaskInputs,
): string {
  return [
    renderTaskTemplate(recipe.taskTemplate, inputs),
    "업무 입력 자료(JSON):",
    JSON.stringify(inputs),
    ...(recipe.artifacts.length
      ? [
          "필수 산출물(프로젝트 기준 상대 경로):",
          ...recipe.artifacts.map(
            (item) =>
              `${renderTaskTemplate(item.path, inputs)} · ${item.format}${item.requiredKeys.length ? ` · JSON 필수 필드 ${item.requiredKeys.join(", ")}` : ""}`,
          ),
          "이 실행에서 산출물을 새로 생성하거나 내용을 갱신하고 실제 내용을 확인하세요.",
        ]
      : []),
    ...(recipe.verificationCommands.length
      ? ["성공 확인 명령:", ...recipe.verificationCommands]
      : []),
    "기존 프로젝트 지침과 사용자 요구를 지키고, 완료 결과와 미해결 사항을 구분해 보고하세요.",
  ].join("\n\n");
}
