import type {
  ModelSelection,
  WorkflowDefinition,
  WorkflowOverview,
  WorkflowRoleModels,
  WorkflowVersion,
  WorkspaceMeetingSetup,
} from "@t3tools/contracts";

export type WorkflowModelMode = "current" | "project" | "single" | "roles";
export type WorkflowModelRole = keyof WorkflowRoleModels;
export type WorkflowModelDraft = Partial<Record<WorkflowModelRole, ModelSelection>>;

export function exactWorkflowModelSelection(
  selected: ModelSelection | null | undefined,
  resolved: ModelSelection,
  providerAvailable: boolean,
): ModelSelection | null {
  if (
    !providerAvailable ||
    !selected ||
    selected.instanceId !== resolved.instanceId ||
    selected.model !== resolved.model
  )
    return null;
  return selected;
}

export function workflowStartFailureMessage(reason: unknown): string {
  const detail =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : typeof reason === "object" &&
            reason !== null &&
            "message" in reason &&
            typeof reason.message === "string"
          ? reason.message
          : "";
  return [
    "실행을 시작하지 못했거나 실행 응답을 확인하지 못했습니다.",
    ...(detail.trim() ? [`오류: ${detail.trim()}`] : []),
    "중복 실행을 피하려면 같은 요청으로 다시 확인하세요.",
  ].join("\n");
}

export function selectIndependentMeetingCoordinator(
  meeting: WorkspaceMeetingSetup,
  _currentModel: ModelSelection | null | undefined,
): { readonly meeting: WorkspaceMeetingSetup | null; readonly error: string | null } {
  const coordinator = meeting.participants.find((seat) => seat.id === meeting.chairParticipantId);
  if (!coordinator) {
    return { meeting: null, error: "통합 작업에 사용할 감독 AI를 지정하세요." };
  }
  return { meeting, error: null };
}

export function resolveWorkflowRoleModels(
  mode: WorkflowModelMode,
  single: ModelSelection | null,
  roles: WorkflowModelDraft,
  current: ModelSelection | null = null,
): WorkflowRoleModels | undefined {
  if (mode === "current" && current)
    return { coordinator: current, implementer: current, researcher: current };
  if (mode === "single" && single)
    return { coordinator: single, implementer: single, researcher: single };
  if (mode === "roles" && roles.coordinator && roles.implementer && roles.researcher)
    return {
      coordinator: roles.coordinator,
      implementer: roles.implementer,
      researcher: roles.researcher,
    };
  return undefined;
}

export interface ChatWorkflowChoice {
  definition: WorkflowDefinition;
  version: WorkflowVersion | null;
}

export function chatWorkflowChoices(
  overview: WorkflowOverview | null | undefined,
): ChatWorkflowChoice[] {
  if (!overview) return [];
  const known = new Set(overview.definitions.map((definition) => definition.id));
  return [
    ...overview.definitions
      .filter((version) => !version.archived)
      .map((version) => ({ definition: version, version })),
    ...overview.defaults
      .filter((definition) => !known.has(definition.id))
      .map((definition) => ({ definition, version: null })),
  ];
}

export function chatWorkflowValues(
  definition: WorkflowDefinition,
  current: Readonly<Record<string, string>>,
  prompt: string,
): Record<string, string> {
  return Object.fromEntries(
    definition.inputs.map((input) => [
      input.name,
      current[input.name] ?? (input.name === "goal" && prompt ? prompt : input.defaultValue),
    ]),
  );
}
