import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import type { DesktopJasnaSnapshot } from "@t3tools/contracts";

import * as JasnaSupervisor from "../../jasna/JasnaSupervisor.ts";
import { start } from "./jasna.ts";

describe("desktop Jasna IPC", () => {
  it.effect("passes only a schema-valid selection to the local supervisor", () =>
    Effect.gen(function* () {
      const snapshot: DesktopJasnaSnapshot = {
        executablePath: "C:\\jasna\\jasna.exe",
        inputPath: "C:\\video.mp4",
        outputPath: "C:\\out.mp4",
        jobs: [],
      };
      const execute = vi.fn(async () => snapshot);
      const supervisor = {
        snapshot: () => snapshot,
        restoreExecutable: async () => {},
        selectExecutable: async () => snapshot,
        clearExecutable: async () => snapshot,
        selectInput: async () => snapshot,
        selectOutput: async () => snapshot,
        start: execute,
        cancel: async () => snapshot,
        waitForJob: async () => snapshot,
      } satisfies JasnaSupervisor.JasnaController;
      const selection = {
        executablePath: snapshot.executablePath!,
        inputPath: snapshot.inputPath!,
        outputPath: snapshot.outputPath!,
        model: "ltx" as const,
      };
      expect(
        yield* start
          .handler(selection)
          .pipe(Effect.provideService(JasnaSupervisor.JasnaSupervisor, supervisor)),
      ).toEqual(snapshot);
      expect(execute).toHaveBeenCalledWith(selection);
      execute.mockClear();
      const invalid = yield* start
        .handler({ ...selection, model: "ltx;anything" })
        .pipe(Effect.provideService(JasnaSupervisor.JasnaSupervisor, supervisor), Effect.result);
      expect(invalid._tag).toBe("Failure");
      expect(execute).not.toHaveBeenCalled();
    }),
  );
});
