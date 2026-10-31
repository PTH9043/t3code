import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  ProjectId,
  ThreadId,
  TurnId,
  WorkspaceAutomationCheck,
  WorkspaceCompletionAutomation,
} from "@t3tools/contracts";
export interface WorkspaceAutomationPlan {
  threadId: ThreadId;
  projectId: ProjectId;
  turnId: TurnId;
  cwd: string;
  config: WorkspaceCompletionAutomation;
  formatChecks: WorkspaceAutomationCheck[];
}
export class WorkspaceAutomationRunner extends Context.Service<
  WorkspaceAutomationRunner,
  {
    prepare: (input: {
      threadId: ThreadId;
      projectId: ProjectId;
      turnId: TurnId;
      cwd: string;
    }) => Effect.Effect<WorkspaceAutomationPlan | null>;
    enqueue: (plan: WorkspaceAutomationPlan) => Effect.Effect<void>;
    drain: Effect.Effect<void>;
  }
>()("t3/orchestration/Services/WorkspaceAutomationRunner") {}
