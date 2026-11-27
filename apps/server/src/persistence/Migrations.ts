/**
 * MigrationsLive - Migration runner with inline loader
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * Migrations run automatically when the MigrationLayer is provided,
 * ensuring the database schema is always up-to-date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsWorkspaceControl.ts";
import Migration0040 from "./Migrations/040_ProjectionWorkspaceKnowledge.ts";
import Migration0041 from "./Migrations/041_ProjectionWorkspaceRag.ts";
import Migration0042 from "./Migrations/042_ProjectionWorkspaceAgentRoles.ts";
import Migration0043 from "./Migrations/043_ProjectionWorkspaceCollaborationRuns.ts";
import Migration0044 from "./Migrations/044_ProjectionWorkspaceSchedules.ts";
import Migration0045 from "./Migrations/045_ProjectionWorkspaceCollaborationScheduleSource.ts";
import Migration0046 from "./Migrations/046_ProjectionWorkspacePrograms.ts";
import Migration0047 from "./Migrations/047_ProjectionWorkspaceOperatorIncidentSource.ts";
import Migration0048 from "./Migrations/048_ProjectionWorkspaceCollaborationTaskGraph.ts";
import Migration0049 from "./Migrations/049_ProjectionProjectsRuntimeViewedThrough.ts";
import Migration0050 from "./Migrations/050_ProjectionWorkspaceProgramIntegrity.ts";
import Migration0051 from "./Migrations/051_ProjectionWorkspaceCollaborationIntegritySource.ts";
import Migration0052 from "./Migrations/052_ProjectionWorkspaceKnowledgeUsage.ts";
import Migration0053 from "./Migrations/053_ProjectionWorkspaceKnowledgeCompaction.ts";
import Migration0054 from "./Migrations/054_ProjectionWorkspaceCollaborationMeeting.ts";
import Migration0055 from "./Migrations/055_ProjectionWorkspaceCollaborationInterjections.ts";
import Migration0056 from "./Migrations/056_ProjectionWorkspaceProgramRunHealthFailure.ts";
import Migration0057 from "./Migrations/057_TokenUsage.ts";
import Migration0058 from "./Migrations/058_ConversationHandoffMode.ts";
import Migration0059 from "./Migrations/059_WorkspaceCollaborationRunOrchestra.ts";
import Migration0060 from "./Migrations/060_RepairPreOrchestraMigrations.ts";
import Migration0061 from "./Migrations/061_ThreadOrchestraRunThread.ts";
import Migration0062 from "./Migrations/062_ClaimOrchestraNodeThreads.ts";
import Migration0063 from "./Migrations/063_ProjectionWorkspaceRagBigramIndex.ts";
import Migration0064 from "./Migrations/064_SharedDesignLibrary.ts";
import Migration0065 from "./Migrations/065_WorkspaceKnowledgeScope.ts";
import Migration0066 from "./Migrations/066_WorkspaceProgramHubMemory.ts";
import Migration0067 from "./Migrations/067_WorkspaceDevelopment.ts";
import Migration0068 from "./Migrations/068_ProviderAccountRateLimitIndex.ts";
import Migration0069 from "./Migrations/069_RebuildTokenUsageAfterRecovery.ts";
import Migration0070 from "./Migrations/070_WorkspaceTaskInbox.ts";
import Migration0071 from "./Migrations/071_WorkspaceCollaborationAutomationSource.ts";
import Migration0072 from "./Migrations/072_ReadOnlyResultCache.ts";
import Migration0073 from "./Migrations/073_WorkspaceMemoryV2.ts";
import Migration0074 from "./Migrations/074_SemanticIndexJobs.ts";
import Migration0075 from "./Migrations/075_RecoveryActivityLookupIndexes.ts";
import Migration0076 from "./Migrations/076_SemanticIndexFailureReason.ts";
import Migration0077 from "./Migrations/077_WorkspaceWorkflows.ts";
import Migration0078 from "./Migrations/078_WorkflowRunSummaries.ts";
import Migration0079 from "./Migrations/079_WorkspaceMemoryChunks.ts";
import Migration0080 from "./Migrations/080_WorkspaceMemoryChunkRows.ts";
import Migration0081 from "./Migrations/081_WorkspaceRunControl.ts";
import Migration0082 from "./Migrations/082_WorkspaceMemoryFolderScope.ts";
import Migration0083 from "./Migrations/083_WorkspaceConversationConcurrency.ts";
import Migration0084 from "./Migrations/084_WorkspaceMemoryFolderLookup.ts";
import Migration0085 from "./Migrations/085_WorkspaceForgottenMessageLookup.ts";
import Migration0086 from "./Migrations/086_WorkspaceConversationRagSources.ts";
import Migration0087 from "./Migrations/087_CommandReceiptFingerprint.ts";
import Migration0088 from "./Migrations/088_BootstrapWorktreeJournal.ts";
import Migration0089 from "./Migrations/089_RecoveryDeliveryJournal.ts";
import Migration0090 from "./Migrations/090_WorkspaceMonitoringJournal.ts";
import Migration0094 from "./Migrations/094_WorkspaceKnowledgeContentHash.ts";
import Migration0095 from "./Migrations/095_WorkspaceKnowledgeSavedSearch.ts";
import Migration0096 from "./Migrations/096_RepairWorkspaceWikiLinks.ts";
import Migration0097 from "./Migrations/097_PendingThreadModelTeamSeeds.ts";
import Migration0098 from "./Migrations/098_ThreadSettingsLibraryModelSaves.ts";
import Migration0099 from "./Migrations/099_PdfRevisionPublication.ts";
import Migration0100 from "./Migrations/100_PdfRevisionFailedAttempts.ts";
import Migration0101 from "./Migrations/101_WorkspaceMemoryV2TieringBitemporal.ts";
import Migration0102 from "./Migrations/102_ReopenSupersededWorkspaceMemory.ts";
import Migration0103 from "./Migrations/103_LivingPersonaMemoryAndAffect.ts";
import Migration0104 from "./Migrations/104_HostAuditAndSpecPin.ts";
import Migration0105 from "./Migrations/105_WorkspaceDelegations.ts";
import Migration0106 from "./Migrations/106_CcrToolOutputs.ts";
import Migration0107 from "./Migrations/107_CouncilEvidenceLedger.ts";
import Migration0108 from "./Migrations/108_UnifiedExecutionLedger.ts";
import Migration0109 from "./Migrations/109_WorkerEngineMailbox.ts";
import Migration0110 from "./Migrations/110_CouncilModeAndSeatStatus.ts";
import Migration0111 from "./Migrations/111_WorkspaceMemoryContextPreservingV3.ts";
import Migration0112 from "./Migrations/112_MissionControlAutonomousOps.ts";
import Migration0113 from "./Migrations/113_WorkspaceRoutingGraphAndAdaptiveHandoff.ts";
import Migration0114 from "./Migrations/114_UnifiedOpsAndRoundtable.ts";
import Migration0115 from "./Migrations/115_WorkspaceDelegationsAllowLimitExceeded.ts";
import Migration0116 from "./Migrations/116_GoogleDriveSelectiveBackup.ts";
import Migration0091 from "./Migrations/091_WorkspaceMonitoringActionJournal.ts";
import Migration0092 from "./Migrations/092_WorkspaceWikiLinks.ts";
import Migration0093 from "./Migrations/093_WorkspaceKnowledgeProvenance.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsWorkspaceControl", Migration0039],
  [40, "ProjectionWorkspaceKnowledge", Migration0040],
  [41, "ProjectionWorkspaceRag", Migration0041],
  [42, "ProjectionWorkspaceAgentRoles", Migration0042],
  [43, "ProjectionWorkspaceCollaborationRuns", Migration0043],
  [44, "ProjectionWorkspaceSchedules", Migration0044],
  [45, "ProjectionWorkspaceCollaborationScheduleSource", Migration0045],
  [46, "ProjectionWorkspacePrograms", Migration0046],
  [47, "ProjectionWorkspaceOperatorIncidentSource", Migration0047],
  [48, "ProjectionWorkspaceCollaborationTaskGraph", Migration0048],
  [49, "ProjectionProjectsRuntimeViewedThrough", Migration0049],
  [50, "ProjectionWorkspaceProgramIntegrity", Migration0050],
  [51, "ProjectionWorkspaceCollaborationIntegritySource", Migration0051],
  [52, "ProjectionWorkspaceKnowledgeUsage", Migration0052],
  [53, "ProjectionWorkspaceKnowledgeCompaction", Migration0053],
  [54, "ProjectionWorkspaceCollaborationMeeting", Migration0054],
  [55, "ProjectionWorkspaceCollaborationInterjections", Migration0055],
  [56, "ProjectionWorkspaceProgramRunHealthFailure", Migration0056],
  [57, "TokenUsage", Migration0057],
  [58, "ConversationHandoffMode", Migration0058],
  [59, "WorkspaceCollaborationRunOrchestra", Migration0059],
  [60, "RepairPreOrchestraMigrations", Migration0060],
  [61, "ThreadOrchestraRunThread", Migration0061],
  [62, "ClaimOrchestraNodeThreads", Migration0062],
  [63, "ProjectionWorkspaceRagBigramIndex", Migration0063],
  [64, "SharedDesignLibrary", Migration0064],
  [65, "WorkspaceKnowledgeScope", Migration0065],
  [66, "WorkspaceProgramHubMemory", Migration0066],
  [67, "WorkspaceDevelopment", Migration0067],
  [68, "ProviderAccountRateLimitIndex", Migration0068],
  [69, "RebuildTokenUsageAfterRecovery", Migration0069],
  [70, "WorkspaceTaskInbox", Migration0070],
  [71, "WorkspaceCollaborationAutomationSource", Migration0071],
  [72, "ReadOnlyResultCache", Migration0072],
  [73, "WorkspaceMemoryV2", Migration0073],
  [74, "SemanticIndexJobs", Migration0074],
  [75, "RecoveryActivityLookupIndexes", Migration0075],
  [76, "SemanticIndexFailureReason", Migration0076],
  [77, "WorkspaceWorkflows", Migration0077],
  [78, "WorkflowRunSummaries", Migration0078],
  [79, "WorkspaceMemoryChunks", Migration0079],
  [80, "WorkspaceMemoryChunkRows", Migration0080],
  [81, "WorkspaceRunControl", Migration0081],
  [82, "WorkspaceMemoryFolderScope", Migration0082],
  [83, "WorkspaceConversationConcurrency", Migration0083],
  [84, "WorkspaceMemoryFolderLookup", Migration0084],
  [85, "WorkspaceForgottenMessageLookup", Migration0085],
  [86, "WorkspaceConversationRagSources", Migration0086],
  [87, "CommandReceiptFingerprint", Migration0087],
  [88, "BootstrapWorktreeJournal", Migration0088],
  [89, "RecoveryDeliveryJournal", Migration0089],
  [90, "WorkspaceMonitoringJournal", Migration0090],
  [91, "WorkspaceMonitoringActionJournal", Migration0091],
  [92, "WorkspaceWikiLinks", Migration0092],
  [93, "WorkspaceKnowledgeProvenance", Migration0093],
  [94, "WorkspaceKnowledgeContentHash", Migration0094],
  [95, "WorkspaceKnowledgeSavedSearch", Migration0095],
  [96, "RepairWorkspaceWikiLinks", Migration0096],
  [97, "PendingThreadModelTeamSeeds", Migration0097],
  [98, "ThreadSettingsLibraryModelSaves", Migration0098],
  [99, "PdfRevisionPublication", Migration0099],
  [100, "PdfRevisionFailedAttempts", Migration0100],
  [101, "WorkspaceMemoryV2TieringBitemporal", Migration0101],
  [102, "ReopenSupersededWorkspaceMemory", Migration0102],
  [103, "LivingPersonaMemoryAndAffect", Migration0103],
  [104, "HostAuditAndSpecPin", Migration0104],
  [105, "WorkspaceDelegations", Migration0105],
  [106, "CcrToolOutputs", Migration0106],
  [107, "CouncilEvidenceLedger", Migration0107],
  [108, "UnifiedExecutionLedger", Migration0108],
  [109, "WorkerEngineMailbox", Migration0109],
  [110, "CouncilModeAndSeatStatus", Migration0110],
  [111, "WorkspaceMemoryContextPreservingV3", Migration0111],
  [112, "MissionControlAutonomousOps", Migration0112],
  [113, "WorkspaceRoutingGraphAndAdaptiveHandoff", Migration0113],
  [114, "UnifiedOpsAndRoundtable", Migration0114],
  [115, "WorkspaceDelegationsAllowLimitExceeded", Migration0115],
  [116, "GoogleDriveSelectiveBackup", Migration0116],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

export const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

/**
 * Layer that runs migrations when the layer is built.
 *
 * Use this to ensure migrations run before your application starts.
 * Migrations are run automatically - no separate script is needed.
 *
 * @example
 * ```typescript
 * import { MigrationsLive } from "@acme/db/Migrations"
 * import * as SqliteClient from "@acme/db/SqliteClient"
 *
 * // Migrations run automatically when SqliteClient is provided
 * const AppLayer = MigrationsLive.pipe(
 *   Layer.provideMerge(SqliteClient.layer({ filename: "database.sqlite" }))
 * )
 * ```
 */
export const MigrationsLive = Layer.effectDiscard(runMigrations());
