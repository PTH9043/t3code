import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
  WorkspaceCollaborationRun,
} from "@t3tools/contracts";
import {
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationCommand,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { createHash } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { commitPdfRevision } from "../../documents/pdfRevisionStore.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import {
  checkKnowledgeSelection,
  isKnowledgeManagementCommand,
  retainKnowledgeSuccessor,
} from "../knowledgeManagement.ts";
import type { WorkspaceKnowledgeItem } from "@t3tools/contracts";
import { decideOrchestrationCommand, QUEUED_TURN_START_GRACE_MS } from "../decider.ts";
import { bootstrapCreateCommandId, normalizedTurnRequestDigest } from "../turnRequestDigest.ts";
import { planWorkspaceWikiEvents } from "../workspaceWikiRename.ts";
import { prepareKnowledgeDocumentWrite } from "../knowledgeDocuments.ts";
import { makeBootstrapWorktreeJournal } from "../bootstrapWorktreeJournal.ts";
import { makeRecoveryDeliveryJournal } from "../recoveryDeliveryJournal.ts";
import { EXAONE_QUESTION_ALREADY_SETTLED } from "../exaoneTextQuestions.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { ServerConfig } from "../../config.ts";
import {
  upgradeProjectCommandId,
  upgradeRoomAllowsCommand,
  upgradeRoomIds,
  validUpgradeState,
} from "../../upgradeRoom.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

