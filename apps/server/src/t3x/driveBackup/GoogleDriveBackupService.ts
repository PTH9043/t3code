import type {
  DriveBackupConfig,
  DriveBackupDeleteTargetInput,
  DriveBackupDryRunInput,
  DriveBackupDryRunResult,
  DriveBackupError,
  DriveBackupGetStateInput,
  DriveBackupRunNowInput,
  DriveBackupRunRecord,
  DriveBackupStateSnapshot,
  DriveBackupSyncMirrorInput,
  DriveBackupSyncMirrorResult,
  DriveBackupTarget,
  DriveBackupUpdateConfigInput,
  DriveBackupUpsertTargetInput,
  DriveBackupVerifyRestoreInput,
  DriveBackupVerifyRestoreResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface GoogleDriveBackupServiceShape {
  readonly getState: (
    input: DriveBackupGetStateInput,
  ) => Effect.Effect<DriveBackupStateSnapshot, DriveBackupError>;

  readonly updateConfig: (
    input: DriveBackupUpdateConfigInput,
  ) => Effect.Effect<DriveBackupConfig, DriveBackupError>;

  readonly upsertTarget: (
    input: DriveBackupUpsertTargetInput,
  ) => Effect.Effect<DriveBackupTarget, DriveBackupError>;

  readonly deleteTarget: (
    input: DriveBackupDeleteTargetInput,
  ) => Effect.Effect<{ readonly deleted: boolean; readonly targetId: string }, DriveBackupError>;

  readonly dryRun: (
    input: DriveBackupDryRunInput,
  ) => Effect.Effect<DriveBackupDryRunResult, DriveBackupError>;

  readonly runNow: (
    input: DriveBackupRunNowInput,
  ) => Effect.Effect<DriveBackupRunRecord, DriveBackupError>;

  readonly verifyRestore: (
    input: DriveBackupVerifyRestoreInput,
  ) => Effect.Effect<DriveBackupVerifyRestoreResult, DriveBackupError>;

  readonly syncKnowledgeMirror: (
    input: DriveBackupSyncMirrorInput,
  ) => Effect.Effect<DriveBackupSyncMirrorResult, DriveBackupError>;
}

export class GoogleDriveBackupService extends Context.Service<
  GoogleDriveBackupService,
  GoogleDriveBackupServiceShape
>()("t3/t3x/driveBackup/GoogleDriveBackupService") {}
