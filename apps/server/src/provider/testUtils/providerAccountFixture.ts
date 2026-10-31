import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

export function account(
  id: string,
  overrides: Omit<Partial<ServerProvider>, "usage"> & { usage?: ServerProvider["usage"] } = {},
): ServerProvider {
  const { usage, ...rest } = overrides;
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-30T00:00:00Z",
    slashCommands: [],
    skills: [],
    models: [{ slug: "selected-model", name: "Model", isCustom: false, capabilities: null }],
    ...("usage" in overrides
      ? usage !== undefined
        ? { usage }
        : {}
      : {
          usage: {
            source: "provider" as const,
            updatedAt: "2026-09-30T00:00:00Z",
            sessionTokens: 0,
            sessionCount: 0,
            activeSessionCount: 0,
            secondary: { usedPercent: 100, windowDurationMinutes: 10_080 },
          },
        }),
    ...rest,
  };
}