// Bind retryable busy receipts to the server-computed workflow request digest.
// This allows the exact same request to be retried without permitting a
// different payload to reuse its command id.
function retryDigestForCommand(command: OrchestrationCommand): string | null {
  if (command.type === "project.knowledge.item.upsert" && command.documentWrite) {
    const { createdAt: _receiptTime, ...stable } = command;
    return createHash("sha256").update(stableStringify(stable)).digest("hex");
  }
  if (command.type === "thread.background-recovery.start" || isKnowledgeManagementCommand(command))
    return createHash("sha256").update(stableStringify(command)).digest("hex");
  if (command.type === "thread.turn.start") return normalizedTurnRequestDigest(command);
  if (
    command.type !== "project.collaboration.run.request" &&
    command.type !== "project.workflow.run.request"
  )
    return null;
  const digest = command.workflow?.requestDigest ?? command.runContext?.requestDigest;
  return typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest) ? digest : null;
}
const decodePriorTurn = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      modelSelection: Schema.optionalKey(ModelSelection),
      runtimeMode: Schema.optionalKey(RuntimeMode),
      interactionMode: Schema.optionalKey(ProviderInteractionMode),
    }),
  ),
);
const RETRYABLE_RECEIPT_PREFIX = "t3-retryable-v1:";

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number; replayed?: true }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.workspace-control.update":
    case "project.runtime.view":
    case "project.knowledge.item.upsert":
    case "project.knowledge.bulk":
    case "project.knowledge.search.save":
    case "project.knowledge.search.remove":
    case "project.knowledge.item.archive":
    case "project.knowledge.usage.record":
    case "project.agent-role.upsert":
    case "project.agent-role.remove":
    case "project.workflow.save":
    case "project.workflow.run.request":
    case "project.workflow.delivery":
    case "project.collaboration.run.control":
    case "project.collaboration.run.request":
    case "project.collaboration.run.cancel":
    case "project.collaboration.run.answer":
    case "project.collaboration.run.review":
    case "project.collaboration.run.verify":
    case "project.collaboration.run.interject":
    case "project.collaboration.run.schedule":
    case "project.schedule.upsert":
    case "project.schedule.remove":
    case "project.schedule.runtime.update":
    case "project.program.upsert":
    case "project.program.remove":
    case "project.program.start":
    case "project.program.stop":
    case "project.program.restart":
    case "project.program.integrity.start":
    case "project.program.integrity.stop":
    case "project.program.incident.repair.request":
    case "project.program.incident.resolve":
    case "project.collaboration.run.incident":
    case "project.monitoring.plan.approve":
    case "project.monitoring.reanalyze":
    case "project.monitoring.plan.propose":
    case "project.monitoring.runtime.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    case "project.collaboration.run.update":
      return {
        aggregateKind: "project",
        aggregateId: command.run.projectId,
      };
    case "project.program.run.update":
    case "project.program.integrity.update":
      return {
        aggregateKind: "project",
        aggregateId:
          command.type === "project.program.run.update" ? command.run.projectId : command.projectId,
      };
    case "project.program.incident.upsert":
      return {
        aggregateKind: "project",
        aggregateId: command.incident.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const config = yield* Effect.serviceOption(ServerConfig);
  const upgrade = Option.getOrUndefined(config)?.upgradeRoom;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const requireUnusedCreation = Effect.fn("OrchestrationEngine.requireUnusedCreation")(function* (
    commandType: OrchestrationCommand["type"],
    threadId: ThreadId,
    owner: string | undefined,
    projectId?: ProjectId,
  ) {
    // Use the immutable stream, including submissions whose projections have since been reverted.
    const [latest] = yield* sql<{
      event_type: string;
      command_id: string | null;
      sequence: number;
      project_id: string | null;
    }>`
      SELECT event_type, command_id, sequence, json_extract(payload_json,'$.projectId') AS project_id
      FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=${threadId}
        AND event_type IN ('thread.created','thread.deleted','thread.turn-start-requested')
      ORDER BY sequence DESC LIMIT 1`.pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationEngine.unusedBootstrapCreation")),
    );
    if (latest?.event_type === "thread.turn-start-requested")
      return yield* new OrchestrationCommandInvariantError({
        commandType,
        detail: "이미 첫 턴이 접수된 대화입니다. 초기 팀 설정이나 생성 취소를 적용할 수 없습니다.",
      });
    if (
      !owner ||
      latest?.event_type !== "thread.created" ||
      latest.command_id !== owner ||
      (projectId !== undefined && latest.project_id !== projectId)
    )
      return yield* new OrchestrationCommandInvariantError({
        commandType,
        detail: "이 요청이 만든 대화인지 확인할 수 없습니다. 대화와 대기 작업을 확인하세요.",
      });
    const [prior] = yield* sql`SELECT 1 FROM orchestration_events
      WHERE aggregate_kind='project' AND stream_id=${latest.project_id} AND sequence>${latest.sequence}
        AND event_type='project.collaboration-run-requested'
        AND ${threadId} IN (json_extract(payload_json,'$.run.workflow.threadId'),
          json_extract(payload_json,'$.run.runContext.threadId'),json_extract(payload_json,'$.run.meeting.threadId'))
      LIMIT 1`.pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationEngine.priorRoomWorkflow")),
    );
    if (prior)
      return yield* new OrchestrationCommandInvariantError({
        commandType,
        detail: "이미 통합 작업이 접수된 대화에는 초기 팀 설정이나 생성 취소를 적용할 수 없습니다.",
      });
  });
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence, Number.MAX_SAFE_INTEGER),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        if (upgrade) {
          const c = envelope.command;
          const bootstrap =
            c.type === "project.create" &&
            c.commandId === upgradeProjectCommandId &&
            c.projectId === upgradeRoomIds.projectId &&
            c.workspaceRoot === upgrade.projectRoot;
          if (!bootstrap && !upgradeRoomAllowsCommand(c, true))
            return yield* new OrchestrationCommandInvariantError({
              commandType: c.type,
              detail: "전용 방의 범위를 벗어난 명령입니다.",
            });
        }
        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            const fingerprint = existingReceipt.value.requestFingerprint;
            const management = isKnowledgeManagementCommand(envelope.command);
            if (
              (fingerprint || management) &&
              retryDigestForCommand(envelope.command) !== fingerprint
            ) {
              return yield* new OrchestrationCommandPreviouslyRejectedError({
                commandId: envelope.command.commandId,
                detail: "같은 요청 ID에 다른 내용을 사용할 수 없습니다. 새 요청으로 보내세요.",
                ...(management ? {} : { reason: "turn-request-id-conflict" as const }),
              });
            }
            return {
              sequence: existingReceipt.value.resultSequence,
              replayed: true as const,
            };
          }
          const retryable = /^t3-retryable-v1:([a-f0-9]{64}):([\s\S]*)$/u.exec(
            existingReceipt.value.error ?? "",
          );
          if (!retryable || retryDigestForCommand(envelope.command) !== retryable[1]) {
            return yield* new OrchestrationCommandPreviouslyRejectedError({
              commandId: envelope.command.commandId,
              detail:
                retryable && envelope.command.type === "thread.turn.start"
                  ? "같은 요청 ID에 다른 내용을 사용할 수 없습니다. 새 요청으로 보내세요."
                  : (retryable?.[2] ?? existingReceipt.value.error ?? "Previously rejected."),
              ...(retryable && envelope.command.type === "thread.turn.start"
                ? { reason: "turn-request-id-conflict" as const }
                : {}),
            });
          }
        }

        // A user turn must never replace the supervisor/participant turn of
        // a live collaboration in this same conversation. Client run lists
        // can be stale or still loading; this check shares the serialized
        // command queue with collaboration run projections.
        const command = envelope.command;
        if (upgrade && command.type === "thread.turn.start") {
          const selected = commandReadModel.threads.find(
            (t) => t.id === command.threadId,
          )?.modelSelection;
          if (
            !selected ||
            selected.instanceId !== command.modelSelection?.instanceId ||
            selected.model !== command.modelSelection.model
          )
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "이 방에 저장한 계정과 모델로만 요청할 수 있습니다.",
            });
        }
        // Validate the durable message in the same serialized queue as reverts/deletes.
        // The in-memory command model is capped and cannot prove an old attachment exists.
        if (
          command.type === "project.knowledge.item.upsert" &&
          command.tags.includes("pdf-page-batch")
        ) {
          const source = command.research?.attachment;
          if (!source)
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "PDF 색인의 원본 첨부 정보가 없습니다.",
            });
          const [row] = yield* sql<{ present: number }>`
            SELECT 1 AS present FROM projection_thread_messages AS m
            JOIN projection_threads AS t ON t.thread_id = m.thread_id
            WHERE m.thread_id = ${source.threadId} AND m.message_id = ${source.messageId}
              AND t.project_id = ${command.projectId} AND t.deleted_at IS NULL
              AND json_valid(m.attachments_json)
              AND EXISTS (SELECT 1 FROM json_each(m.attachments_json) AS a
                WHERE json_extract(a.value, '$.type') = 'file'
                  AND json_extract(a.value, '$.id') = ${source.attachmentId})
            LIMIT 1
          `.pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEngine.pdfAttachmentSource")));
          if (!row)
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "PDF 원본 메시지나 첨부가 더 이상 존재하지 않습니다.",
            });
        }
        if (
          command.type === "project.collaboration.run.interject" ||
          command.type === "project.collaboration.run.answer"
        ) {
          const [target] = yield* sql<{
            status: string;
            thread_id: string | null;
            phase: string | null;
            question: string | null;
            question_node: string | null;
            question_at: string | null;
          }>`
            SELECT status,
              CASE WHEN json_valid(meeting_json) THEN json_extract(meeting_json, '$.threadId') END AS thread_id,
              CASE WHEN json_valid(meeting_json) THEN json_extract(meeting_json, '$.phase') END AS phase,
              CASE WHEN json_valid(meeting_json) THEN json_extract(meeting_json, '$.pendingQuestion.question') END AS question,
              CASE WHEN json_valid(meeting_json) THEN json_extract(meeting_json, '$.pendingQuestion.nodeId') END AS question_node,
              CASE WHEN json_valid(meeting_json) THEN json_extract(meeting_json, '$.pendingQuestion.askedAt') END AS question_at
            FROM projection_workspace_collaboration_runs
            WHERE project_id = ${command.projectId} AND run_id = ${command.runId} LIMIT 1
          `.pipe(
            Effect.mapError(toPersistenceSqlError("OrchestrationEngine.conversationRunInput")),
          );
          if (
            !target?.thread_id ||
            !["queued", "running"].includes(target.status) ||
            !target.phase ||
            target.phase === "done"
          )
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "추가 지시를 받을 진행 중인 통합 작업이 없습니다. 작성 내용을 확인하세요.",
            });
          if (
            command.type === "project.collaboration.run.answer" &&
            (target.question !== command.question ||
              target.question_node !== command.questionRef.nodeId ||
              target.question_at !== command.questionRef.askedAt)
          )
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "질문이 변경됐습니다. 작성 내용을 보존하고 최신 질문을 확인하세요.",
            });
        }
        const expectedCreation =
          command.type === "thread.turn.start" || command.type === "thread.meta.update"
            ? command.bootstrapCreateClaim
            : command.type === "thread.delete"
              ? command.expectedCreationCommandId
              : undefined;
        const needsUnusedCreation =
          (command.type === "thread.delete" && expectedCreation !== undefined) ||
          (command.type === "thread.turn.start" &&
            Boolean(
              command.customSubordinateTeam !== undefined ||
              command.initialModelTeams?.length ||
              command.initialResponseStyle,
            ));
        if (
          !needsUnusedCreation &&
          expectedCreation !== undefined &&
          (command.type === "thread.turn.start" ||
            command.type === "thread.meta.update" ||
            command.type === "thread.delete")
        ) {
          const [latest] = yield* sql<{ event_type: string; command_id: string | null }>`
            SELECT event_type, command_id FROM orchestration_events
            WHERE aggregate_kind='thread' AND stream_id=${command.threadId}
              AND event_type IN ('thread.created', 'thread.deleted')
            ORDER BY sequence DESC LIMIT 1
          `.pipe(
            Effect.mapError(toPersistenceSqlError("OrchestrationEngine.bootstrapCreationClaim")),
          );
          if (latest?.event_type !== "thread.created" || latest.command_id !== expectedCreation) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "이 요청이 만든 대화인지 확인할 수 없습니다. 대화와 대기 작업을 확인하세요.",
            });
          }
        }
        if (command.type === "thread.turn.start" || command.type === "thread.meta.update") {
          const thread = commandReadModel.threads.find(
            (candidate) => candidate.id === command.threadId,
          );
          if (
            (command.bootstrapExpectedBranch !== undefined &&
              thread?.branch !== command.bootstrapExpectedBranch) ||
            (command.bootstrapExpectedWorktreePath !== undefined &&
              thread?.worktreePath !== command.bootstrapExpectedWorktreePath)
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "대화의 브랜치 또는 작업 경로가 변경되어 자동으로 이어갈 수 없습니다.",
            });
          }
        }
        if (
          command.type === "thread.turn.start" &&
          (command.inputOrigin === undefined || command.inputOrigin === "user")
        ) {
          const thread = commandReadModel.threads.find(
            (candidate) => candidate.id === command.threadId,
          );
          if (thread) {
            const activeRuns = yield* sql<{ run_id: string }>`
              SELECT run_id FROM projection_workspace_collaboration_runs
              WHERE project_id = ${thread.projectId}
                AND status IN ('queued', 'running', 'cancel-requested')
                AND CASE WHEN json_valid(meeting_json)
                  THEN json_extract(meeting_json, '$.threadId') END = ${command.threadId}
              LIMIT 1
            `.pipe(
              Effect.mapError(toPersistenceSqlError("OrchestrationEngine.activeConversationRun")),
            );
            if (activeRuns.length > 0) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "이 대화에서 통합 작업이 진행 중입니다. 감독 AI에게 추가 지시를 보내세요.",
              });
            }
          }
        }

        if (command.type === "thread.turn.start") {
          const thread = commandReadModel.threads.find(
            (candidate) => candidate.id === command.threadId,
          );
          if (thread) {
            const [pending] = yield* sql<{ requested_at: string }>`SELECT requested_at
              FROM projection_turns WHERE thread_id=${command.threadId}
                AND turn_id IS NULL AND state='pending' AND pending_message_id IS NOT NULL
              ORDER BY rowid DESC LIMIT 1`.pipe(
              Effect.mapError(toPersistenceSqlError("OrchestrationEngine.pendingConversationTurn")),
            );
            const status = thread.session?.status;
            const pendingAge = pending
              ? Math.abs((yield* Clock.currentTimeMillis) - Date.parse(pending.requested_at))
              : Infinity;
            const active =
              status === "running" ||
              status === "starting" ||
              (status !== "error" &&
                status !== "stopped" &&
                status !== "interrupted" &&
                pendingAge <= QUEUED_TURN_START_GRACE_MS);
            if (active) {
              const [previous] = yield* sql<{ payload_json: string }>`SELECT payload_json
                FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=${command.threadId}
                  AND event_type='thread.turn-start-requested' ORDER BY sequence DESC LIMIT 1`.pipe(
                Effect.mapError(
                  toPersistenceSqlError("OrchestrationEngine.activeConversationTurn"),
                ),
              );
              const decoded = previous ? decodePriorTurn(previous.payload_json) : Option.none();
              const prior = Option.isSome(decoded) ? decoded.value : undefined;
              const desiredModel = command.modelSelection ?? thread.modelSelection;
              const desiredRuntime =
                command.taskConditions?.mode === "inspect"
                  ? "approval-required"
                  : (command.runtimeMode ?? thread.runtimeMode);
              const desiredInteraction =
                command.taskConditions?.mode === "inspect"
                  ? "plan"
                  : (command.interactionMode ?? thread.interactionMode);
              const changed =
                !prior?.modelSelection ||
                stableStringify(prior.modelSelection) !== stableStringify(desiredModel) ||
                (thread.session?.providerInstanceId !== undefined &&
                  thread.session.providerInstanceId !== desiredModel.instanceId) ||
                (prior.runtimeMode !== undefined && prior.runtimeMode !== desiredRuntime) ||
                (prior.interactionMode !== undefined &&
                  prior.interactionMode !== desiredInteraction);
              if (changed)
                return yield* new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail:
                    "현재 작업이 진행 중입니다. 현재 작업이 끝나면 선택한 AI와 설정으로 다시 보내세요.",
                  retryable: true,
                  reason: "active-turn-settings",
                });
            }
          }
        }

        let decisionReadModel = commandReadModel;
        const meetingTargetId =
          command.type === "project.collaboration.run.request" ||
          command.type === "project.workflow.run.request"
            ? (command.meeting?.threadId ??
              (command.executionProfile
                ? (command.workflow?.threadId ?? command.runContext?.threadId)
                : undefined))
            : undefined;
        if (
          (command.type === "project.collaboration.run.request" ||
            command.type === "project.workflow.run.request") &&
          meetingTargetId
        ) {
          const targetId = meetingTargetId;
          // Queued runs count as active too: the database uniqueness index
          // protects running states but deliberately permits multiple queues.
          const [activeRun] = yield* sql<{ run_id: string }>`
            SELECT run_id FROM projection_workspace_collaboration_runs
            WHERE project_id = ${command.projectId}
              AND status IN ('queued', 'running', 'cancel-requested')
              AND CASE WHEN json_valid(meeting_json)
                THEN json_extract(meeting_json, '$.threadId') END = ${targetId}
            LIMIT 1
          `.pipe(
            Effect.mapError(
              toPersistenceSqlError("OrchestrationEngine.activeConversationRunStart"),
            ),
          );
          if (activeRun) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "이 대화에서 통합 작업이 진행 중입니다. 종료 후 새 작업을 시작하세요.",
              retryable: true,
            });
          }
          // The lightweight command model intentionally omits historical
          // messages and activities after bootstrap/reconciliation. Load only
          // blocking activities and the most recent actual user turn request;
          // a recorded workflow request is not itself a provider turn.
          const persisted = yield* projectionSnapshotQuery.getThreadRuntimeContext(targetId, {
            activityKinds: [
              "approval.requested",
              "approval.resolved",
              "user-input.requested",
              "user-input.resolved",
              "provider.approval.respond.failed",
              "provider.user-input.respond.failed",
            ],
          });
          const [latestUserTurn] = yield* sql<{ message_id: string; created_at: string }>`
            SELECT m.message_id, m.created_at FROM orchestration_events e
            JOIN projection_thread_messages m
              ON m.thread_id = e.stream_id AND m.message_id = json_extract(e.payload_json, '$.messageId')
            WHERE e.aggregate_kind = 'thread' AND e.stream_id = ${targetId}
              AND e.event_type = 'thread.turn-start-requested' AND m.role = 'user'
              AND COALESCE(json_extract(e.payload_json, '$.inputOrigin'), 'user') = 'user'
            ORDER BY e.sequence DESC LIMIT 1
          `.pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEngine.latestUserTurn")));
          if (Option.isSome(persisted)) {
            const messages = latestUserTurn
              ? [
                  {
                    id: MessageId.make(latestUserTurn.message_id),
                    role: "user" as const,
                    text: "",
                    turnId: null,
                    streaming: false,
                    createdAt: latestUserTurn.created_at,
                    updatedAt: latestUserTurn.created_at,
                  },
                ]
              : [];
            decisionReadModel = {
              ...commandReadModel,
              threads: commandReadModel.threads.map((thread) =>
                thread.id === targetId ? { ...persisted.value, messages } : thread,
              ),
            };
          }
        }
        const decide = (
          selectedKnowledge: readonly WorkspaceKnowledgeItem[] = [],
          effective: OrchestrationCommand = command,
        ) =>
          decideOrchestrationCommand({
            selectedKnowledge,
            command: effective,
            readModel: decisionReadModel,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError((cause) =>
              isOrchestrationCommandInvariantError(cause)
                ? cause
                : new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Failed to generate an event identifier.",
                    cause,
                  }),
            ),
          );
        const documentWrite =
          command.type === "project.knowledge.item.upsert" && command.documentWrite;
        const decided =
          command.type === "project.pdf-revision.publish" ||
          isKnowledgeManagementCommand(command) ||
          documentWrite ||
          needsUnusedCreation
            ? null
            : yield* decide();
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const eventBase = yield* Effect.gen(function* () {
                if (
                  needsUnusedCreation &&
                  (command.type === "thread.turn.start" || command.type === "thread.delete")
                ) {
                  yield* requireUnusedCreation(command.type, command.threadId, expectedCreation);
                  if (command.type === "thread.turn.start") {
                    if (
                      expectedCreation?.startsWith("bootstrap-create:") &&
                      (!command.requestFingerprint ||
                        bootstrapCreateCommandId(command) !== expectedCreation)
                    )
                      return yield* new OrchestrationCommandInvariantError({
                        commandType: command.type,
                        detail: "다른 요청이 만든 대화에 초기 팀을 지정할 수 없습니다.",
                      });
                    if (
                      command.initialModelTeams?.some((team) => team.threadId !== command.threadId)
                    )
                      return yield* new OrchestrationCommandInvariantError({
                        commandType: command.type,
                        detail: "초기 팀의 대화 ID가 요청과 다릅니다.",
                      });
                  }
                  return yield* decide();
                }
                if (command.type === "project.pdf-revision.publish") {
                  const writes = yield* commitPdfRevision(sql, command).pipe(
                    Effect.mapError((cause) => toPersistenceSqlError("pdfRevision.publish")(cause)),
                  );
                  const groups = yield* Effect.forEach(writes, (write) => decide([], write));
                  return groups.flatMap((group) => (Array.isArray(group) ? group : [group]));
                }
                if (command.type === "project.knowledge.item.upsert" && command.documentWrite) {
                  const list = projectionSnapshotQuery.listWorkspaceKnowledge;
                  if (!list)
                    return yield* new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: "The knowledge projection is unavailable.",
                    });
                  const effective = yield* prepareKnowledgeDocumentWrite(sql, list, command).pipe(
                    Effect.mapError((cause) =>
                      isOrchestrationCommandInvariantError(cause)
                        ? cause
                        : toPersistenceSqlError("knowledgeDocument.edit")(cause),
                    ),
                  );
                  return yield* decide([], effective);
                }
                if (isKnowledgeManagementCommand(command)) {
                  return yield* decide(yield* checkKnowledgeSelection(sql, command));
                }
                return decided!;
              });
              const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
              const committedEvents: OrchestrationEvent[] = [];
              let nextCommandReadModel = commandReadModel;

              if (
                command.type === "thread.activity.append" &&
                command.activity.kind === "user-input.resolved"
              ) {
                const payload = command.activity.payload as {
                  requestId?: unknown;
                  reason?: unknown;
                } | null;
                if (
                  payload?.reason === "superseded" &&
                  typeof payload.requestId === "string" &&
                  payload.requestId.startsWith("text-question:")
                ) {
                  const requestId = payload.requestId;
                  const [response] = yield* sql<{ found: number }>`
                    SELECT 1 AS found FROM orchestration_events
                    WHERE aggregate_kind = 'thread' AND stream_id = ${command.threadId}
                      AND event_type = 'thread.user-input-response-requested'
                      AND json_extract(payload_json, '$.requestId') = ${requestId}
                    LIMIT 1
                  `;
                  const [settled] = yield* sql<{ found: number }>`
                    SELECT 1 AS found FROM projection_thread_activities
                    WHERE thread_id = ${command.threadId}
                      AND kind IN ('user-input.resolved', 'provider.user-input.recovery.queued',
                                   'provider.user-input.delivery.started')
                      AND json_extract(payload_json, '$.requestId') = ${requestId}
                      AND (kind <> 'user-input.resolved' OR
                           COALESCE(json_extract(payload_json, '$.reason'), '') <> 'superseded')
                    LIMIT 1
                  `;
                  if (response || settled) {
                    return yield* new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: EXAONE_QUESTION_ALREADY_SETTLED,
                    });
                  }
                }
              }

              for (const base of eventBases) {
                const events =
                  base.type === "project.knowledge-item-upserted"
                    ? yield* planWorkspaceWikiEvents(
                        sql,
                        projectionSnapshotQuery.listWorkspaceKnowledge,
                        base,
                        command.type === "project.knowledge.item.upsert" &&
                          command.documentWrite?.mode === "edit" &&
                          command.documentWrite.edit.wikiLinksCanonicalized === true,
                      )
                    : [base];
                for (const nextEvent of events) {
                  const revision =
                    nextEvent.type === "project.knowledge-item-upserted"
                      ? yield* retainKnowledgeSuccessor(sql, nextEvent)
                      : nextEvent;
                  let seedThreadId: ThreadId | undefined;
                  if (revision.type === "project.collaboration-run-requested") {
                    const run: WorkspaceCollaborationRun = revision.payload.run;
                    const context = run.workflow ?? run.runContext;
                    if (
                      context?.customSubordinateTeam !== undefined ||
                      context?.initialModelTeams?.length ||
                      context?.initialResponseStyle ||
                      run.runContext?.customSubordinateTeam !== undefined ||
                      run.runContext?.initialModelTeams?.length ||
                      run.runContext?.initialResponseStyle
                    ) {
                      const room = context?.threadId;
                      const teams = context?.initialModelTeams ?? [];
                      if (
                        command.type !== "project.collaboration.run.request" ||
                        !room ||
                        (!teams.length &&
                          context?.customSubordinateTeam === undefined &&
                          !context?.initialResponseStyle) ||
                        (run.workflow && run.runContext) ||
                        (run.meeting?.threadId && run.meeting.threadId !== room) ||
                        run.source !== "user" ||
                        command.commandId !== `workflow-start:${run.id}` ||
                        teams.some((team) => team.threadId !== room) ||
                        new Set(
                          teams.map((team) =>
                            stableStringify([
                              team.answeringInstanceId,
                              team.forModel.trim().toLowerCase(),
                            ]),
                          ),
                        ).size !== teams.length
                      )
                        return yield* new OrchestrationCommandInvariantError({
                          commandType: command.type,
                          detail: "접수할 워크플로의 요청과 초기 팀 범위가 일치하지 않습니다.",
                        });
                      yield* requireUnusedCreation(
                        command.type,
                        room,
                        `workflow-bootstrap-create:${run.id}`,
                        run.projectId,
                      );
                      seedThreadId = room;
                    }
                  }
                  const savedEvent = yield* eventStore.append(revision);
                  if (
                    savedEvent.type === "thread.turn-start-requested" &&
                    (savedEvent.payload.customSubordinateTeam !== undefined ||
                      savedEvent.payload.initialModelTeams?.length ||
                      savedEvent.payload.initialResponseStyle)
                  ) {
                    if (
                      command.type !== "thread.turn.start" ||
                      !needsUnusedCreation ||
                      command.threadId !== savedEvent.payload.threadId
                    )
                      return yield* new OrchestrationCommandInvariantError({
                        commandType: command.type,
                        detail: "초기 팀은 대화를 생성한 첫 턴 요청에서만 지정할 수 있습니다.",
                      });
                    seedThreadId = savedEvent.payload.threadId;
                  }
                  if (seedThreadId) {
                    yield* sql`INSERT INTO pending_thread_model_team_seeds (thread_id, event_sequence)
                      VALUES (${seedThreadId}, ${savedEvent.sequence})`.pipe(
                      Effect.mapError(
                        toPersistenceSqlError("OrchestrationEngine.enqueueThreadModelTeamSeed"),
                      ),
                    );
                  } else if (savedEvent.type === "thread.deleted") {
                    yield* sql`DELETE FROM pending_thread_model_team_seeds WHERE thread_id = ${savedEvent.payload.threadId}`.pipe(
                      Effect.mapError(
                        toPersistenceSqlError("OrchestrationEngine.discardThreadModelTeamSeed"),
                      ),
                    );
                  }
                  nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                  yield* projectionPipeline.projectEvent(savedEvent);
                  committedEvents.push(savedEvent);
                }
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              if (envelope.command.type === "thread.background-recovery.start") {
                const turnEvent = committedEvents.find(
                  (event) => event.type === "thread.turn-start-requested",
                );
                if (!turnEvent || turnEvent.type !== "thread.turn-start-requested") {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "복구 턴의 전달 요청을 저장하지 못했습니다.",
                  });
                }
                yield* makeRecoveryDeliveryJournal(sql).enqueue(
                  {
                    eventId: turnEvent.eventId,
                    threadId: turnEvent.payload.threadId,
                    messageId: turnEvent.payload.messageId,
                    eventSequence: turnEvent.sequence,
                  },
                  turnEvent.occurredAt,
                );
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
                requestFingerprint:
                  documentWrite ||
                  envelope.command.type === "thread.turn.start" ||
                  envelope.command.type === "thread.background-recovery.start" ||
                  isKnowledgeManagementCommand(envelope.command)
                    ? retryDigestForCommand(envelope.command)
                    : null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandInvariantError(error)) {
              const retryDigest = error.retryable ? retryDigestForCommand(envelope.command) : null;
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: retryDigest
                    ? `${RETRYABLE_RECEIPT_PREFIX}${retryDigest}:${error.message}`
                    : error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          if (envelope.command.type === "project.program.stop" && Cause.hasInterrupts(exit.cause)) {
            yield* Deferred.failCause(envelope.result, exit.cause);
          } else {
            yield* Deferred.fail(envelope.result, error);
          }
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();
  if (upgrade && !validUpgradeState(commandReadModel, upgrade.projectRoot))
    return yield* Effect.die(
      new Error("The upgrade home contains unrelated project or thread state."),
    );

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<
        { sequence: number; replayed?: true },
        OrchestrationDispatchError
      >();
      yield* Queue.offer(commandQueue, {
        command,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  if (upgrade && commandReadModel.projects.length === 0) {
    yield* dispatch({
      type: "project.create",
      commandId: upgradeProjectCommandId,
      projectId: upgradeRoomIds.projectId,
      workspaceRoot: upgrade.projectRoot,
      title: "AutoUsage",
      defaultModelSelection: null,
      createdAt: yield* nowIso,
    }).pipe(Effect.orDie);
  }
  const session = upgrade && commandReadModel.threads[0]?.session;
  if (session && (session.status === "starting" || session.status === "running")) {
    const createdAt = yield* nowIso;
    yield* dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`upgrade:interrupted:${commandReadModel.snapshotSequence}`),
      threadId: upgradeRoomIds.threadId,
      session: { ...session, status: "interrupted", activeTurnId: null, updatedAt: createdAt },
      createdAt,
    }).pipe(Effect.orDie);
  }

  return {
    supportsOwnedBootstrapResume: true as const,
    bootstrapWorktreeJournal: makeBootstrapWorktreeJournal(sql),
    readEvents,
    dispatch,
    checkTurnReceipt: (input) =>
      commandReceiptRepository.getByCommandId({ commandId: input.commandId }).pipe(
        Effect.map((receipt) => {
          if (Option.isNone(receipt)) return { status: "unconfirmed" as const };
          const row = receipt.value;
          if (row.aggregateKind !== "thread" || row.aggregateId !== input.threadId)
            return { status: "mismatch" as const };
          if (row.status !== "accepted") return { status: "rejected" as const };
          if (!row.requestFingerprint) return { status: "unconfirmed" as const };
          return {
            status:
              row.requestFingerprint === input.requestFingerprint
                ? ("accepted" as const)
                : ("mismatch" as const),
          };
        }),
      ),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
