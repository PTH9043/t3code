import {
  DEFAULT_SERVER_SETTINGS,
  resolveEffectiveGlobalAssistant,
  type EditorId,
  type EnvironmentId,
  type GlobalAssistantConfig,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentSession } from "./session";

export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
});
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

interface PrimaryServerState {
  readonly config: ServerConfig | null;
  readonly latestEvent: ServerConfigStreamEvent | null;
  readonly welcome: ServerLifecycleWelcomePayload | null;
}

const EMPTY_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [];
export const EMPTY_SERVER_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const EMPTY_PRIMARY_SERVER_STATE: PrimaryServerState = {
  config: null,
  latestEvent: null,
  welcome: null,
};

export const primaryServerStateAtom = Atom.make((get): PrimaryServerState => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return EMPTY_PRIMARY_SERVER_STATE;
  }

  const target = { environmentId, input: {} };
  const configProjection = Option.getOrNull(
    AsyncResult.value(get(serverEnvironment.configProjection(target))),
  );
  const welcome = Option.getOrNull(AsyncResult.value(get(serverEnvironment.welcome(target))));

  return {
    config: get(serverEnvironment.configValueAtom(environmentId)),
    latestEvent: configProjection?.latestEvent ?? null,
    welcome,
  };
}).pipe(Atom.withLabel("web-primary-server-state"));

export const primaryServerConfigAtom = Atom.make(
  (get): ServerConfig | null => get(primaryServerStateAtom).config,
).pipe(Atom.withLabel("web-primary-server-config"));

export const primaryServerConfigEventAtom = Atom.make(
  (get): ServerConfigStreamEvent | null => get(primaryServerStateAtom).latestEvent,
).pipe(Atom.withLabel("web-primary-server-config-event"));

export const primaryServerWelcomeAtom = Atom.make(
  (get): ServerLifecycleWelcomePayload | null => get(primaryServerStateAtom).welcome,
).pipe(Atom.withLabel("web-primary-server-welcome"));

export const primaryServerSettingsAtom = Atom.make(
  (get): ServerSettings => get(primaryServerConfigAtom)?.settings ?? DEFAULT_SERVER_SETTINGS,
).pipe(Atom.withLabel("web-primary-server-settings"));

export const primaryServerProvidersAtom = Atom.make(
  (get): ReadonlyArray<ServerProvider> =>
    get(primaryServerConfigAtom)?.providers ?? EMPTY_SERVER_PROVIDERS,
).pipe(Atom.withLabel("web-primary-server-providers"));

export const primaryServerKeybindingsAtom = Atom.make(
  (get): ServerConfig["keybindings"] =>
    get(primaryServerConfigAtom)?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS,
).pipe(Atom.withLabel("web-primary-server-keybindings"));

export const primaryServerAvailableEditorsAtom = Atom.make(
  (get): ReadonlyArray<EditorId> =>
    get(primaryServerConfigAtom)?.availableEditors ?? EMPTY_AVAILABLE_EDITORS,
).pipe(Atom.withLabel("web-primary-server-available-editors"));

export const primaryServerKeybindingsConfigPathAtom = Atom.make(
  (get): string | null => get(primaryServerConfigAtom)?.keybindingsConfigPath ?? null,
).pipe(Atom.withLabel("web-primary-server-keybindings-config-path"));

export const primaryServerObservabilityAtom = Atom.make(
  (get): ServerConfig["observability"] | null =>
    get(primaryServerConfigAtom)?.observability ?? null,
).pipe(Atom.withLabel("web-primary-server-observability"));

const globalAssistantAtomCache = new Map<string, Atom.Atom<GlobalAssistantConfig | null>>();

/**
 * Narrow derived selector for `globalAssistant` with structural memoization.
 * Unrelated `serverSettings` updates (e.g. 620-model provider snapshot churn)
 * keep the exact same object reference so assistant message bubbles do not re-render.
 */
export function globalAssistantForEnvironmentAtom(
  environmentId: EnvironmentId | null,
): Atom.Atom<GlobalAssistantConfig | null> {
  const key = environmentId ?? "__primary__";
  const cached = globalAssistantAtomCache.get(key);
  if (cached) return cached;

  const sourceAtom =
    environmentId !== null
      ? serverEnvironment.settingsValueAtom(environmentId)
      : primaryServerSettingsAtom;

  let previousSignature: string | undefined;
  let previousValue: GlobalAssistantConfig | null = null;

  const derived = Atom.make((get): GlobalAssistantConfig | null => {
    const settings = get(sourceAtom);
    const signature = settings
      ? JSON.stringify([settings.globalAssistant ?? null, settings.globalResponseStyle ?? null])
      : "null";
    if (signature === previousSignature) {
      return previousValue;
    }
    previousSignature = signature;
    previousValue = settings ? resolveEffectiveGlobalAssistant(settings) : null;
    return previousValue;
  }).pipe(Atom.withLabel(`web-global-assistant:${key}`));

  globalAssistantAtomCache.set(key, derived);
  return derived;
}
