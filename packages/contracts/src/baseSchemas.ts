import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Wire codec for server→client arrays whose element unions grow over time
 * (new literal members, new struct variants). Decoding drops elements the
 * current build cannot decode instead of failing the whole payload — a client
 * has to keep decoding configs sent by servers newer than itself, and
 * rejecting the payload would take down the connection over data the client
 * couldn't act on anyway. Encoding is the plain array encoding.
 */
export const ForwardCompatibleArray = <Element extends Schema.Top>(element: Element) => {
  const decodeElement = Schema.decodeUnknownOption(element as never);
  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.Array(element),
      SchemaTransformation.transform<ReadonlyArray<Element["Encoded"]>, ReadonlyArray<unknown>>({
        decode: (values) =>
          values.filter((value) => Option.isSome(decodeElement(value))) as ReadonlyArray<
            Element["Encoded"]
          >,
        encode: (values) => values,
      }),
    ),
  );
};

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings
 */
const makeEntityId = <Brand extends string>(brand: Brand) => {
  return TrimmedNonEmptyString.pipe(Schema.brand(brand));
};

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const WorkspaceKnowledgeItemId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
).pipe(Schema.brand("WorkspaceKnowledgeItemId"));
export type WorkspaceKnowledgeItemId = typeof WorkspaceKnowledgeItemId.Type;
export const WorkspaceCollaborationRunId = makeEntityId("WorkspaceCollaborationRunId");
export type WorkspaceCollaborationRunId = typeof WorkspaceCollaborationRunId.Type;
export const WorkspaceTaskNodeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
).pipe(Schema.brand("WorkspaceTaskNodeId"));
export type WorkspaceTaskNodeId = typeof WorkspaceTaskNodeId.Type;
/**
 * A seat at a meeting, not a provider. Two participants can share one provider
 * instance (the same account brought in twice under different remits), so the
 * roster — never the instance id — is what a task node is assigned to.
 */
export const WorkspaceMeetingParticipantId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
).pipe(Schema.brand("WorkspaceMeetingParticipantId"));
export type WorkspaceMeetingParticipantId = typeof WorkspaceMeetingParticipantId.Type;
export const WorkspaceScheduleId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
).pipe(Schema.brand("WorkspaceScheduleId"));
export type WorkspaceScheduleId = typeof WorkspaceScheduleId.Type;
export const WorkspaceProgramId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
).pipe(Schema.brand("WorkspaceProgramId"));
export type WorkspaceProgramId = typeof WorkspaceProgramId.Type;
export const WorkspaceProgramRunId = makeEntityId("WorkspaceProgramRunId");
export type WorkspaceProgramRunId = typeof WorkspaceProgramRunId.Type;
export const WorkspaceIncidentId = makeEntityId("WorkspaceIncidentId");
export type WorkspaceIncidentId = typeof WorkspaceIncidentId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;
export const AuthSessionId = makeEntityId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;
export const RpcClientId = NonNegativeInt.pipe(Schema.brand("RpcClientId"));
export type RpcClientId = typeof RpcClientId.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;
