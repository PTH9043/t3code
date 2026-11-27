import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { verifyHostAuditChain } from "./HostApprovalGate.ts";
import {
  bindSpecExecutionRun,
  evaluateSpecCompletionGate,
  pinTaskSpec,
  recordSpecWaived,
  submitIndependentCheckerVerdict,
} from "./PinnedSpecGate.ts";

it.effect(
  "enforces hash-pinned spec integrity, blocks producer self-approval, requires independent checker approval, and logs waivers",
  () =>
    Effect.gen(function* () {
      const body = {
        specId: "spec-pr-101",
        category: "backend-security",
        description: "Implement digest-bound host approval gate",
        steps: ["Add schema", "Implement gate", "Run tests"],
        prerequisites: ["Migration 104 applied"],
        doneWhen: "All 3 security invariants pass isolated unit tests",
      };

      yield* pinTaskSpec({
        body,
        producerActorId: "agent-claude-producer",
        producerSessionId: "sess-prod-1",
        prerequisitesMet: false,
      });

      // Unmet prerequisites refused
      const unmet = yield* evaluateSpecCompletionGate({ specId: body.specId, observedBody: body });
      expect(unmet.outcome).toBe("refused_unmet_prereqs");

      // Bind execution and satisfy prerequisites
      yield* bindSpecExecutionRun({
        specId: body.specId,
        runId: "run-999",
        prerequisitesMet: true,
      });

      // Missing checker refused
      const missingChecker = yield* evaluateSpecCompletionGate({
        specId: body.specId,
        observedBody: body,
      });
      expect(missingChecker.outcome).toBe("refused_missing_checker");

      // Producer trying to self-approve (same actor OR same session) is blocked
      const selfByActor = yield* submitIndependentCheckerVerdict({
        specId: body.specId,
        observedBody: body,
        checkerActorId: "agent-claude-producer",
        checkerSessionId: "sess-other",
        decision: "approve",
        evidence: "Looks good to me",
      });
      expect(selfByActor.ok).toBe(false);
      if (!selfByActor.ok) expect(selfByActor.outcome).toBe("refused_self_approval");

      const selfBySession = yield* submitIndependentCheckerVerdict({
        specId: body.specId,
        observedBody: body,
        checkerActorId: "agent-codex-checker",
        checkerSessionId: "sess-prod-1",
        decision: "approve",
        evidence: "Same session bypass attempt",
      });
      expect(selfBySession.ok).toBe(false);
      if (!selfBySession.ok) expect(selfBySession.outcome).toBe("refused_self_approval");

      // Goalpost moving (tampering doneWhen after pinning) is detected
      const tampered = yield* evaluateSpecCompletionGate({
        specId: body.specId,
        observedBody: { ...body, doneWhen: "Only 1 test needs to pass" },
      });
      expect(tampered.outcome).toBe("refused_tampered");

      // Independent checker approval passes the triple gate
      const verdict = yield* submitIndependentCheckerVerdict({
        specId: body.specId,
        observedBody: body,
        checkerActorId: "agent-codex-checker",
        checkerSessionId: "sess-checker-isolated",
        decision: "approve",
        evidence: "Verified all 3 invariants in isolated run-999",
      });
      expect(verdict.ok).toBe(true);

      const passed = yield* evaluateSpecCompletionGate({ specId: body.specId, observedBody: body });
      expect(passed.outcome).toBe("pass");
      expect(passed.checkerActorId).toBe("agent-codex-checker");

      // Waiver is permanently recorded on the audit chain
      const waivedBody = { ...body, specId: "spec-waived-202" };
      yield* pinTaskSpec({ body: waivedBody, producerActorId: "agent-1" });
      yield* recordSpecWaived({
        specId: waivedBody.specId,
        actorId: "human-operator",
        reason: "Emergency hotfix",
      });
      const waivedOutcome = yield* evaluateSpecCompletionGate({
        specId: waivedBody.specId,
        observedBody: waivedBody,
      });
      expect(waivedOutcome.outcome).toBe("waived");

      const chain = yield* verifyHostAuditChain();
      expect(chain.valid).toBe(true);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
