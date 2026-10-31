import { WorkspaceMeetingParticipantId } from "@t3tools/contracts";
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

/** Use the chosen coordinator for planning without changing the saved roster. */
export function selectMeetingCoordinator(
  meeting: WorkspaceMeetingSetup,
  selected: ModelSelection | undefined,
  explicitlySelected: ReadonlyArray<ModelSelection> = [],
): { readonly meeting: WorkspaceMeetingSetup | null; readonly error: string | null } {
  if (!selected) return { meeting, error: null };
  // Old rosters may still contain the previously forced Fable model. Leave the
  // saved roster intact, but run that model only when it is selected now.
  const allowed = [selected, ...explicitlySelected];
  const participants = meeting.participants.filter(
    (seat) =>
      !seat.modelSelection.model.toLowerCase().includes("fable") ||
      allowed.some(
        (choice) =>
          choice.instanceId === seat.modelSelection.instanceId &&
          choice.model === seat.modelSelection.model,
      ),
  );
  const existing = participants.find(
    (seat) =>
      seat.modelSelection.instanceId === selected.instanceId &&
      seat.modelSelection.model === selected.model,
  );
  if (existing) {
    if (participants.length < 2)
      return {
        meeting: null,
        error: "선택한 모델과 함께 사용할 다른 참가자를 한 명 이상 선택하세요.",
      };
    return {
      meeting: {
        ...meeting,
        chairParticipantId: existing.id,
        participants: participants.map((seat) =>
          seat.id === existing.id ? { ...seat, modelSelection: selected } : seat,
        ),
      },
      error: null,
    };
  }
  if (participants.length === 0) {
    return {
      meeting: null,
      error: "선택한 모델과 함께 사용할 다른 참가자를 한 명 이상 선택하세요.",
    };
  }
  if (participants.length >= 8) {
    return {
      meeting: null,
      error:
        "선택한 총괄 모델을 추가하려면 참가자 한 명을 제외하거나 참가자 중에서 총괄을 선택하세요.",
    };
  }
  const ids = new Set(participants.map((seat) => String(seat.id)));
  let id = "selected-coordinator";
  for (let suffix = 2; ids.has(id); suffix++) id = `selected-coordinator-${suffix}`;
  const chairParticipantId = WorkspaceMeetingParticipantId.make(id);
  return {
    meeting: {
      ...meeting,
      chairParticipantId,
      participants: [
        ...participants,
        { id: chairParticipantId, displayName: selected.model, modelSelection: selected },
      ],
    },
    error: null,
  };
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
