import {
  findThreadModelTeam,
  isProviderDriverKind,
  isProviderAvailable,
  toLegacyResponseStyle,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getLegacyProviderSettings = (
  settings: ServerSettings,
  provider: ProviderDriverKind,
): LegacyProviderSettings | undefined =>
  (settings.providers as Record<string, LegacyProviderSettings | undefined>)[provider];

export function isModelSelectionProviderEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  const instanceConfig = settings.providerInstances[selection.instanceId];
  if (instanceConfig !== undefined) {
    return instanceConfig.enabled ?? true;
  }

  return (
    isProviderDriverKind(selection.instanceId) &&
    getLegacyProviderSettings(settings, selection.instanceId)?.enabled === true
  );
}

export function resolveSourceControlWriterModelSelection(
  settings: ServerSettings,
  providers?: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selection = settings.sourceControlWriterModelSelection;
  if (!selection || !isModelSelectionProviderEnabled(settings, selection)) {
    return settings.textGenerationModelSelection;
  }
  if (providers === undefined) {
    return selection;
  }

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.enabled === true && isProviderAvailable(provider)
    ? selection
    : settings.textGenerationModelSelection;
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const {
    automaticGitFetchInterval,
    providerHealthRefreshInterval,
    backgroundActivityProfile,
    globalAssistant,
    threadAssistantProfiles,
    backgroundActivity,
    providerInstancesToUpsert,
    executionProfilesToUpsert,
    executionProfileIdsToRemove,
    customMcpServersToUpsert,
    customMcpServerIdsToRemove,
    mcpProjectProfilesToUpsert,
    mcpProjectProfileRootsToRemove,
    threadSettingsPresetSave,
    threadSettingsPresetRemove,
    threadModelTeamUpdate,
    threadSubordinateTeamUpdate,
    globalSubordinateTeam,
    backgroundWatchThreadUpdate,
    ...patchForMerge
  } = patch;
  const currentBackgroundActivity = normalizeServerBackgroundActivitySettings(current);
  const backgroundActivityPatch =
    backgroundActivityProfile !== undefined
      ? {
          schemaVersion: 1 as const,
          profile:
            automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
              ? ("custom" as const)
              : backgroundActivityProfile,
          ...(automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
            ? { baseProfile: backgroundActivityProfile }
            : {}),
          overrides: {
            ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
            ...(providerHealthRefreshInterval !== undefined
              ? { providerHealthRefreshInterval }
              : {}),
          },
        }
      : automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
        ? {
            schemaVersion: 1 as const,
            profile: "custom" as const,
            baseProfile: getBackgroundActivityBaseProfile(currentBackgroundActivity),
            overrides: {
              ...(currentBackgroundActivity.profile === "custom"
                ? currentBackgroundActivity.overrides
                : {}),
              ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
              ...(providerHealthRefreshInterval !== undefined
                ? { providerHealthRefreshInterval }
                : {}),
            },
          }
        : undefined;
  let next = deepMerge(current, patchForMerge);
  if (globalAssistant !== undefined) {
    // Unified global AI profile replaces per-room styles, profiles, and subordinate overrides.
    next = {
      ...next,
      globalAssistant,
      globalResponseStyle: toLegacyResponseStyle(globalAssistant),
      threadResponseStyles: {},
      threadSubordinateTeams: {},
      threadAssistantProfiles: {},
    };
  }
  if (threadAssistantProfiles !== undefined) {
    // Older clients save a custom profile without a mode. Replace each submitted row in full.
    next = {
      ...next,
      threadAssistantProfiles: { ...current.threadAssistantProfiles, ...threadAssistantProfiles },
    };
  }
  if (globalSubordinateTeam !== undefined) next = { ...next, globalSubordinateTeam };
  if (threadSubordinateTeamUpdate) {
    const { threadId, members } = threadSubordinateTeamUpdate;
    next = {
      ...next,
      threadSubordinateTeams: { ...next.threadSubordinateTeams, [threadId]: members },
    };
  }
  if (threadSettingsPresetSave || threadSettingsPresetRemove) {
    const presets = current.threadSettingsPresets.filter(
      (preset) =>
        preset.id !== threadSettingsPresetRemove && preset.id !== threadSettingsPresetSave?.id,
    );
    if (threadSettingsPresetSave) presets.push(threadSettingsPresetSave);
    next = { ...next, threadSettingsPresets: presets };
  }
  if (backgroundWatchThreadUpdate) {
    const { threadId, enabled } = backgroundWatchThreadUpdate;
    const ids = current.backgroundWatchThreadIds;
    if (ids.includes(threadId) !== enabled) {
      next = {
        ...next,
        backgroundWatchThreadIds: enabled
          ? [...ids, threadId]
          : ids.filter((id) => id !== threadId),
      };
    }
  }
  if (threadModelTeamUpdate) {
    const { members, ...scope } = threadModelTeamUpdate;
    const existing = findThreadModelTeam(current.threadModelTeams, scope);
    const teams = (current.threadModelTeams ?? []).filter((team) => team !== existing);
    if (members !== null) teams.push({ ...scope, members });
    const inherited = current.threadSettingsInheritedTeamScopes.filter(
      (row) => !findThreadModelTeam([row], scope),
    );
    if (members === null) inherited.push(scope);
    next = { ...next, threadModelTeams: teams, threadSettingsInheritedTeamScopes: inherited };
    // A reset removes the override. Remember that choice until this thread's first seed.
    const initialization = current.threadModelTeamInitialization;
    if (
      members === null &&
      !initialization?.initializedThreads.includes(scope.threadId) &&
      !findThreadModelTeam(initialization?.resetScopes, scope)
    ) {
      next = {
        ...next,
        threadModelTeamInitialization: {
          initializedThreads: initialization?.initializedThreads ?? [],
          resetScopes: [...(initialization?.resetScopes ?? []), scope],
        },
      };
    }
  }
  const customMcpServers = { ...current.customMcpServers };
  for (const id of customMcpServerIdsToRemove ?? []) delete customMcpServers[id];
  for (const [id, server] of Object.entries(customMcpServersToUpsert ?? {}))
    customMcpServers[id] = { ...server, name: id };
  const mcpProjectProfiles = { ...current.mcpProjectProfiles };
  for (const root of mcpProjectProfileRootsToRemove ?? []) delete mcpProjectProfiles[root];
  for (const [root, profile] of Object.entries(mcpProjectProfilesToUpsert ?? {}))
    mcpProjectProfiles[root] = { ...profile, workspaceRoot: root };
  const executionProfiles = { ...current.executionProfiles };
  for (const id of executionProfileIdsToRemove ?? []) delete executionProfiles[id];
  for (const [id, profile] of Object.entries(executionProfilesToUpsert ?? {})) {
    const { threadId: _threadId, ...meeting } = profile.meeting;
    executionProfiles[id] = {
      ...profile,
      id,
      revision: (current.executionProfiles[id]?.revision ?? 0) + 1,
      meeting,
    };
  }
  const nextWithReplacementsBase = {
    ...next,
    customMcpServers,
    mcpProjectProfiles,
    executionProfiles,
    ...(backgroundActivity !== undefined
      ? {
          backgroundActivity: {
            ...deepMerge(currentBackgroundActivity, backgroundActivity),
            ...(backgroundActivity.overrides !== undefined
              ? { overrides: backgroundActivity.overrides }
              : {}),
          },
        }
      : { backgroundActivity: currentBackgroundActivity }),
    ...(backgroundActivity === undefined && backgroundActivityPatch !== undefined
      ? { backgroundActivity: backgroundActivityPatch }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(providerInstancesToUpsert !== undefined
      ? {
          providerInstances: {
            ...(patch.providerInstances ?? current.providerInstances),
            ...providerInstancesToUpsert,
          },
        }
      : {}),
    ...(patch.sourceControlWriterModelSelection !== undefined
      ? { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(providerHealthRefreshInterval !== undefined ? { providerHealthRefreshInterval } : {}),
  };
  const normalizedBackgroundActivity = normalizeBackgroundActivitySettings(
    nextWithReplacementsBase.backgroundActivity,
  );
  const resolvedBackgroundActivity = resolveBackgroundActivitySettings(
    normalizedBackgroundActivity,
  );
  const nextWithReplacements = {
    ...nextWithReplacementsBase,
    backgroundActivity: normalizedBackgroundActivity,
    automaticGitFetchInterval: resolvedBackgroundActivity.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolvedBackgroundActivity.providerHealthRefreshInterval,
    backgroundActivityProfile: resolvedBackgroundActivity.profile,
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
