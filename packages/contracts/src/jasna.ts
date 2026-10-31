import * as Schema from "effect/Schema";

export const DesktopJasnaModel = Schema.Literals([
  "basicvsrpp",
  "ltx",
  "ltx-4step",
  "ltx-8step",
  "ltx-undistilled",
]);
export type DesktopJasnaModel = typeof DesktopJasnaModel.Type;

export const DesktopJasnaJob = Schema.Struct({
  id: Schema.String,
  inputPath: Schema.String,
  outputPath: Schema.String,
  model: Schema.NullOr(DesktopJasnaModel),
  status: Schema.Literals([
    "starting",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ]),
  exitCode: Schema.NullOr(Schema.Int),
  logTail: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type DesktopJasnaJob = typeof DesktopJasnaJob.Type;

export const DesktopJasnaSnapshot = Schema.Struct({
  executablePath: Schema.NullOr(Schema.String),
  inputPath: Schema.NullOr(Schema.String),
  outputPath: Schema.NullOr(Schema.String),
  jobs: Schema.Array(DesktopJasnaJob),
});
export type DesktopJasnaSnapshot = typeof DesktopJasnaSnapshot.Type;

export const DesktopJasnaStart = Schema.Struct({
  executablePath: Schema.String,
  inputPath: Schema.String,
  outputPath: Schema.String,
  model: Schema.NullOr(DesktopJasnaModel),
});
export type DesktopJasnaStart = typeof DesktopJasnaStart.Type;

/** The native file pickers select paths on the machine running the desktop app. */
export interface DesktopJasnaBridge {
  readonly snapshot: () => Promise<DesktopJasnaSnapshot>;
  readonly pickExecutable: () => Promise<DesktopJasnaSnapshot>;
  readonly clearExecutable: () => Promise<DesktopJasnaSnapshot>;
  readonly pickInput: () => Promise<DesktopJasnaSnapshot>;
  readonly pickOutput: () => Promise<DesktopJasnaSnapshot>;
  readonly start: (selection: DesktopJasnaStart) => Promise<DesktopJasnaSnapshot>;
  readonly cancel: (jobId: string) => Promise<DesktopJasnaSnapshot>;
}
