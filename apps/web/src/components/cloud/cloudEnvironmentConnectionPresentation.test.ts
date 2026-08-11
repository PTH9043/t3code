import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import { presentSavedCloudEnvironmentConnection } from "./cloudEnvironmentConnectionPresentation";

function connection(
  phase: EnvironmentConnectionPresentation["phase"],
  error: string | null = null,
): EnvironmentConnectionPresentation {
  return { phase, error, traceId: null };
}

describe("saved cloud environment connection presentation", () => {
  it("only labels a live connection as connected", () => {
    expect(presentSavedCloudEnvironmentConnection(connection("connected"))).toEqual({
      buttonLabel: "연결됨",
      statusText: "연결됨",
      tone: "connected",
    });

    expect(presentSavedCloudEnvironmentConnection(connection("connecting"))).toEqual({
      buttonLabel: "연결 중…",
      statusText: "연결 중...",
      tone: "connecting",
    });
  });

  it("surfaces a failed attempt while the supervisor reconnects", () => {
    expect(
      presentSavedCloudEnvironmentConnection(
        connection("reconnecting", "Relay environment endpoint is unavailable."),
      ),
    ).toEqual({
      buttonLabel: "다시 연결 중…",
      statusText: "연결에 실패해 다시 연결하고 있습니다...",
      tone: "connecting",
    });
  });

  it.each([
    ["error", "연결 실패", "연결에 실패했습니다. 연결 설정을 확인해 주세요.", "error"],
    ["offline", "오프라인", "오프라인", "idle"],
    ["available", "연결 안 됨", "사용 가능", "idle"],
  ] as const)(
    "presents %s without claiming the environment is connected",
    (phase, buttonLabel, statusText, tone) => {
      expect(
        presentSavedCloudEnvironmentConnection(
          connection(phase, phase === "error" ? "Access denied." : null),
        ),
      ).toEqual({ buttonLabel, statusText, tone });
    },
  );
});
